"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");
const provider = require("../extension/provider.js");
const { consoleText, messages, requiresUSShift } = require("./helpers/qemu-us-console.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { fixture, sources, base } = require("./helpers/novnc-fixture.cjs");
const create = f => provider.create(f.document, f.window, f.settings);
const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join("");

test("official QEMU source pins retain modifier mask and US shared-scancode evidence", async () => {
  const folder = path.join(__dirname, "fixtures", "qemu-v7.2.9");
  const pins = JSON.parse(fs.readFileSync(path.join(folder, "SOURCE.safe.json"), "utf8"));
  for (const pin of pins.sources) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(folder, pin.path))).digest("hex"), pin.sha256);
  }
  assert.match(fs.readFileSync(path.join(folder, "vnc.c"), "utf8"), /keysym2scancode\([\s\S]*?& SCANCODE_KEYMASK/);
  assert.match(fs.readFileSync(path.join(folder, "keymaps.h"), "utf8"), /SCANCODE_KEYMASK 0xff/);
  const layout = fs.readFileSync(path.join(folder, "en-us"), "utf8");
  assert.match(layout, /^9 0x0a\r?\nparenleft 0x0a shift/m);
  assert.match(layout, /^Shift_L 0x2a/m);
});

test("real 1.0.4 branch reproduces live '(' to9; 1.0.5 fixes guest punctuation with physical Shift", async () => {
  const source = fs.readFileSync(path.join(__dirname, "fixtures", "legacy-provider-1.0.4.js"), "utf8");
  const context = vm.createContext({ module: { exports: {} }, require: () => core,
    crypto: globalThis.crypto, URL, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const old = context.module.exports;
  const text = 'exec(zlib.decompress(base64.b64decode("QUJD")))';
  const previous = fixture(), oldAdapter = await old.create(previous.document, previous.window, previous.settings);
  for (const character of text) await oldAdapter.sendCharacter(character);
  const corrupted = consoleText(previous.wire);
  assert.match(corrupted.text, /^exec9zlib\.decompress9base64\.b64decode9/);
  assert.notEqual(corrupted.text, text);
  const current = fixture(), adapter = await create(current);
  for (const character of text) await adapter.sendCharacter(character);
  assert.equal(consoleText(current.wire).text, text);
  assert.deepEqual(consoleText(current.wire).heldScans, []);
});

test("six public pins and cached loaded functions confirm once/document without dispatching probes", async () => {
  const f = fixture();
  for (const pin of provider.SOURCE_PINS) {
    const name = pin.path.split("/").pop().split("?")[0];
    assert.equal(await core.sha256(sources[name]), pin.sha256);
  }
  const first = await create(f);
  assert.deepEqual(f.events, []); assert.deepEqual(f.wire, []);
  assert.equal(f.fetches.length, 6); assert.equal(f.loadCount, 1);
  assert.deepEqual(f.fetches.map(item => item.url).sort(), provider.SOURCE_PINS.map(pin => base + pin.path).sort());
  for (const { url, settings } of f.fetches) {
    assert.equal(new URL(url).origin, core.TARGET_ORIGIN);
    assert.equal(settings.credentials, "omit"); assert.equal(settings.redirect, "error");
    assert.equal(settings.cache, "force-cache"); assert.ok(settings.signal instanceof AbortSignal);
  }
  first.dispose();
  const second = await create(f); await second.sendCharacter("A");
  assert.equal(f.fetches.length, 6); assert.equal(f.loadCount, 1);
  assert.deepEqual(f.calls, [], "clipboardSend/sendString is not used");
});

test("actual noVNC keyboard/RFB preserve all95 ASCII, punctuation and repeats on Windows/Mac", async () => {
  for (const options of [{ qemu: true, platform: "windows" }, { qemu: false, platform: "mac" }]) {
    const f = fixture(options), adapter = await create(f);
    const text = ascii + "AAAAaaaa!!!!~~~~''\"\"\\\\[]{}<>|;:$`";
    for (const character of text) await adapter.sendCharacter(character);
    const guest = consoleText(f.wire);
    assert.equal(guest.text, text);
    assert.equal(consoleText(f.wire, { forceClassic: true }).text, text);
    assert.equal(guest.enters, 0);
    assert.deepEqual(guest.heldScans, []);
    const expectedShifted = Array.from(text).filter(requiresUSShift).length;
    assert.equal(guest.shiftPairs, expectedShifted);
    assert.equal(f.events.length, text.length * 2 + expectedShifted * 2);
    for (const event of f.events) {
      const modifier = event.key === "Shift";
      assert.equal(event.code, modifier ? "ShiftLeft" : "Unidentified");
      assert.equal(event.keyCode, modifier ? 16 : 0);
      assert.equal(event.which, modifier ? 16 : 0);
      assert.equal(event.location, modifier ? 1 : 0);
      assert.equal(event.shiftKey, modifier ? event.type === "keydown" : requiresUSShift(event.key));
      assert.equal(event.charCode, 0);
      for (const name of ["ctrlKey", "altKey", "metaKey", "repeat", "isComposing", "bubbles"]) assert.equal(event[name], false);
    }
    assert.deepEqual(Object.keys(f.keyboard._keyDownList), [], "each key fully releases synchronously");
    assert.deepEqual(f.calls, []); assert.equal(f.fields.clipboard_text.value, "");
    assert.equal(f.fetches.length, 6);
  }
});

test("7008 ASCII queue crosses5422 through QEMU guest shift state with no final Enter", { timeout: 120000 }, async t => {
  const f = fixture(), adapter = await create(f), text = ascii.repeat(74).slice(0, 7008);
  const packet = await core.createPacket(text), pauses = [];
  // Advance the real provider's 4 ms timer deterministically; testing thousands
  // of guest key transitions does not require waiting on Windows timer quantum.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete = false;
  const sending = core.sendPacket(packet, adapter, { wait: async ms => { pauses.push(ms); } })
    .finally(() => { complete = true; });
  let ticks = 0;
  while (!complete) {
    assert.ok(ticks++ < 20000, "bounded provider timer progress");
    t.mock.timers.tick(4);
    await new Promise(resolve => setImmediate(resolve));
  }
  const result = await sending;
  assert.equal(result.state, "browser-sent"); assert.equal(result.remote_verified, false);
  assert.equal(result.browser_sent, 7008); assert.equal(result.dispatch_attempts, 7008);
  const guest = consoleText(f.wire);
  assert.equal(guest.text, text); assert.equal(await core.sha256(guest.text), packet.sha256);
  assert.equal(guest.enters, 0); assert.deepEqual(guest.heldScans, []);
  assert.equal(guest.shiftPairs, Array.from(text).filter(requiresUSShift).length);
  assert.equal(messages(f.wire).length, text.length * 2 + guest.shiftPairs * 2);
  assert.equal(pauses.filter(ms => ms === 120).length, 27);
  assert.equal(f.fetches.length, 6); assert.equal(f.loadCount, 1); assert.deepEqual(f.calls, []);
});

test("each mismatched public source or redirect blocks; a failed gate never refetches", async () => {
  for (const bad of provider.SOURCE_PINS) {
    const f = fixture(), original = f.window.fetch;
    f.window.fetch = async (url, settings) => {
      const response = await original(url, settings);
      if (url === base + bad.path) response.text = async () => "changed source";
      return response;
    };
    await assert.rejects(create(f), { code: "KEYBOARD_SOURCE_UNCONFIRMED" });
    await assert.rejects(create(f), { code: "KEYBOARD_SOURCE_UNCONFIRMED" });
    assert.equal(f.fetches.length, 6); assert.deepEqual(f.events, []);
  }
  const f = fixture(); f.window.fetch = async () => ({ status: 200, url: "https://example.invalid/", text: async () => "" });
  await assert.rejects(create(f), { code: "KEYBOARD_SOURCE_UNCONFIRMED" });
  assert.deepEqual(f.wire, []);
});

test("source timeout aborts pending reads and never starts input", async () => {
  const f = fixture(); let signal;
  f.window.fetch = async (_, settings) => { signal = settings.signal; return new Promise(() => {}); };
  await assert.rejects(create(f), { code: "KEYBOARD_SOURCE_TIMEOUT" });
  assert.equal(signal.aborted, true); assert.deepEqual(f.events, []);
});

test("changed prototype before gate and changed capability after gate block before dispatch", async () => {
  const before = fixture(); before.modules.RFB.prototype.sendKey = function () {};
  await assert.rejects(create(before), { code: "KEYBOARD_SOURCE_UNCONFIRMED" });
  for (const mutate of [f => { f.modules.RFB.messages.keyEvent = function () {}; },
    f => { f.modules.RFB.messages.QEMUExtendedKeyEvent = function () {}; },
    f => { f.modules.scancodes.ShiftLeft = 0x36; },
    f => { f.modules.scancodes.Unidentified = 30; }, f => { f.script.textContent += " "; },
    f => { f.script.isConnected = false; }]) {
    const f = fixture(), adapter = await create(f); mutate(f);
    await assert.rejects(adapter.sendCharacter("A"), { code: "KEYBOARD_CAPABILITY_CHANGED" });
    assert.deepEqual(f.events, []);
  }
});

test("history URL or baseURI changes invalidate the chosen target before dispatch", async () => {
  for (const mutate of [f => { f.window.location.href += "&token=changed"; },
    f => { f.document.baseURI = "https://example.invalid/"; }]) {
    const f = fixture(), adapter = await create(f); mutate(f);
    await assert.rejects(adapter.sendCharacter("A"), { code: "TARGET_CHANGED" });
    assert.deepEqual(f.wire, []);
  }
});

test("altered event constructor, inline source and base tag block before input", async () => {
  const event = fixture(), original = event.window.KeyboardEvent;
  event.window.KeyboardEvent = class extends original { constructor(type, settings) { super(type, settings); this.shiftKey = true; } };
  await assert.rejects(create(event), { code: "KEYBOARD_EVENT_UNSUPPORTED" });
  const inline = fixture(); inline.script.textContent += "\n// changed";
  await assert.rejects(create(inline), { code: "KEYBOARD_SOURCE_UNCONFIRMED" });
  const baseTag = fixture(), query = baseTag.document.querySelectorAll;
  baseTag.document.querySelectorAll = selector => selector === "base" ? [{}] : query(selector);
  await assert.rejects(create(baseTag), { code: "KEYBOARD_SOURCE_UNCONFIRMED" });
  for (const f of [event, inline, baseTag]) assert.deepEqual(f.events, []);
});

test("Stop after first actual virtual key cancels the tail with no auto-resume", async () => {
  const f = fixture(), adapter = await create(f), controller = new AbortController();
  const packet = await core.createPacket("ABC".repeat(100));
  const result = await core.sendPacket(packet, adapter, { signal: controller.signal, wait: async () => controller.abort() });
  assert.equal(result.state, "uncertain"); assert.equal(result.code, "STOPPED");
  assert.equal(result.browser_sent, 1); assert.equal(result.remote_verified, false);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(consoleText(f.wire).text, "A");
  assert.deepEqual(consoleText(f.wire).heldScans, []);
});

test("throw or Stop inside a shifted character still releases Shift synchronously", async () => {
  for (const fail of [false, true]) {
    const controller = new AbortController();
    const f = fixture({ onDispatch(event) {
      if (event.key === "(" && event.type === "keydown") {
        controller.abort();
        if (fail) throw new Error("injected dispatch failure");
      }
    } });
    const adapter = await create(f);
    const result = await core.sendPacket(await core.createPacket("(tail"), adapter, { signal: controller.signal, wait: async () => {} });
    assert.equal(result.state, "uncertain");
    const guest = consoleText(f.wire);
    assert.deepEqual(guest.heldScans, []);
    assert.equal(f.events.at(-1).key, "Shift"); assert.equal(f.events.at(-1).type, "keyup");
    assert.equal(guest.text, fail ? "" : "(");
  }
});

test("model exposes guest CapsLock limitation instead of treating keysym as a character", async () => {
  const f = fixture(), adapter = await create(f);
  await adapter.sendCharacter("a");
  assert.equal(consoleText(f.wire, { capsLock: true, lockKeySync: false }).text, "A");
  assert.equal(consoleText(f.wire, { capsLock: false, lockKeySync: false }).text, "a");
});
