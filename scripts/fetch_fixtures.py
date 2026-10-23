"""Fetch public test-only upstream files and reject any SHA-256/size mismatch."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_GROUPS = {
    "novnc": {
        "start.html": "https://cp.vdsina.ru/static/novnc/start.html?v=08",
        "keyboard.js": "https://cp.vdsina.ru/static/novnc/core/input/keyboard.js",
        "util.js": "https://cp.vdsina.ru/static/novnc/core/input/util.js",
        "rfb.js": "https://cp.vdsina.ru/static/novnc/core/rfb.js",
        "keysymdef.js": "https://cp.vdsina.ru/static/novnc/core/input/keysymdef.js",
        "xtscancodes.js": "https://cp.vdsina.ru/static/novnc/core/input/xtscancodes.js",
    },
    "qemu-v7.2.9": {
        "vnc.c": "https://raw.githubusercontent.com/qemu/qemu/v7.2.9/ui/vnc.c",
        "keymaps.c": "https://raw.githubusercontent.com/qemu/qemu/v7.2.9/ui/keymaps.c",
        "keymaps.h": "https://raw.githubusercontent.com/qemu/qemu/v7.2.9/ui/keymaps.h",
        "en-us": "https://raw.githubusercontent.com/qemu/qemu/v7.2.9/pc-bios/keymaps/en-us",
    },
}
MAX_BYTES = 512 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Fixture redirects are not accepted")


def records(root: Path):
    for group, expected in FIXTURE_GROUPS.items():
        folder = root / "tests" / "fixtures" / group
        manifest = json.loads((folder / "SOURCE.safe.json").read_text(encoding="utf-8"))
        sources = manifest.get("sources")
        if not isinstance(sources, list) or len(sources) != len(expected):
            raise ValueError("Invalid fixture source count: " + group)
        seen = set()
        for source in sources:
            name = source.get("path")
            if name not in expected or name in seen or source.get("url") != expected[name]:
                raise ValueError("Unexpected or duplicate fixture source: " + group)
            seen.add(name)
            if not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", "")):
                raise ValueError("Invalid fixture SHA-256: " + group)
            size = source.get("bytes")
            if type(size) is not int or not 0 < size <= MAX_BYTES:
                raise ValueError("Invalid fixture size: " + group)
            yield folder / name, source


def verify(data: bytes, source: dict):
    if len(data) != source["bytes"] or hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError("Fixture size/SHA-256 mismatch: " + source["path"])


def prepare(root: Path = ROOT, verify_only: bool = False):
    prepared = 0
    opener = urllib.request.build_opener(NoRedirect)
    for path, source in records(root):
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError("Symlink fixture paths are not accepted")
        if path.exists():
            verify(path.read_bytes(), source)
        else:
            if verify_only:
                raise ValueError("Missing fixture: " + str(path.relative_to(root)))
            request = urllib.request.Request(source["url"], headers={"User-Agent": "vdsina-vnc-paste-bridge-fixtures/1.1.0"})
            with opener.open(request, timeout=20) as response:
                if response.status != 200 or response.geturl() != source["url"]:
                    raise ValueError("Unexpected fixture HTTP response")
                data = response.read(MAX_BYTES + 1)
            verify(data, source)
            with path.open("xb") as output:
                output.write(data)
        prepared += 1
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Verify all cached fixtures without network access")
    args = parser.parse_args()
    try:
        count = prepare(verify_only=args.verify_only)
    except (OSError, ValueError, urllib.error.URLError) as error:
        print("Fixture preparation failed: " + str(error), file=sys.stderr)
        return 1
    print("Verified public test fixtures: " + str(count))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
