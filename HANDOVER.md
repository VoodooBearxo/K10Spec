# K10 Specification Builder — support handover

## What this is
A single-file HTML app for producing NBS **Section K10** specifications (drylining,
ceilings, steel encasement) for GA Technical. One document, three tabs: **Project setup**
(working sheet, never printed — project info, a 1,065-system British Gypsum picker, and a
Cloud bar), **Front page** (issue sheet, printed), **K10 specification** (schedules +
clause pages, printed).

The goal driving current work: fill a clause in once, and every future K10 using that
system arrives complete — text *and* build-up drawing. Plug and play.

## Where it lives
- **Live:** https://voodoobearxo.github.io/K10Spec/ — GitHub Pages, `index.html` at repo root
- **Repo:** `VoodooBearxo/K10Spec`, branch `main`, cloned at `~/Documents/Projects/K10Spec`
- **Backend:** Supabase project `bbshqvlrfcivhddkwgib` ("Sitebear.io" — it also hosts an
  unrelated app; **do not touch tables outside `k10_*`**)
- Currently live: **v24 · 12 Aug 14:45**, 606,586 bytes

## Build and publish — read before changing anything
**The repo's `index.html` is a build artefact, not source.** The original bundler is part
of an Omelette/Claude Design Component project that is not on this machine. The source was
recovered by decoding the bundle and now lives at `~/Documents/Projects/K10Spec/source/`:
`K10 Specification Template.dc.html`, `k10-cloud.js`, `doc-page.js`, `image-slot.js`,
`support.js`, `assets/ga-technical-black.png`.

Rebuild with `build.py` (repo root, needs only python3 — there is no node or bun here):

```bash
cd ~/Documents/Projects/K10Spec
python3 build.py index.html source index.html "v11 · 12 Aug 14:00"
```

It reuses the existing bundle as the shell — regenerating only the `__bundler/manifest`
and `__bundler/template` payloads and leaving the loader byte-identical. Verified
reproducible: rebuilding the shipped build from `source/` gives a byte-identical file.

**Three rules the build must keep:**
1. **Escape `</` in the payloads.** They sit inside `<script>` elements, so the HTML parser
   reaches them before any JSON parser and ends the element at the *first* `</script`. The
   document contains five. `json.dumps` does not escape slashes; `build.py` does. Getting
   this wrong ships a page that dies with *"Error unpacking: JSON Parse error: Unterminated
   string"* — this happened in v7.
2. **Verify the way a browser reads it**, not with a non-greedy regex — a regex skips past a
   premature terminator and reports a broken bundle as fine. `build.py` asserts the text up
   to the first `</script` parses as JSON.
3. **Syntax-check before building:** `osascript -l JavaScript` (JXA) parses JS without a DOM.
   Wrap the script in an uncalled function so parse errors surface without executing.

**Publishing** — a deploy key with write access is configured (`~/.ssh/k10spec_deploy`,
host alias `github-k10spec`), so `git push origin main` works from this machine. Pages
takes 1–3 minutes. Confirm with the byte count, not the stamp (the stamp is stored
JSON-escaped as `v24 · …`, so a naive grep will miss it):

```bash
curl -s https://voodoobearxo.github.io/K10Spec/ | wc -c
```

If a deployment wedges at `waiting`/`error`, re-running does **not** create a new
deployment record — push an empty commit instead. Deployment status is readable
unauthenticated: `api.github.com/repos/VoodooBearxo/K10Spec/deployments`.

## Data model (Supabase `public`)
| Table | Purpose | Now |
|---|---|---|
| `k10_systems` | 1,065 British Gypsum systems, read-only to the app | 1,065 rows |
| `k10_specs` | One row per K10: `setup`/`schedules`/`clauses`/`images` jsonb | 2 rows |
| `k10_library` | The office's collated systems, unique on `system_code`, clause detail in `detail` jsonb | 2 rows |
| `k10_config` | Passcode hash. Service role only | 1 row |
| `k10_app` | Legacy from an abandoned Supabase-hosting attempt. Unused — safe to delete, along with the `k10`, `k10-publish` and `k10-ct` edge functions |

Storage bucket `k10-images` (private): per-spec image state at
`k10/<specId>.image-slots.json`, per-system build-up drawings at
`k10/library/<system_code>.image.json`.

**Security:** no user accounts by design. No key ships in the file — the `k10-key` edge
function (verify_jwt off) checks the passcode and returns the publishable key, which is
kept in `localStorage`. RLS lets anon read/write `k10_specs`/`k10_library`; `k10_systems`
is read-only. The passcode gates the key, not RLS. `k10-import` is the catalogue importer.

## Invariants — each of these cost a broken build
1. **Never save until the user has acted** (`_userTouched`). `<image-slot>` stamps its own
   attributes on upgrade; without the gate that churn mints a blank record on every load.
   Tab clicks don't count as work. An insert additionally requires `_userTouched`.
2. **An empty payload must never create or overwrite a record.** `_worthSaving` compares a
   normalised snapshot against a baseline; permission to insert travels *with* the save.
3. **A Postgres update matching zero rows is not an error.** Treat a null result as a dead
   id, clear it, re-insert. Only report "Saved" when a row comes back.
4. **Status text lives inside the observed DOM.** Anything written to must carry
   `data-status-text`, sit in `[data-cloud-bar]`/`[data-library-panel]`, or be in the
   observer's `quiet` attribute list — otherwise writing to it schedules the next save,
   forever.
5. **Anything on a timer must be idempotent.** Collation runs on a 5s debounce; a pass that
   changes nothing must report nothing. Two rows sharing a system reference once fought
   over one library entry and wrote to the database every 5s with nobody typing.
6. **MutationObserver records arrive asynchronously** — changes made while restoring land
   after `_restoring` clears. They are drained and the baseline re-taken from the restored
   document.
7. **Placeholders never reach the library.** `_worthKeeping` rejects any value carrying a
   `[bracket]` or a stray `TBC`, on both the schedule and clause paths.

Setup fields are plain `<input>`s — typing mutates nothing, so they have their own
debounced save (`_queueSetupSave`). `?forceHosted=1` exercises the hosted path from inside
the project editor.

## How it behaves now
- **Library loads on every page load** (`_loadLibrary`), not only when opening a saved K10.
- **Collation runs as you type** (`_queueCollate`, 5s), sending only changed entries.
- **Placeholders are click-to-edit.** Clicking a `TBC`/`[bracketed]` prompt blanks it, puts
  the caret inside, and marks it `data-filled` so typing reads in the document face rather
  than placeholder grey mono. Leave it untouched and the prompt returns. An open field is
  seeded with a zero-width space (an empty inline element won't hold a caret); `_txt()`,
  `_cellText()`, `_collectContent()` and `_normalise()` all strip it, and a save never
  persists an open field.
- **Build-up drawings travel with the system**, stored per system code, fingerprinted so an
  unchanged ~200 kB drawing isn't re-uploaded every 5s. A stored drawing never overwrites
  one already on the clause.

## Known outstanding
- **Images dropped before the first save are stranded.** `imagesPath()` uses
  `specId() || "draft"`; once the first insert assigns a real id, nothing migrates
  `k10/draft.image-slots.json`. Fix is a storage migration on insert.
- **The pro-forma clause's "Remove clause" button goes inert after a reload** — restore
  skips `_addRemoveControl` for the pro-forma, so the parsed button has no listener.
- **Library image round-trip is untested against real data** — `k10/library/` is still
  empty, so nothing has exercised `_captureClauseImage` → `_applyStoredImage` end to end.
- Older `k10_library` rows may still hold `TBC` in schedule columns (`duty`, `acoustic`)
  from before the filter existed; new collations won't add more.
- **Nothing is browser-tested from the assistant side** — no Chrome extension is connected,
  so every change has been statically verified only. The user tests on the live site.

## Style
Archivo + IBM Plex Mono, black on white, 1px black rules, no rounded corners, no colour
beyond black/greys and a `#f6f4ef` panel. It reads as a technical document, not a web app —
keep it that way. Placeholders are `[square brackets]` or `TBC` in grey mono; code treats a
leading `[` or a `TBC` token as "not yet filled in" when deciding what to save or collate.
