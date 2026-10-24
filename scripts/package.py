"""Build an installable ZIP from a fixed public allowlist, without runtime data."""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_FILES = (
    "extension/api-client.js", "extension/background.js", "extension/content.css",
    "extension/content.js", "extension/core-main.js", "extension/core.js",
    "extension/main-bridge.js", "extension/manifest.json", "extension/provider.js",
    "extension/icons/icon-16.png", "extension/icons/icon-32.png",
    "extension/icons/icon-48.png", "extension/icons/icon-128.png", "extension/icons/icon.svg",
    "cli/__init__.py", "cli/__main__.py", "cli/vnc_paste_bridge.py",
    "examples/command.txt", "examples/packet.json",
    "README.md", "CLI.md", "CONTRACT.md", "LICENSE.md", "Start-Bridge.ps1",
    "docs/preview.jpg", "docs/USER_GUIDE.md",
)


def payloads(root: Path):
    root = root.resolve()
    for relative in sorted(ALLOWED_FILES):
        path = root / relative
        if any(parent.is_symlink() for parent in (path, *path.parents) if parent != root.parent):
            raise ValueError("Symlink archive inputs are not accepted: " + relative)
        if not path.is_file() or path.resolve().relative_to(root).as_posix() != relative:
            raise ValueError("Missing or escaped archive input: " + relative)
        yield relative, path.read_bytes()


def build_archive(root: Path = ROOT):
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    manifest = json.loads((root / "extension/manifest.json").read_text(encoding="utf-8"))
    version = package.get("version", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or manifest.get("version") != version:
        raise ValueError("Package and extension versions must match")
    files = list(payloads(root))  # Validate every input before creating an archive.
    dist = root / "dist"
    if dist.is_symlink():
        raise ValueError("Symlink dist directory is not accepted")
    dist.mkdir(exist_ok=True)
    destination = dist / ("VNC-Paste-Bridge-" + version + ".zip")
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, data in files:
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    checksum = destination.with_suffix(destination.suffix + ".sha256")
    checksum.write_text(digest + "  " + destination.name + "\n", encoding="ascii")
    return destination, digest, len(files)


if __name__ == "__main__":
    archive, sha256, count = build_archive()
    print(json.dumps({"archive": str(archive.relative_to(ROOT)), "sha256": sha256, "files": count}))
