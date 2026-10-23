#!/usr/bin/env python3
"""Prepare a VNC paste packet or expose one through an authenticated loopback API.

The API is read-only.  Text is never executed, sent to VNC, copied into a system
clipboard, or written to console output.  Bearer tokens are saved only to the
explicit connection file and exist in process memory while serving.
"""

import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sys


PACKET_SCHEMA = "vnc-paste-packet/v1"
CONNECTION_SCHEMA = "vnc-paste-connection/v1"
HEALTH_SCHEMA = "vnc-paste-health/v1"
LOOPBACK = "127.0.0.1"
MAX_TEXT_BYTES = 32768
MAX_PACKET_FILE_BYTES = 262144
PACKET_FIELDS = frozenset({
    "schema", "text", "sha256", "utf8_bytes", "code_points", "batch_size",
    "character_delay_ms", "batch_delay_ms", "newline_mode",
})
INTEGER_BOUNDS = {
    "batch_size": (1, 256), "character_delay_ms": (8, 100),
    "batch_delay_ms": (80, 2000),
}


class PacketError(ValueError):
    """Static error codes intentionally contain neither source text nor tokens."""


def _integer(name, value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise PacketError("invalid_" + name)
    return value


def _text_metrics(text, newline_mode):
    if not isinstance(text, str):
        raise PacketError("text_must_be_string")
    if newline_mode not in ("reject", "enter"):
        raise PacketError("invalid_newline_mode")
    for character in text:
        code = ord(character)
        if character == "\n":
            if newline_mode != "enter":
                raise PacketError("newline_requires_multiline")
        elif code < 32 or code == 127:
            # CR and Tab are always rejected, including multiline mode.
            raise PacketError("unsupported_control_character")
        elif code > 126:
            raise PacketError("unsupported_unicode")
    encoded = text.encode("utf-8")
    if len(encoded) > MAX_TEXT_BYTES:
        raise PacketError("text_too_large")
    return len(encoded), len(text), hashlib.sha256(encoded).hexdigest()


def make_packet(text, *, multiline=False, batch_size=256,
                character_delay_ms=12, batch_delay_ms=120):
    if type(multiline) is not bool:
        raise PacketError("multiline_must_be_boolean")
    newline_mode = "enter" if multiline else "reject"
    size, points, digest = _text_metrics(text, newline_mode)
    packet = {"schema": PACKET_SCHEMA, "text": text, "sha256": digest,
              "utf8_bytes": size, "code_points": points, "batch_size": batch_size,
              "character_delay_ms": character_delay_ms, "batch_delay_ms": batch_delay_ms,
              "newline_mode": newline_mode}
    return validate_packet(packet)


def validate_packet(packet):
    if type(packet) is not dict or set(packet) != PACKET_FIELDS:
        raise PacketError("packet_fields_must_match_contract")
    if packet["schema"] != PACKET_SCHEMA:
        raise PacketError("unsupported_packet_schema")
    size, points, digest = _text_metrics(packet["text"], packet["newline_mode"])
    for name, (minimum, maximum) in INTEGER_BOUNDS.items():
        _integer(name, packet[name], minimum, maximum)
    for name, value in (("utf8_bytes", size), ("code_points", points)):
        if type(packet[name]) is not int or packet[name] != value:
            raise PacketError("incorrect_" + name)
    actual = packet["sha256"]
    if not isinstance(actual, str) or re.fullmatch(r"[0-9a-f]{64}", actual) is None:
        raise PacketError("invalid_sha256")
    if not hmac.compare_digest(actual, digest):
        raise PacketError("incorrect_sha256")
    # Return a copy so a caller cannot change this object through its old alias.
    return dict(packet)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PacketError("duplicate_json_field")
        result[key] = value
    return result


def _read_bounded(path, limit):
    with Path(path).open("rb") as stream:
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise PacketError("input_file_too_large")
    return content


def read_source(path):
    try:
        # Binary reading preserves CRLF: newline translation must not hide CR.
        return _read_bounded(path, MAX_TEXT_BYTES).decode("utf-8")
    except UnicodeDecodeError:
        raise PacketError("source_must_be_utf8") from None


def read_packet(path):
    try:
        raw = _read_bounded(path, MAX_PACKET_FILE_BYTES).decode("utf-8")
        packet = json.loads(raw, object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise PacketError("packet_must_be_valid_json") from None
    return validate_packet(packet)


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _write_json(path, value):
    """Atomically write the requested artifact; do not print its contents."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name("." + destination.name + "." + secrets.token_hex(8) + ".tmp")
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(_json_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


class PacketServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    block_on_close = False

    def __init__(self, packet, port):
        approved = validate_packet(packet)
        _integer("port", port, 0, 65535)  # zero is only for an API test's ephemeral port
        self._packet_bytes = _json_bytes(approved)
        self._health_bytes = _json_bytes({"schema": HEALTH_SCHEMA, "status": "ready"})
        self._token = secrets.token_urlsafe(32)
        super().__init__((LOOPBACK, port), PacketHandler)

    @property
    def base_url(self):
        return "http://127.0.0.1:" + str(self.server_address[1])

    def write_connection(self, path):
        connection = {"schema": CONNECTION_SCHEMA, "base_url": self.base_url, "token": self._token}
        _write_json(path, connection)

    def handle_error(self, request, client_address):
        # BaseServer normally prints a traceback.  Never log request headers,
        # source text, tokens, or arbitrary client-controlled paths here.
        pass


class PacketHandler(BaseHTTPRequestHandler):
    server_version = "VncPasteBridge/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(2)

    def log_message(self, format, *args):
        # Request paths can contain a token pasted in the wrong place.
        pass

    def _send(self, status, body, **headers):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _error(self, status, code, **headers):
        self._send(status, _json_bytes({"error": code}), **headers)

    def _authorized(self):
        host_headers = self.headers.get_all("Host", [])
        expected = "127.0.0.1:" + str(self.server.server_address[1])
        valid_hosts = {expected}
        if self.server.server_address[1] == 80:
            valid_hosts.add(LOOPBACK)
        if self.client_address[0] != LOOPBACK or len(host_headers) != 1 or host_headers[0] not in valid_hosts:
            self._error(403, "loopback_host_required")
            return False
        authorization = self.headers.get_all("Authorization", [])
        expected_auth = "Bearer " + self.server._token
        if len(authorization) != 1 or not hmac.compare_digest(authorization[0].encode("utf-8"), expected_auth.encode("ascii")):
            self._error(401, "bearer_token_required", WWW_Authenticate="Bearer")
            return False
        return True

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/v1/packet":
            self._send(200, self.server._packet_bytes)
        elif self.path == "/v1/health":
            self._send(200, self.server._health_bytes)
        else:
            self._error(404, "route_not_found")

    def _read_only(self):
        if self._authorized():
            self._error(405, "read_only_api", Allow="GET")

    do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = do_CONNECT = _read_only


def make_server(packet, *, port=8765):
    """Bind only 127.0.0.1; port zero permits isolated local API tests."""
    return PacketServer(packet, port)


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("pack", help="Prepare a packet without dispatch")
    pack.add_argument("file", type=Path)
    pack.add_argument("--out", type=Path, required=True)
    pack.add_argument("--multiline", action="store_true", help="Explicitly allow LF; LF will mean Enter if subsequently sent")
    pack.add_argument("--batch-size", type=int, default=256)
    pack.add_argument("--character-delay-ms", type=int, default=12)
    pack.add_argument("--batch-delay-ms", type=int, default=120)
    serve = commands.add_parser("serve", help="Expose one approved packet through a read-only loopback API")
    serve.add_argument("--packet", type=Path, required=True)
    serve.add_argument("--connection", type=Path, required=True)
    serve.add_argument("--port", type=int, default=8765)
    return parser


def main(argv=None):
    arguments = _parser().parse_args(argv)
    server = None
    try:
        if arguments.command == "pack":
            if arguments.file.resolve() == arguments.out.resolve():
                raise PacketError("source_and_output_must_differ")
            packet = make_packet(read_source(arguments.file), multiline=arguments.multiline,
                                 batch_size=arguments.batch_size,
                                 character_delay_ms=arguments.character_delay_ms,
                                 batch_delay_ms=arguments.batch_delay_ms)
            _write_json(arguments.out, packet)
            print("Packed: utf8_bytes={}; code_points={}; sha256={}. No dispatch.".format(
                packet["utf8_bytes"], packet["code_points"], packet["sha256"]))
            return 0
        _integer("port", arguments.port, 1, 65535)
        if arguments.packet.resolve() == arguments.connection.resolve():
            raise PacketError("packet_and_connection_must_differ")
        packet = read_packet(arguments.packet)
        server = make_server(packet, port=arguments.port)
        server.write_connection(arguments.connection)
        print("Serving one packet at {}. Import the connection file; token is not printed.".format(server.base_url), flush=True)
        server.serve_forever(poll_interval=0.2)
        return 0
    except KeyboardInterrupt:
        print("Stopped.")
        return 0
    except PacketError as exc:
        print("Error: " + str(exc), file=sys.stderr)
        return 2
    except OSError:
        print("Error: local_io_or_bind_failed", file=sys.stderr)
        return 2
    finally:
        if server is not None:
            server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
