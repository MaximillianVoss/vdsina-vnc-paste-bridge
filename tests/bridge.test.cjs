"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");
const bridge = require("../extension/main-bridge.js");

function setup() {
  const listeners = new Map();
  const output = [];
  const calls = [];
  let disconnected = false;
  const window = {
    location: { origin: core.TARGET_ORIGIN },
    addEventListener: function (kind, fn) { listeners.set(kind, fn); },
    removeEventListener: function (kind) { listeners.delete(kind); },
    postMessage: function (message) { output.push(message); }
  };
  const adapter = {
    id: "target-id", info: { title: "mock", ip: "192.0.2.1" },
    assertReady: function () { if (disconnected) throw new core.PasteError("DISCONNECTED", "offline"); },
    sendCharacter: async function (character) { calls.push(character); },
    pressEnter: function () { calls.push("<Enter>"); },
    dispose: function () {}
  };
  const installed = bridge.install(window, { createAdapter: async function () { return adapter; } });
  const channel = crypto.randomUUID();
  function request(kind, extra, id) {
    const data = Object.assign({
      protocol: bridge.PROTOCOL, direction: "request", channel: channel,
      id: id || crypto.randomUUID(), kind: kind
    }, extra || {});
    return listeners.get("message")({ source: window, origin: core.TARGET_ORIGIN, data: data });
  }
  return { window: window, output: output, calls: calls, adapter: adapter, request: request,
    disconnect: function () { disconnected = true; }, installed: installed, listeners: listeners };
}

test("Start without explicit preview is rejected without dispatch", async function () {
  const f = setup();
  await f.request("start", { target_id: "target-id", packet: await core.createPacket("abc") });
  assert.deepEqual(f.calls, []);
  assert.equal(f.output.at(-1).code, "PREVIEW_REQUIRED");
  f.installed.dispose();
});

test("duplicate request is never replayed; successful state is browser-sent only", async function () {
  const f = setup(); await f.request("probe");
  const id = crypto.randomUUID();
  await f.request("start", { target_id: "target-id", packet: await core.createPacket("abc") }, id);
  assert.deepEqual(f.calls, ["a", "b", "c"]);
  assert.equal(f.output.at(-1).status.state, "browser-sent");
  assert.equal(f.output.at(-1).status.remote_verified, false);
  await f.request("start", { target_id: "target-id", packet: await core.createPacket("abc") }, id);
  assert.equal(f.output.at(-1).code, "DUPLICATE_REQUEST");
  assert.deepEqual(f.calls, ["a", "b", "c"]);
  f.installed.dispose();
});

test("Stop during active queue and reconnect never cause automatic resume", async function () {
  const f = setup(); await f.request("probe");
  f.adapter.sendCharacter = async function (character) {
    f.calls.push(character);
    await new Promise(function (resolve) { setTimeout(resolve, 30); });
  };
  const running = f.request("start", { target_id: "target-id", packet: await core.createPacket("x".repeat(100)) });
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  await f.request("stop");
  await running;
  assert.equal(f.calls.length, 1);
  assert.equal(f.output.at(-1).status.state, "uncertain");
  await new Promise(function (resolve) { setTimeout(resolve, 40); });
  assert.equal(f.calls.length, 1);
  await f.request("start", { target_id: "target-id", packet: await core.createPacket("abc") });
  assert.equal(f.output.at(-1).code, "PREVIEW_REQUIRED");
  f.installed.dispose();
});

test("pagehide stops queue and clears callbacks; no reload resume state is stored", async function () {
  const f = setup(); await f.request("probe");
  const running = f.request("start", { target_id: "target-id", packet: await core.createPacket("abc") });
  f.listeners.get("pagehide")();
  await running;
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners.has("message"), false);
});

test("separate Enter requires current preview and is exactly one pair in adapter", async function () {
  const f = setup(); await f.request("probe");
  await f.request("enter", { target_id: "target-id" });
  assert.deepEqual(f.calls, ["<Enter>"]);
  assert.equal(f.output.at(-1).status.state, "browser-sent");
  await f.request("enter", { target_id: "target-id" });
  assert.equal(f.output.at(-1).code, "PREVIEW_REQUIRED");
  assert.deepEqual(f.calls, ["<Enter>"]);
  f.installed.dispose();
});
