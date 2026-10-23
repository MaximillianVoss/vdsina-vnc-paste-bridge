"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");
const api = require("../extension/api-client.js");
const connection = {
  schema: "vnc-paste-connection/v1", base_url: "http://127.0.0.1:8765", token: "a".repeat(43)
};

test("connection rejects arbitrary URLs, aliases, redirects, paths and invalid tokens", function () {
  core.validateConnection(connection);
  for (const url of [
    "http://localhost:8765", "http://127.0.0.1", "http://127.0.0.1:0",
    "http://127.0.0.1:65536", "http://127.0.0.1:08765",
    "http://127.0.0.1:8765/", "http://127.0.0.1:8765/v1/packet",
    "http://127.0.0.1:8765?x=1", "http://127.0.0.1:8765#x",
    "https://127.0.0.1:8765", "http://127.0.0.1.evil:8765",
    "http://user@127.0.0.1:8765", "http://2130706433:8765"
  ]) assert.throws(function () { core.validateConnection(Object.assign({}, connection, { base_url: url })); });
  assert.throws(function () { core.validateConnection(Object.assign({}, connection, { extra: true })); });
  assert.throws(function () { core.validateConnection(Object.assign({}, connection, { token: "x\r\nsecret" })); });
});

test("background client uses only hardcoded GET route and Bearer, without credentials or redirects", async function () {
  const packet = await core.createPacket("ABC");
  let captured;
  const actual = await api.fetchPacket(connection, async function (url, init) {
    captured = { url: url, init: init };
    return new Response(JSON.stringify(packet), { headers: { "content-type": "application/json" } });
  });
  assert.equal(captured.url, "http://127.0.0.1:8765/v1/packet");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers.Authorization, "Bearer " + connection.token);
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.referrerPolicy, "no-referrer");
  assert.deepEqual(actual, packet);
});

test("bad connection is refused before fetch", async function () {
  let calls = 0;
  await assert.rejects(api.fetchPacket(Object.assign({}, connection, { base_url: "http://evil.test:8765" }),
    function () { calls += 1; }));
  assert.equal(calls, 0);
});

test("invalid hash/API error/content type are rejected", async function () {
  const packet = await core.createPacket("x");
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
  }), { code: "API_HTTP_ERROR" });
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response(JSON.stringify(packet), { headers: { "content-type": "text/html" } });
  }), { code: "API_CONTENT_TYPE" });
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response(JSON.stringify(Object.assign({}, packet, { sha256: "0".repeat(64) })),
      { headers: { "content-type": "application/json" } });
  }), { code: "HASH_MISMATCH" });
});

test("declared and streaming oversize responses are bounded", async function () {
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response("{}", { headers: {
      "content-type": "application/json", "content-length": String(core.MAX_JSON_BYTES + 1)
    } });
  }), { code: "RESPONSE_TOO_LARGE" });
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response("a".repeat(core.MAX_JSON_BYTES + 1), { headers: { "content-type": "application/json" } });
  }), { code: "RESPONSE_TOO_LARGE" });
});

test("invalid UTF-8 and BOM are not silently normalized", async function () {
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } });
  }), { code: "API_IMPORT_ERROR" });
  await assert.rejects(api.fetchPacket(connection, async function () {
    return new Response("\ufeff{}", { headers: { "content-type": "application/json" } });
  }), { code: "API_IMPORT_ERROR" });
});
