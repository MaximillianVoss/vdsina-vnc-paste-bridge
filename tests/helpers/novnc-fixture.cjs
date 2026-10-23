"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const origin = "https://cp.vdsina.ru";
const base = origin + "/static/novnc/";
const sources = Object.fromEntries(["start.html", "keyboard.js", "util.js", "rfb.js", "keysymdef.js", "xtscancodes.js"]
  .map(name => [name, fs.readFileSync(path.join(__dirname, "..", "fixtures", "novnc", name), "utf8")]));

// Execute the saved, hash-bound public function bodies. Only unrelated imported
// browser/logging/DOM tables are stubbed; no network or live RFB is constructed.
function loadModules(platform = "windows") {
  const browser = { isWindows: () => platform === "windows", isMac: () => platform === "mac", isIOS: () => false };
  const context = vm.createContext({
    browser, Log: { Debug() {}, Info() {}, Warn() {}, Error() {} },
    KeyTable: {}, vkeys: {}, fixedkeys: {},
    DOMKeyTable: { Enter: [0xff0d, 0xff0d, 0xff0d, 0xff0d], Shift: [0xffe1, 0xffe1, 0xffe2, 0xffe1] },
    EventTargetMixin: class {}, Uint8Array, setTimeout, clearTimeout,
    stopEvent(event) { event.preventDefault(); event.stopPropagation(); },
    window: { addEventListener() {}, removeEventListener() {} }
  });
  const clean = source => source.replace(/^import .+;\r?\n/gm, "").replace(/\bexport /g, "");
  vm.runInContext(clean(sources["keysymdef.js"]).replace("default {", "const keysyms = {"), context);
  vm.runInContext(clean(sources["xtscancodes.js"]).replace("default {", "const XtScancode = {"), context);
  vm.runInContext(clean(sources["util.js"]), context);
  vm.runInContext("const KeyboardUtil = { getKeycode, getKey, getKeysym };", context);
  vm.runInContext(clean(sources["keyboard.js"]).replace("default class", "class"), context);
  vm.runInContext(clean(sources["rfb.js"]).replace("default class", "class"), context);
  return vm.runInContext("({ Keyboard, RFB, util: KeyboardUtil, keysyms, scancodes: XtScancode })", context);
}

function fixture(options = {}) {
  const modules = loadModules(options.platform);
  const calls = [], events = [], wire = [], fetches = [];
  const observations = new Map();
  let callback, pending = [], queued = false, loadCount = 0;
  function queueMutation(record) {
    if (!observations.has(record.target)) return;
    pending.push(record);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const changes = pending; pending = [];
      if (changes.length) callback(changes);
    });
  }
  function classElement(initial) {
    let value = initial;
    const element = { getAttribute: name => name === "class" ? value : null };
    const tokens = () => value.split(/[\t\n\f\r ]+/).filter(Boolean);
    function write(next) {
      const oldValue = value; value = next;
      queueMutation({ type: "attributes", target: element, attributeName: "class", oldValue });
    }
    element.setAttribute = (name, next) => { assert.equal(name, "class"); write(String(next)); };
    element.classList = {
      contains: name => tokens().includes(name),
      add: name => write(Array.from(new Set(tokens().concat(name))).join(" ")),
      remove: name => write(tokens().filter(token => token !== name).join(" "))
    };
    return element;
  }
  const listeners = new Map();
  const canvas = {
    focus() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) {
      events.push(event);
      if (options.onDispatch) options.onDispatch(event);
      const listener = listeners.get(event.type);
      if (listener) listener(event);
      return !event.defaultPrevented;
    }
  };
  const sock = { _sQ: new Uint8Array(32), _sQlen: 0, flush() {
    wire.push(Array.from(this._sQ.subarray(0, this._sQlen))); this._sQlen = 0;
  } };
  const rfb = Object.create(modules.RFB.prototype);
  Object.assign(rfb, { _rfbConnectionState: "connected", _viewOnly: false,
    _qemuExtKeyEventSupported: options.qemu !== false, _sock: sock });
  const keyboard = new modules.Keyboard(canvas);
  keyboard.onkeyevent = modules.RFB.prototype._handleKeyEvent.bind(rfb);
  keyboard.grab();
  const fields = {
    clipboard_text: { value: "", disabled: false },
    clipboard_send_button: { disabled: false },
    clipboard: classElement("open"), clipboard_button: classElement("btn selected"),
    info: { textContent: "IP: 192.0.2.10", style: { display: "block" } }
  };
  const scriptMatch = sources["start.html"].match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "saved public page contains one inline module");
  const script = { textContent: scriptMatch[1], isConnected: true, getAttribute: () => null };
  const document = {
    title: "TEST-SERVER — local mock", baseURI: base + "start.html?v=08",
    getElementById: id => fields[id], querySelector: selector => selector === "canvas" ? canvas : null,
    querySelectorAll: selector => selector === "canvas" ? [canvas] : selector === 'script[type="module"]' ? [script] : []
  };
  function sendString(value) { calls.push(value); }
  function closeClipboardPanel() { fields.clipboard.classList.remove("open"); fields.clipboard_button.classList.remove("selected"); }
  const handlerMatch = sources["start.html"].match(/function clipboardSend\(e\) \{[\s\S]*?\n                \}/);
  assert.ok(handlerMatch);
  fields.clipboard_send_button.onclick = vm.runInNewContext("(" + handlerMatch[0] + ")", { document, sendString, closeClipboardPanel });
  class Observer {
    constructor(fn) { callback = fn; }
    observe(element, settings) { observations.set(element, settings); }
    disconnect() { observations.clear(); pending = []; }
  }
  class KeyboardEvent {
    constructor(type, settings) { this.type = type; this.defaultPrevented = false; Object.assign(this, settings); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
  }
  const window = {
    location: { href: document.baseURI }, MutationObserver: Observer, KeyboardEvent,
    fetch: async (url, settings) => {
      fetches.push({ url, settings });
      const name = new URL(url).pathname.split("/").pop();
      return { status: 200, url, text: async () => sources[name] };
    }
  };
  const settings = { loadModules: async () => { loadCount += 1; return modules; } };
  return { document, window, fields, script, canvas, keyboard, rfb, modules, calls, events, wire, fetches, settings,
    get loadCount() { return loadCount; },
    flushMutations: async () => { await Promise.resolve(); }, closeClipboardPanel,
    infoMutation() { queueMutation({ type: "attributes", target: fields.info, attributeName: "style", oldValue: null }); },
    scriptMutation() { queueMutation({ type: "childList", target: script }); }
  };
}

module.exports = { fixture, loadModules, sources, base };
