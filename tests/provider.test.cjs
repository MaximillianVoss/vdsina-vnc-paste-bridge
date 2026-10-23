"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");
const provider = require("../extension/provider.js");

const { fixture } = require("./helpers/novnc-fixture.cjs");
const { consoleText } = require("./helpers/qemu-us-console.cjs");

test("exact handler fingerprint is required but single virtual chars bypass its timer path", async function () {
  const f = fixture();
  assert.equal(await core.sha256(provider.normalizeHandler(f.fields.clipboard_send_button.onclick.toString())),
    provider.HANDLER_SHA256);
  const adapter = await provider.create(f.document, f.window, f.settings);
  await adapter.sendCharacter("A");
  await adapter.sendCharacter("~");
  assert.deepEqual(f.calls, []);
  assert.equal(consoleText(f.wire).text, "A~");
  assert.deepEqual(consoleText(f.wire).heldScans, []);
  await assert.rejects(adapter.sendCharacter("a".repeat(256)), { code: "INVALID_CHARACTER" });
  assert.equal(f.fields.clipboard_text.value, "");
  assert.equal(adapter.info.ip, "192.0.2.10");
});

test("Enter is a separate keydown/keyup pair and never goes through provider textarea", async function () {
  const f = fixture();
  const adapter = await provider.create(f.document, f.window, f.settings);
  adapter.pressEnter();
  assert.deepEqual(f.events.map(function (e) { return [e.type, e.key, e.code]; }), [
    ["keydown", "Enter", "Unidentified"], ["keyup", "Enter", "Unidentified"]
  ]);
  assert.deepEqual(f.calls, []);
});

test("ordinary panel close selected removal and repeated no-op allow two characters then Enter", async function () {
  const f = fixture();
  const adapter = await provider.create(f.document, f.window, f.settings);
  f.closeClipboardPanel();
  await f.flushMutations();
  await adapter.sendCharacter("A");
  assert.equal(f.fields.clipboard_button.getAttribute("class"), "btn");
  await adapter.sendCharacter("B");
  adapter.pressEnter();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events.filter(event => event.key !== "Shift").map(function (event) { return [event.type, event.key]; }), [
    ["keydown", "A"], ["keyup", "A"], ["keydown", "B"], ["keyup", "B"],
    ["keydown", "Enter"], ["keyup", "Enter"]
  ]);
  assert.equal(adapter.generationChanged, false);
});

test("changed handler, busy provider input, disconnect and reconnect generation fail closed", async function () {
  const changed = fixture();
  changed.fields.clipboard_send_button.onclick = function () {};
  await assert.rejects(provider.create(changed.document, changed.window, changed.settings), { code: "HANDLER_UNCONFIRMED" });
  const busy = fixture(); busy.fields.clipboard_text.value = "do not overwrite";
  await assert.rejects(provider.create(busy.document, busy.window, busy.settings), { code: "PROVIDER_INPUT_BUSY" });
  assert.equal(busy.fields.clipboard_text.value, "do not overwrite");
  const hidden = fixture();
  hidden.fields.clipboard_button.classList.add("hidden");
  await assert.rejects(provider.create(hidden.document, hidden.window, hidden.settings), { code: "DISCONNECTED" });
  const reconnect = fixture();
  const adapter = await provider.create(reconnect.document, reconnect.window, reconnect.settings);
  reconnect.fields.clipboard_button.classList.add("hidden");
  reconnect.fields.clipboard_button.classList.remove("hidden");
  await reconnect.flushMutations();
  assert.equal(reconnect.fields.clipboard_button.classList.contains("hidden"), false);
  assert.throws(function () { adapter.assertReady(); }, { code: "CONNECTION_CHANGED" });
  await assert.rejects(adapter.sendCharacter("B"), { code: "CONNECTION_CHANGED" });
  assert.throws(function () { adapter.pressEnter(); }, { code: "CONNECTION_CHANGED" });
  assert.deepEqual(reconnect.calls, []);
  assert.deepEqual(reconnect.events, []);
});

test("a hidden transition after one character stays blocked after a later reconnect", async function () {
  const f = fixture();
  const adapter = await provider.create(f.document, f.window, f.settings);
  await adapter.sendCharacter("A");
  f.fields.clipboard_button.classList.add("hidden");
  await f.flushMutations();
  assert.throws(function () { adapter.assertReady(); }, { code: "CONNECTION_CHANGED" });
  f.fields.clipboard_button.classList.remove("hidden");
  await f.flushMutations();
  await assert.rejects(adapter.sendCharacter("B"), { code: "CONNECTION_CHANGED" });
  assert.throws(function () { adapter.pressEnter(); }, { code: "CONNECTION_CHANGED" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events.filter(event => event.key !== "Shift").map(event => [event.type, event.key]), [["keydown", "A"], ["keyup", "A"]]);
});

test("only selected and no-op class writes are benign; other transient classes and info fail closed", async function () {
  const f = fixture();
  const adapter = await provider.create(f.document, f.window, f.settings);
  f.fields.clipboard_button.classList.add("selected");
  f.fields.clipboard_button.classList.remove("selected");
  f.fields.clipboard_button.classList.add("selected");
  await f.flushMutations();
  adapter.assertReady();
  f.fields.clipboard_button.classList.add("unexpected");
  f.fields.clipboard_button.classList.remove("unexpected");
  await f.flushMutations();
  assert.throws(function () { adapter.assertReady(); }, { code: "CONNECTION_CHANGED" });
  await assert.rejects(adapter.sendCharacter("A"), { code: "CONNECTION_CHANGED" });
  assert.throws(function () { adapter.pressEnter(); }, { code: "CONNECTION_CHANGED" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events, []);

  const info = fixture();
  const infoAdapter = await provider.create(info.document, info.window, info.settings);
  info.infoMutation();
  await info.flushMutations();
  assert.throws(function () { infoAdapter.assertReady(); }, { code: "CONNECTION_CHANGED" });
  await assert.rejects(infoAdapter.sendCharacter("A"), { code: "CONNECTION_CHANGED" });
  assert.throws(function () { infoAdapter.pressEnter(); }, { code: "CONNECTION_CHANGED" });
  assert.deepEqual(info.calls, []);
  assert.deepEqual(info.events, []);
});

test("target change and multiple canvases are blocked", async function () {
  const f = fixture();
  const adapter = await provider.create(f.document, f.window, f.settings);
  f.document.title = "DIFFERENT SERVER";
  assert.throws(function () { adapter.assertReady(); }, { code: "TARGET_CHANGED" });
  const g = fixture(); g.document.querySelectorAll = function () { return [{}, {}]; };
  await assert.rejects(provider.create(g.document, g.window, g.settings), { code: "API_UNAVAILABLE" });
});

test("known public RFB adapter sends explicit down/up and rejects unknown input permission", function () {
  const calls = [];
  const rfb = { viewOnly: false, sendKey: function () { calls.push(Array.from(arguments)); } };
  const adapter = provider.createPublicRfbAdapter(rfb, function () {});
  adapter.sendCharacter("A"); adapter.pressEnter();
  assert.deepEqual(calls, [[65, null, true], [65, null, false],
    [0xff0d, "Enter", true], [0xff0d, "Enter", false]]);
  rfb.viewOnly = true;
  assert.throws(function () { adapter.sendCharacter("B"); }, { code: "VIEW_ONLY_OR_UNKNOWN" });
});
