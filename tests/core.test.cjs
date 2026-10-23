"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");

function recorder(options) {
  const calls = [];
  let connected = true;
  return {
    calls: calls,
    disconnect: function () { connected = false; },
    assertReady: function () {
      if (!connected) throw new core.PasteError("DISCONNECTED", "disconnected");
    },
    sendCharacter: function (char) { calls.push(char); if (options) options(char, calls.length); },
    pressEnter: function () { calls.push("<Enter>"); }
  };
}
function fakeClock() {
  let time = 0;
  const waits = [];
  return {
    waits: waits, now: function () { return time; },
    wait: async function (ms) { waits.push(ms); time += ms; },
    advance: function (ms) { time += ms; }
  };
}

test("default packet is exact ASCII/UTF-8/hash and logical 256 batches", async function () {
  const packet = await core.createPacket("a".repeat(1024));
  assert.deepEqual(Object.keys(packet), [
    "schema", "text", "sha256", "utf8_bytes", "code_points", "batch_size",
    "character_delay_ms", "batch_delay_ms", "newline_mode"
  ]);
  assert.equal(packet.utf8_bytes, 1024);
  assert.equal(packet.code_points, 1024);
  assert.equal(core.describe(packet).batches, 4);
  assert.equal(packet.sha256, await core.sha256(packet.text));
  const adapter = recorder();
  const clock = fakeClock();
  const result = await core.sendPacket(packet, adapter, clock);
  assert.equal(adapter.calls.join(""), packet.text);
  assert.equal(result.state, "browser-sent");
  assert.equal(result.remote_verified, false);
  assert.equal(clock.waits.filter(function (ms) { return ms === 12; }).length, 1023);
  assert.equal(clock.waits.filter(function (ms) { return ms === 120; }).length, 3);
});

test("printable punctuation survives; final Enter is never appended", async function () {
  const text = "ABC xyz !@#$%^&*()_+-={}[]:'\"\\|<>/?~";
  const adapter = recorder();
  const result = await core.sendPacket(await core.createPacket(text), adapter, fakeClock());
  assert.equal(result.browser_sent, text.length);
  assert.equal(adapter.calls.join(""), text);
  assert.ok(!adapter.calls.includes("<Enter>"));
});

test("LF is rejected by default and only explicitly becomes Enter", async function () {
  await assert.rejects(core.createPacket("a\nb"), { code: "UNSUPPORTED_CHARACTER" });
  const adapter = recorder();
  const packet = await core.createPacket("a\nb\n", { newline_mode: "enter" });
  const result = await core.sendPacket(packet, adapter, fakeClock());
  assert.equal(result.state, "browser-sent");
  assert.deepEqual(adapter.calls, ["a", "<Enter>", "b", "<Enter>"]);
});

test("CR Tab all control/non-ASCII and malformed Unicode fail before dispatch", async function () {
  for (const text of ["\r", "\r\n", "\t", "\0", "\x7f", "рус", "é", "😀", "\ud800"]) {
    await assert.rejects(core.createPacket(text, { newline_mode: "enter" }), { code: "UNSUPPORTED_CHARACTER" });
  }
  await assert.rejects(core.createPacket("x".repeat(32769)), { code: "TEXT_TOO_LARGE" });
});

test("exact fields, hash, counts and integral safety bounds are verified", async function () {
  const original = await core.createPacket("x");
  for (const change of [
    { extra: 1 }, { schema: "bad" }, { sha256: "0".repeat(64) }, { utf8_bytes: 0 },
    { code_points: true }, { batch_size: 257 }, { batch_size: 0 }, { batch_size: 1.5 },
    { character_delay_ms: 7 }, { character_delay_ms: 101 }, { batch_delay_ms: 79 },
    { batch_delay_ms: 2001 }, { newline_mode: "auto" }
  ]) await assert.rejects(core.validatePacket(Object.assign({}, original, change)));
  const missing = Object.assign({}, original); delete missing.sha256;
  await assert.rejects(core.validatePacket(missing), { code: "INVALID_KEYS" });
});

test("corrupt packet and missing API block with zero attempted dispatch", async function () {
  const packet = await core.createPacket("abc");
  const adapter = recorder();
  const bad = await core.sendPacket(Object.assign({}, packet, { text: "abd" }), adapter, fakeClock());
  assert.equal(bad.state, "blocked");
  assert.equal(bad.dispatch_attempts, 0);
  assert.deepEqual(adapter.calls, []);
  assert.equal((await core.sendPacket(packet, null, fakeClock())).code, "API_UNAVAILABLE");
});

test("caller mutation during pending SHA cannot replace validated bytes or enable LF/Enter", async function () {
  const valid = await core.createPacket("SAFE");
  const mutable = Object.assign({}, valid);
  const adapter = recorder();
  const running = core.sendPacket(mutable, adapter, fakeClock());
  mutable.text = "INJECT\n";
  mutable.sha256 = "0".repeat(64);
  mutable.utf8_bytes = 7;
  mutable.code_points = 7;
  mutable.newline_mode = "enter";
  mutable.batch_size = 1;
  mutable.character_delay_ms = 100;
  mutable.batch_delay_ms = 2000;
  mutable.schema = "invalid";
  const result = await running;
  assert.equal(result.state, "browser-sent");
  assert.equal(result.total, 4);
  assert.equal(result.browser_sent, 4);
  assert.deepEqual(adapter.calls, ["S", "A", "F", "E"]);
  assert.ok(!adapter.calls.includes("<Enter>"));
});

test("validation returns the frozen original packet even if every caller field changes during digest", async function () {
  const valid = await core.createPacket("A\nB", { newline_mode: "enter" });
  const mutable = Object.assign({}, valid);
  const pending = core.validatePacket(mutable);
  Object.keys(mutable).forEach(function (key) { mutable[key] = null; });
  mutable.unexpected = "late field";
  const checked = await pending;
  assert.deepEqual(checked, valid);
  assert.equal(Object.isFrozen(checked), true);
  assert.notEqual(checked, mutable);
});

test("Stop cancels tail and completion never resumes automatically", async function () {
  const controller = new AbortController();
  const adapter = recorder();
  const result = await core.sendPacket(await core.createPacket("x".repeat(1024)), adapter,
    Object.assign(fakeClock(), { signal: controller.signal, onProgress: function (p) {
      if (p.browser_sent === 3) controller.abort();
    } }));
  assert.equal(result.state, "uncertain");
  assert.equal(result.code, "STOPPED");
  assert.equal(result.browser_sent, 3);
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  assert.equal(adapter.calls.length, 3);
});

test("already-aborted Start is stopped without dispatch", async function () {
  const controller = new AbortController(); controller.abort();
  const adapter = recorder();
  const result = await core.sendPacket(await core.createPacket("abc"), adapter,
    Object.assign(fakeClock(), { signal: controller.signal }));
  assert.equal(result.state, "stopped");
  assert.deepEqual(adapter.calls, []);
});

test("disconnect during a batch stops before the next character", async function () {
  let adapter;
  adapter = recorder(function (_, n) { if (n === 2) adapter.disconnect(); });
  const result = await core.sendPacket(await core.createPacket("abcdef"), adapter, fakeClock());
  assert.equal(result.state, "uncertain");
  assert.equal(result.code, "DISCONNECTED");
  assert.equal(result.browser_sent, 2);
  assert.deepEqual(adapter.calls, ["a", "b"]);
});

test("hard timeout leaves attempted input uncertain and never replays", async function () {
  const clock = fakeClock();
  const adapter = recorder(function () { clock.advance(600001); });
  const result = await core.sendPacket(await core.createPacket("abcdef"), adapter, clock);
  assert.equal(result.state, "uncertain");
  assert.equal(result.code, "TIMEOUT");
  assert.equal(adapter.calls.length, 1);
});

test("duration bound is enforced before any remote side effect", async function () {
  const packet = await core.createPacket("a".repeat(400), {
    batch_size: 1, character_delay_ms: 100, batch_delay_ms: 2000
  });
  const adapter = recorder();
  const result = await core.sendPacket(packet, adapter, fakeClock());
  assert.equal(result.state, "blocked");
  assert.equal(result.code, "DURATION_LIMIT");
  assert.deepEqual(adapter.calls, []);
});

test("known provider settle overhead rejects near-limit input before its first character", async function () {
  const packet = await core.createPacket("a".repeat(32768), { character_delay_ms: 17 });
  const clock = fakeClock();
  const adapter = recorder(function () { clock.advance(core.PROVIDER_SETTLE_MS); });
  const d = core.describe(packet);
  assert.equal(d.estimated_ms, 32768 * 4 + 32767 * 17 + 127 * 120);
  assert.ok(d.estimated_ms + 5000 > core.SESSION_TIMEOUT_MS);
  const result = await core.sendPacket(packet, adapter, clock);
  assert.equal(result.state, "blocked");
  assert.equal(result.code, "DURATION_LIMIT");
  assert.equal(result.dispatch_attempts, 0);
  assert.deepEqual(adapter.calls, []);
});

test("maximum default packet fits the bound with provider settle overhead included", async function () {
  const packet = await core.createPacket("a".repeat(32768));
  const clock = fakeClock();
  const adapter = recorder(function () { clock.advance(core.PROVIDER_SETTLE_MS); });
  assert.ok(core.describe(packet).estimated_ms + 5000 < core.SESSION_TIMEOUT_MS);
  const result = await core.sendPacket(packet, adapter, clock);
  assert.equal(result.state, "browser-sent");
  assert.equal(result.browser_sent, 32768);
  assert.equal(clock.now(), core.describe(packet).estimated_ms);
});

test("an exception after attempted key input is uncertain, never verified", async function () {
  const adapter = recorder(function () { throw new Error("keydown failed"); });
  const result = await core.sendPacket(await core.createPacket("abc"), adapter, fakeClock());
  assert.equal(result.state, "uncertain");
  assert.equal(result.dispatch_attempts, 1);
  assert.equal(result.remote_verified, false);
});

test("target accepts exact HTTPS path and its query; rejects lookalikes and frames URLs", function () {
  for (const url of [
    "https://cp.vdsina.ru/static/novnc/start.html",
    "https://cp.vdsina.ru/static/novnc/start.html?v=08"
  ]) assert.equal(core.isTargetUrl(url), true);
  for (const url of [
    "http://cp.vdsina.ru/static/novnc/start.html",
    "https://cp.vdsina.ru.evil.test/static/novnc/start.html",
    "https://cp.vdsina.ru/static/novnc/start.html.other",
    "https://cp.vdsina.ru/static/novnc/start.html/",
    "https://cp.vdsina.ru/another", "about:blank",
    "https://user@cp.vdsina.ru/static/novnc/start.html"
  ]) assert.equal(core.isTargetUrl(url), false);
});
