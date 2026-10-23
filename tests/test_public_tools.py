"""Portable packaging boundary and fixture validation; no network or VPS calls."""
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load("package")
fixtures = load("fetch_fixtures")


class PublicToolsTests(unittest.TestCase):
    def seed(self, root):
        for relative in package.ALLOWED_FILES:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"public example")
        (root / "package.json").write_text('{"version":"1.1.0"}', encoding="utf-8")
        (root / "extension/manifest.json").write_text('{"version":"1.1.0"}', encoding="utf-8")

    def test_archive_only_contains_allowlist_and_preserves_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.seed(root)
            for relative in ("runtime/connection.json", "evidence/private.json", "extension/secret.txt", "tests/fixtures/novnc/start.html"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"must never be packaged")
            archive, digest, count = package.build_archive(root)
            with zipfile.ZipFile(archive) as zipped:
                self.assertEqual(set(zipped.namelist()), set(package.ALLOWED_FILES))
                for name in zipped.namelist():
                    self.assertEqual(zipped.read(name), (root / name).read_bytes())
            self.assertEqual(count, len(package.ALLOWED_FILES))
            self.assertEqual(len(digest), 64)
            with self.assertRaises(FileExistsError):
                package.build_archive(root)

    def test_missing_input_creates_no_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.seed(root)
            (root / "extension/provider.js").unlink()
            with self.assertRaises(ValueError):
                package.build_archive(root)
            self.assertFalse((root / "dist").exists())

    def test_version_mismatch_creates_no_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.seed(root)
            (root / "extension/manifest.json").write_text('{"version":"1.0.5"}', encoding="utf-8")
            with self.assertRaises(ValueError):
                package.build_archive(root)
            self.assertFalse((root / "dist").exists())

    def test_fixture_hash_size_and_allowlisted_urls(self):
        records = list(fixtures.records(ROOT))
        self.assertEqual(len(records), 10)
        for _, source in records:
            with self.assertRaises(ValueError):
                fixtures.verify(b"modified upstream", source)

    def test_verify_only_missing_does_not_open_network(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for group in fixtures.FIXTURE_GROUPS:
                folder = root / "tests/fixtures" / group
                folder.mkdir(parents=True)
                (folder / "SOURCE.safe.json").write_bytes((ROOT / "tests/fixtures" / group / "SOURCE.safe.json").read_bytes())
            with patch.object(fixtures.urllib.request.OpenerDirector, "open", side_effect=AssertionError("network called")):
                with self.assertRaises(ValueError):
                    fixtures.prepare(root, verify_only=True)


if __name__ == "__main__":
    unittest.main()
