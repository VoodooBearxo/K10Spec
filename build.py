#!/usr/bin/env python3
"""Rebundle the K10 document into the single-file index.html.

The original bundler is part of the Omelette project and isn't available here.
Rather than reimplement it, this reuses the shipped bundle as the shell: the
loader script, the font/react assets and the resource plumbing are left exactly
as they were, and only the payloads that actually changed are rewritten — the
manifest entries for the source files, and the document template.

  python3 build.py <shell-index.html> <src-dir> <out.html> [version-stamp]
"""
import base64
import gzip
import json
import os
import re
import sys

# uuid -> source file, as recovered from the shipped bundle
SOURCES = {
    "a8892392-bae0-41c9-871d-e8f0d8c17ddf": "support.js",
    "c572c272-65c9-4aa2-b41d-3b7c59c7cc15": "k10-cloud.js",
    "c6e2b8cd-e431-419a-beb6-e71a0155795e": "doc-page.js",
    "ccdcd224-5b8b-4c99-acfe-e6c6ad78f72d": "image-slot.js",
    "e7478040-3d50-4717-b14d-7f371e5e9c9e": "assets/ga-technical-black.png",
}
DOC = "K10 Specification Template.dc.html"
BLOCK = '<script type="__bundler/%s">\n%s\n  </script>'


def block(html, name):
    m = re.search(r'<script type="__bundler/%s">\n(.*?)\n  </script>' % name, html, re.S)
    if not m:
        sys.exit("missing __bundler/%s block in the shell" % name)
    return m.group(1)


def main():
    shell_path, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
    stamp = sys.argv[4] if len(sys.argv) > 4 else None

    shell = open(shell_path, encoding="utf-8").read()
    manifest = json.loads(block(shell, "manifest"))

    # Re-pack each source file, keeping every asset's original compression flag
    # so the loader's decode path is unchanged.
    for uuid, name in SOURCES.items():
        path = os.path.join(src, name)
        raw = open(path, "rb").read()
        entry = manifest[uuid]
        if entry["compressed"]:
            # mtime=0 so an unchanged input produces an identical bundle
            raw = gzip.compress(raw, mtime=0)
        entry["data"] = base64.b64encode(raw).decode("ascii")
        print("  packed %-30s %7d bytes%s" % (name, len(raw), " (gz)" if entry["compressed"] else ""))

    # The document, with its script/img refs mapped back to asset uuids.
    doc = open(os.path.join(src, DOC), encoding="utf-8").read()
    for uuid, name in SOURCES.items():
        doc = doc.replace('"%s"' % name, '"%s"' % uuid)
    left = [n for n in SOURCES.values() if '"%s"' % n in doc]
    if left:
        sys.exit("unmapped source refs left in the document: %s" % left)

    if stamp:
        # An unbuilt document carries the placeholder; one recovered from a
        # shipped bundle already carries the stamp it went out with.
        doc, n = re.subn(r'(<div data-build=""[^>]*>)[^<]*(</div>)',
                         lambda m: m.group(1) + stamp + m.group(2), doc)
        if n != 1:
            sys.exit("expected exactly one [data-build] slot, found %d" % n)
        print("  stamped %r" % stamp)

    result = shell
    for name, payload in (("manifest", json.dumps(manifest)),
                          ("template", json.dumps(doc))):
        # These payloads sit inside <script> elements, so the HTML parser sees
        # them before any JSON parser does: a literal </script> anywhere in the
        # string ends the element early and truncates the JSON. json.dumps does
        # not escape forward slashes, so escape them here — the same thing the
        # original bundler does, and what the loader does to its resource map.
        payload = payload.replace("</", "<\\u002F")
        old = BLOCK % (name, block(shell, name))
        new = BLOCK % (name, payload)
        assert result.count(old) == 1, name
        result = result.replace(old, new)

    open(out, "w", encoding="utf-8").write(result)

    # Verify the way a browser reads it, not the way a regex does. An HTML
    # parser ends a <script> at the FIRST </script it meets, so for each
    # payload that first occurrence must be the intended terminator — and the
    # text up to it must still parse as JSON. A regex with a non-greedy match
    # will happily skip past a premature one and report everything as fine,
    # which is exactly how a broken bundle shipped.
    check = open(out, encoding="utf-8").read()
    for name in ("manifest", "template"):
        open_tag = '<script type="__bundler/%s">\n' % name
        start = check.index(open_tag) + len(open_tag)
        end = check.lower().index("</script", start)
        payload = check[start:end]
        try:
            json.loads(payload.rstrip())
        except ValueError as e:
            sys.exit("%s payload is truncated at the first </script: %s" % (name, e))
        print("  html-safe: %s parses to the first </script (%d bytes)" % (name, len(payload)))
    print("  wrote %s (%d bytes)" % (out, os.path.getsize(out)))


if __name__ == "__main__":
    main()
