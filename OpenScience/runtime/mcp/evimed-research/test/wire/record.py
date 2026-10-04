#!/usr/bin/env python3
"""Re-record the live wire fixtures from where this runs (the deployment, for the controller).

    python3 wire/record.py --dry-run             # what would be asked, nothing written
    python3 wire/record.py --only idconv__       # one provider's files, by name prefix
    python3 wire/record.py --skip-large          # leave out files over 100 KB (the zips)

Every `origin: live` entry of `manifest.json` is asked again at its `request` URL, directly (an
upstream's own 4xx/5xx body is what a fixture needs, and the gateway turns those into its own
envelope), with the runtime's User-Agent, one request a second, no redirects, no retries. The body,
status, content type, byte count, sha256 and the response's own Date header replace the entry's.

It writes nothing it is not told to. A response whose status differs from the recorded one is
reported and still written: a provider changing how it refuses is exactly what a recording is for,
and `git diff` is the review. `constructed` entries are never touched.

Run it from a host that may reach the providers (NCBI answers a plain client; the Europe PMC
documentation page and ClinicalTrials.gov's internal `/api/int/` do not, and are not recorded).
"""

import argparse
import email.utils
import hashlib
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
USER_AGENT = "EviMed-Research/1.2 (fixture recorder)"
LARGE_BYTES = 100 * 1024
MAX_BYTES = 8 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect())


def request_url(entry):
    """The exact URL of an entry: its display string, with the query's values percent-encoded."""
    method, _, display = entry["request"].partition(" ")
    if method != "GET":
        raise ValueError("%s: only GET requests are recorded" % entry["file"])
    base, _, query = display.partition("?")
    parts = []
    for pair in query.split("&") if query else []:
        key, _, value = pair.partition("=")
        parts.append("%s=%s" % (key, urllib.parse.quote(value, safe=":/,@%")))
    return base + ("?" + "&".join(parts) if parts else "")


def fetch(url):
    request = urllib.request.Request(url, headers={"user-agent": USER_AGENT, "accept": "*/*"})
    try:
        with OPENER.open(request, timeout=60) as response:
            return response.status, response.headers, response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read(MAX_BYTES + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default="", help="record only files whose name starts with this")
    parser.add_argument("--skip-large", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    changed = 0
    for entry in manifest["files"]:
        if entry.get("origin") != "live" or not entry["file"].startswith(args.only):
            continue
        if args.skip_large and entry.get("bytes", 0) > LARGE_BYTES:
            print("skip  %s (large)" % entry["file"])
            continue
        url = request_url(entry)
        if args.dry_run:
            print("would %s -> %s" % (url, entry["file"]))
            continue
        time.sleep(1.0)
        status, headers, body = fetch(url)
        if len(body) > MAX_BYTES:
            print("FAIL  %s: more than %d bytes" % (entry["file"], MAX_BYTES))
            continue
        digest = hashlib.sha256(body).hexdigest()
        moved = []
        if status != entry["status"]:
            moved.append("status %s -> %s" % (entry["status"], status))
        if digest != entry["sha256"]:
            moved.append("bytes changed")
        (HERE / entry["file"]).write_bytes(body)
        date = headers.get("Date")
        recorded = email.utils.parsedate_to_datetime(date).astimezone(timezone.utc) if date else datetime.now(timezone.utc)
        entry.update({
            "status": status, "contentType": headers.get("Content-Type", entry.get("contentType")), "bytes": len(body), "sha256": digest,
            "recordedAt": recorded.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        changed += bool(moved)
        print("%-5s %s%s" % ("moved" if moved else "same", entry["file"], (" (%s)" % ", ".join(moved)) if moved else ""))
    if not args.dry_run:
        (HERE / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print("%d file(s) differ from the earlier recording; review with git diff." % changed)


if __name__ == "__main__":
    main()
