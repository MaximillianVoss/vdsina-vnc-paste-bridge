"""Offline packet tests and real local HTTP checks; no VNC/SSH/remote access."""

import contextlib
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "cli" / "vnc_paste_bridge.py"
spec = importlib.util.spec_from_file_location("vnc_paste_bridge_cli", SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class PacketTests(unittest.TestCase):
    def test_exact_contract_counts_and_digest(self):
        text = "printf 'a test command -- $() is only text'"
        packet = bridge.make_packet(text)
        self.assertEqual(set(packet), bridge.PACKET_FIELDS)
        self.assertEqual(packet["utf8_bytes"], len(text.encode("utf-8")))
        self.assertEqual(packet["code_points"], len(text))
        self.assertEqual(packet["sha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
        self.assertEqual(packet["batch_size"], 256)
        self.assertEqual(packet["character_delay_ms"], 12)
        self.assertEqual(packet["batch_delay_ms"], 120)
        self.assertEqual(packet["newline_mode"], "reject")

    def test_multiline_is_explicit_and_never_adds_final_enter(self):
        with self.assertRaises(bridge.PacketError):
            bridge.make_packet("line1\nline2")
        packet = bridge.make_packet("line1\nline2", multiline=True)
        self.assertEqual(packet["text"], "line1\nline2")
        self.assertEqual(packet["newline_mode"], "enter")
        self.assertFalse(packet["text"].endswith("\n"))

    def test_tabs_cr_controls_and_unicode_rejected_in_both_modes(self):
        samples = ("\t", "\r", "\r\n", "\x00", "\x1b", "\x7f", "кириллица", "é", "😀", "\ud800")
        for sample in samples:
            for multiline in (False, True):
                with self.subTest(sample=repr(sample), multiline=multiline):
                    with self.assertRaises(bridge.PacketError):
                        bridge.make_packet(sample, multiline=multiline)

    def test_text_byte_bound_and_empty_packet(self):
        self.assertEqual(bridge.make_packet("x" * 32768)["utf8_bytes"], 32768)
        self.assertEqual(bridge.make_packet("")["utf8_bytes"], 0)
        with self.assertRaises(bridge.PacketError):
            bridge.make_packet("x" * 32769)

    def test_numeric_ranges_accept_edges_and_reject_outside_bool_and_float(self):
        for field, (minimum, maximum) in bridge.INTEGER_BOUNDS.items():
            for value in (minimum, maximum):
                self.assertEqual(bridge.make_packet("x", **{field: value})[field], value)
            for value in (minimum - 1, maximum + 1, True, False, float(minimum), str(minimum), None):
                with self.subTest(field=field, value=value):
                    with self.assertRaises(bridge.PacketError):
                        bridge.make_packet("x", **{field: value})

    def test_import_recomputes_every_count_and_digest(self):
        valid = bridge.make_packet("text")
        for field, bad in (("utf8_bytes", 3), ("code_points", 5), ("sha256", "0" * 64),
                           ("utf8_bytes", 4.0), ("code_points", True), ("sha256", valid["sha256"].upper())):
            packet = dict(valid)
            packet[field] = bad
            with self.subTest(field=field, bad=bad):
                with self.assertRaises(bridge.PacketError):
                    bridge.validate_packet(packet)

    def test_import_exact_keys_schema_types_and_newline_policy(self):
        valid = bridge.make_packet("text")
        mutations = [None, [], {**valid, "execute": True}, {k: v for k, v in valid.items() if k != "sha256"},
                     {**valid, "schema": "vnc-paste-packet/v2"}, {**valid, "text": 1},
                     {**valid, "newline_mode": "auto"}, {**valid, "text": "text\n"}]
        for packet in mutations:
            with self.assertRaises(bridge.PacketError):
                bridge.validate_packet(packet)

    def test_read_source_preserves_crlf_and_pack_rejects_it(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / "source.txt", Path(temp) / "packet.json"
            source.write_bytes(b"line1\r\nline2")
            self.assertEqual(bridge.read_source(source), "line1\r\nline2")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(bridge.main(["pack", str(source), "--out", str(output), "--multiline"]), 2)
            self.assertFalse(output.exists())

    def test_duplicate_fields_invalid_utf8_and_oversized_packet_file_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "packet.json"
            duplicate = json.dumps(bridge.make_packet("x"))[:-1] + ',"text":"x"}'
            for content in (duplicate.encode(), b"\xff", b"{" * (bridge.MAX_PACKET_FILE_BYTES + 1)):
                path.write_bytes(content)
                with self.assertRaises(bridge.PacketError):
                    bridge.read_packet(path)

    def test_packet_escaped_ascii_file_and_surrogate_unicode_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "packet.json"
            packet = bridge.make_packet("A" * 32768)
            path.write_text(json.dumps(packet).replace("A" * 32768, "\\u0041" * 32768), encoding="utf-8")
            self.assertEqual(bridge.read_packet(path)["utf8_bytes"], 32768)
            packet["text"] = "\ud800"
            path.write_text(json.dumps(packet), encoding="utf-8")
            with self.assertRaises(bridge.PacketError):
                bridge.read_packet(path)


class HttpApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source_packet = bridge.make_packet("printf 'prepared only'")
        self.server = bridge.make_server(self.source_packet, port=0)
        self.connection_path = self.root / "connection.json"
        self.server.write_connection(self.connection_path)
        self.connection = json.loads(self.connection_path.read_text(encoding="utf-8"))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        self.temporary.cleanup()

    def request(self, method="GET", path="/v1/packet", authenticated=True, headers=None, body=None):
        selected = dict(headers or {})
        if authenticated:
            selected.setdefault("Authorization", "Bearer " + self.connection["token"])
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=2)
        client.request(method, path, body=body, headers=selected)
        response = client.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        client.close()
        return result

    def test_server_binds_only_loopback_and_connection_has_exact_safe_shape(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(set(self.connection), {"schema", "base_url", "token"})
        self.assertEqual(self.connection["schema"], "vnc-paste-connection/v1")
        self.assertEqual(self.connection["base_url"], "http://127.0.0.1:" + str(self.server.server_address[1]))
        self.assertRegex(self.connection["token"], r"^[A-Za-z0-9_-]{43}$")

    def test_both_get_routes_require_exact_bearer_including_unicode_and_wrong_case(self):
        for path in ("/v1/packet", "/v1/health"):
            self.assertEqual(self.request(path=path, authenticated=False)[0], 401)
            for authorization in ("Bearer wrong", "bearer " + self.connection["token"], "Bearer é", self.connection["token"]):
                with self.subTest(path=path, authorization_kind=authorization[:6]):
                    self.assertEqual(self.request(path=path, headers={"Authorization": authorization})[0], 401)

    def test_authorized_packet_and_health_no_wildcard_cors_or_token_disclosure(self):
        status, headers, body = self.request(headers={"Origin": "https://example.invalid"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), self.source_packet)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertNotIn(self.connection["token"].encode(), body)
        status, _, body = self.request(path="/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"schema": "vnc-paste-health/v1", "status": "ready"})
        self.assertNotIn(self.source_packet["text"].encode(), body)

    def test_wrong_host_and_duplicate_host_or_auth_rejected(self):
        for host in ("localhost:" + str(self.server.server_address[1]), "example.invalid", "0.0.0.0"):
            self.assertEqual(self.request(headers={"Host": host})[0], 403)
        for duplicate in ("Host", "Authorization"):
            client = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=2)
            client.putrequest("GET", "/v1/packet", skip_host=True)
            host = "127.0.0.1:" + str(self.server.server_address[1])
            client.putheader("Host", host)
            client.putheader("Authorization", "Bearer " + self.connection["token"])
            client.putheader(duplicate, host if duplicate == "Host" else "Bearer " + self.connection["token"])
            client.endheaders()
            response = client.getresponse()
            self.assertEqual(response.status, 403 if duplicate == "Host" else 401)
            response.read()
            client.close()

    def test_mutating_methods_are_refused_and_packet_remains_immutable(self):
        original = self.connection_path.read_bytes()
        for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"):
            status, headers, _ = self.request(method=method, body='{"text":"changed"}')
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "GET")
        self.assertEqual(self.connection_path.read_bytes(), original)
        self.assertEqual(json.loads(self.request()[2]), self.source_packet)

    def test_exact_routes_no_queries_paths_or_redirects(self):
        for path in ("/", "/v1/packet/", "/v1/packet?execute=1", "/v1/health?token=x", "/v1/execute", "/../packet"):
            self.assertEqual(self.request(path=path)[0], 404)

    def test_prepared_packet_is_frozen_against_external_dict_mutation(self):
        self.source_packet["text"] = "a changed caller dictionary"
        self.assertEqual(json.loads(self.request()[2])["text"], "printf 'prepared only'")

    def test_no_request_logging_even_if_token_or_text_appears_in_path(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.request(path="/v1/packet?token=" + self.connection["token"])
            self.request(authenticated=False)
        self.assertEqual(output.getvalue(), "")


class CliTests(unittest.TestCase):
    def test_shell_and_python_syntax_remains_inert_prepared_text(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / "must-not-be-created.txt"
            source, output = Path(temp) / "source.txt", Path(temp) / "packet.json"
            text = "__import__('pathlib').Path(" + ascii(str(marker)) + ").write_text('executed')"
            self.assertTrue(text.isascii())
            source.write_bytes(text.encode("utf-8"))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bridge.main(["pack", str(source), "--out", str(output)]), 0)
            self.assertFalse(marker.exists())
            self.assertEqual(bridge.read_packet(output)["text"], text)

    def test_pack_round_trip_and_console_never_prints_source(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / "source.txt", Path(temp) / "packet.json"
            text = "a source text that must never appear in console output"
            source.write_bytes(text.encode("utf-8"))
            console = io.StringIO()
            with contextlib.redirect_stdout(console), contextlib.redirect_stderr(console):
                result = bridge.main(["pack", str(source), "--out", str(output)])
            self.assertEqual(result, 0)
            self.assertEqual(bridge.read_packet(output)["text"], text)
            self.assertNotIn(text, console.getvalue())

    def test_multiline_cli_preserves_exact_source_no_automatic_trailing_lf(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / "source.txt", Path(temp) / "packet.json"
            source.write_bytes(b"first\nsecond")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bridge.main(["pack", str(source), "--out", str(output), "--multiline"]), 0)
            self.assertEqual(bridge.read_packet(output)["text"], "first\nsecond")

    def test_invalid_packet_or_port_never_opens_server_or_writes_token_file(self):
        with tempfile.TemporaryDirectory() as temp:
            packet, connection = Path(temp) / "packet.json", Path(temp) / "connection.json"
            packet.write_text(json.dumps({**bridge.make_packet("x"), "sha256": "0" * 64}), encoding="utf-8")
            for extra in ([], ["--port", "0"], ["--port", "65536"]):
                with patch.object(bridge, "make_server") as factory, contextlib.redirect_stderr(io.StringIO()):
                    result = bridge.main(["serve", "--packet", str(packet), "--connection", str(connection), *extra])
                self.assertEqual(result, 2)
                factory.assert_not_called()
                self.assertFalse(connection.exists())

    def test_serve_token_is_written_only_to_connection_file_not_console(self):
        with tempfile.TemporaryDirectory() as temp:
            packet_path, connection_path = Path(temp) / "packet.json", Path(temp) / "connection.json"
            text = "prepared secret-like input never printed"
            packet_path.write_text(json.dumps(bridge.make_packet(text)), encoding="utf-8")
            server = bridge.make_server(bridge.make_packet(text), port=0)
            console = io.StringIO()
            with patch.object(bridge, "make_server", return_value=server), \
                 patch.object(server, "serve_forever", side_effect=KeyboardInterrupt), \
                 contextlib.redirect_stdout(console), contextlib.redirect_stderr(console):
                result = bridge.main(["serve", "--packet", str(packet_path), "--connection", str(connection_path)])
            self.assertEqual(result, 0)
            connection = json.loads(connection_path.read_text(encoding="utf-8"))
            self.assertNotIn(connection["token"], console.getvalue())
            self.assertNotIn(text, console.getvalue())
            self.assertEqual(set(connection), {"schema", "base_url", "token"})

    def test_output_collision_does_not_overwrite_source_or_prepared_packet(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.txt"
            source.write_bytes(b"original text")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(bridge.main(["pack", str(source), "--out", str(source)]), 2)
            self.assertEqual(source.read_bytes(), b"original text")
            packet = Path(temp) / "packet.json"
            before = json.dumps(bridge.make_packet("x")).encode()
            packet.write_bytes(before)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(bridge.main(["serve", "--packet", str(packet), "--connection", str(packet)]), 2)
            self.assertEqual(packet.read_bytes(), before)

    def test_bind_host_cannot_be_overridden_by_cli(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                bridge.main(["serve", "--packet", "x", "--connection", "y", "--host", "0.0.0.0"])
        self.assertEqual(result.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
