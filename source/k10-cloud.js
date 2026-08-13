/* K10 cloud storage — Supabase persistence for the standalone document.
   Exposes window.K10Cloud. Falls back silently when offline or signed out. */
(function () {
  var URL_ = "https://bbshqvlrfcivhddkwgib.supabase.co";
  var SPEC_KEY = "k10.specId";
  var KEY_STORE = "k10.key";
  var GATE = URL_ + "/functions/v1/k10-key";

  // The database key is not in this file. It is issued by the k10-key function
  // once the passcode checks out, then kept on this machine.
  function storedKey() { try { return localStorage.getItem(KEY_STORE) || null; } catch (e) { return null; } }
  function keepKey(k) { try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch (e) {} }

  function gate(action, body) {
    return fetch(GATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ action: action }, body || {})),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || "Request failed");
        return j;
      });
    });
  }

  var sb = null, ready = null, inflight = null;

  function client() {
    if (sb) return Promise.resolve(sb);
    var KEY = storedKey();
    if (!KEY) return Promise.reject(new Error("locked"));
    if (!ready) {
      ready = new Promise(function (res, rej) {
        if (window.supabase && window.supabase.createClient) return res();
        var s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      }).then(function () {
        sb = window.supabase.createClient(URL_, KEY);
        return sb;
      });
    }
    return ready.then(function () { return sb; });
  }

  function specId() { try { return localStorage.getItem(SPEC_KEY) || null; } catch (e) { return null; } }
  function setSpecId(id) { try { id ? localStorage.setItem(SPEC_KEY, id) : localStorage.removeItem(SPEC_KEY); } catch (e) {} }

  var API = {
    available: true,
    specId: specId,
    setSpecId: setSpecId,
    locked: function () { return !storedKey(); },
    forget: function () { keepKey(null); sb = null; ready = null; },

    // Is a passcode configured yet? (false on a brand-new install)
    status: function () { return gate("status"); },

    unlock: function (pass) {
      return gate("unlock", { pass: pass }).then(function (j) { keepKey(j.key); return true; });
    },

    // First run sets the passcode; later calls change it (old passcode required).
    setPass: function (pass, next) {
      return gate("set", { pass: pass, next: next }).then(function (j) { keepKey(j.key); return true; });
    },

    // All K10s belonging to the signed-in user, newest first.
    list: function () {
      return client().then(function (c) {
        return c.from("k10_specs").select("id,name,project_number,updated_at").order("updated_at", { ascending: false });
      }).then(function (r) { return r.error ? [] : (r.data || []); });
    },

    load: function (id) {
      id = id || specId();
      if (!id) return Promise.resolve(null);
      return client().then(function (c) {
        return c.from("k10_specs").select("*").eq("id", id).maybeSingle();
      }).then(function (r) { return r.error ? null : r.data; });
    },

    // Creates the row on first save, then patches it in place.
    // allowInsert travels WITH the request: whether this payload is allowed to
    // create a record must hold at the moment of the insert, not just when the
    // caller checked. Recovery from a dead id re-uses the same flag.
    save: function (patch, allowInsert) {
      // One insert only: concurrent first-run saves wait for the row to exist
      // rather than each minting their own.
      if (!specId() && inflight) return inflight.then(function () { return API.save(patch, allowInsert); });
      return client().then(function (c) {
        var id = specId();
        if (id) {
          return c.from("k10_specs").update(patch).eq("id", id).select("id").maybeSingle()
            .then(function (r) {
              if (r.error) throw new Error(r.error.message);
              // Updating a row that no longer exists is not an error in
              // Postgres — it silently matches nothing. Treat the id as dead
              // and re-create, so the work isn't lost.
              if (!r.data) { setSpecId(null); return API.save(patch, allowInsert); }
              return r.data;
            });
        }
        if (!allowInsert) return null;
        inflight = c.from("k10_specs").insert(patch).select("id").maybeSingle()
          .then(function (r) {
            inflight = null;
            if (r.error) throw new Error(r.error.message);
            if (r.data) setSpecId(r.data.id);
            return r.data;
          }, function (e) { inflight = null; throw e; });
        return inflight;
      });
    },

    remove: function (id) {
      return client().then(function (c) { return c.from("k10_specs").delete().eq("id", id); });
    },

    // The manufacturer catalogue lives in Postgres. Fetched in pages:
    // Supabase caps any single select at 1000 rows, which silently dropped
    // 65 systems once the catalogue grew past it.
    catalog: function () {
      return client().then(function (c) {
        var out = [];
        var PAGE = 1000;
        var fetchPage = function (from) {
          return c.from("k10_systems").select("record").order("family").order("id")
            .range(from, from + PAGE - 1).then(function (r) {
              if (r.error) throw new Error(r.error.message);
              (r.data || []).forEach(function (row) { out.push(row.record); });
              return (r.data || []).length === PAGE ? fetchPage(from + PAGE) : out;
            });
        };
        return fetchPage(0);
      });
    },

    // Collated systems are shared across every K10 this user writes.
    library: function () {
      return client().then(function (c) {
        // Insertion order, not alphabetical — the list should read as the
        // office's history of additions.
        return c.from("k10_library").select("*").order("created_at");
      }).then(function (r) { return r.error ? [] : (r.data || []); });
    },

    saveLibrary: function (entries) {
      return Promise.resolve().then(function () {
        if (!entries || !entries.length) return { skipped: true };
        var rows = entries.map(function (e) {
          return {
            system_code: e.sysRef || e.ref || e.id,
            family: e.family || null,
            schedule_type: e.scheduleType || e.systemType || null,
            detail: e,
            source_project: e.sourceProject || null
          };
        }).filter(function (r) { return r.system_code; });
        return client().then(function (c) {
          return c.from("k10_library").upsert(rows, { onConflict: "system_code" });
        });
      });
    }
  };

  window.K10Cloud = API;

  // ── Image slots on the hosted app ──────────────────────────────────────────
  // <image-slot> persists dropped images through window.omelette.writeFile and
  // reads them back with fetch(). Neither exists outside the project, so the
  // slots go read-only. This shim supplies both, backed by Supabase Storage,
  // so images behave the same on the live site.
  API.imagesPath = function () { return "k10/" + (specId() || "draft") + ".image-slots.json"; };

  API.removeLibrary = function (code) {
    if (!code) return Promise.resolve(false);
    return client().then(function (c) {
      return c.from("k10_library").delete().eq("system_code", code);
    }).then(function (r) { return !(r && r.error); }).catch(function () { return false; });
  };

  // ── Library images ────────────────────────────────────────────────────────
  // A build-up drawing belongs to the system, not to the project it was first
  // specified on, so it is stored against the system code rather than the spec
  // id. Kept in Storage rather than in the library row: these are ~200kB data
  // URLs and there is no reason to drag every one of them down with the
  // library on each page load.
  API.libraryImagePath = function (code) {
    return "k10/library/" + encodeURIComponent(code) + ".image.json";
  };

  API.libraryImageLoad = function (code) {
    if (!code) return Promise.resolve(null);
    return client().then(function (c) {
      return c.storage.from("k10-images").download(API.libraryImagePath(code));
    }).then(function (r) {
      if (r.error || !r.data) return null;
      return r.data.text();
    }).then(function (t) {
      try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
    }).catch(function () { return null; });
  };

  API.libraryImageSave = function (code, val) {
    if (!code || !val) return Promise.resolve(false);
    return client().then(function (c) {
      return c.storage.from("k10-images").upload(
        API.libraryImagePath(code),
        new Blob([JSON.stringify(val)], { type: "application/json" }),
        { contentType: "application/json", upsert: true }
      );
    }).then(function (r) { return !(r && r.error); }).catch(function () { return false; });
  };

  API.imagesLoad = function () {
    return client().then(function (c) {
      return c.storage.from("k10-images").download(API.imagesPath());
    }).then(function (r) {
      if (r.error || !r.data) return null;
      return r.data.text();
    }).catch(function () { return null; });
  };

  API.imagesSave = function (text) {
    return client().then(function (c) {
      return c.storage.from("k10-images").upload(API.imagesPath(), new Blob([text], { type: "application/json" }), {
        contentType: "application/json",
        upsert: true,
      });
    }).catch(function () { return null; });
  };

  (function installSlotShim() {
    if (window.omelette && window.omelette.writeFile) return; // inside the project already
    if (!storedKey()) return;                                 // still locked; nothing to serve

    var realFetch = window.fetch.bind(window);
    window.fetch = function (input) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (/\.image-slots\.state\.json$/.test(url)) {
        return API.imagesLoad().then(function (text) {
          return new Response(text || "null", {
            status: text ? 200 : 404,
            headers: { "Content-Type": "application/json" },
          });
        });
      }
      return realFetch.apply(null, arguments);
    };

    // Flagged so the document's own save path knows this is not the real host
    // and keeps sending setup/schedules/clauses to the database.
    window.omelette = {
      __k10Shim: true,
      writeFile: function (path, content) {
        if (!/\.state\.json$/.test(path)) return Promise.resolve(false);
        return API.imagesSave(content).then(function () { return true; });
      },
    };
  })();

})();
