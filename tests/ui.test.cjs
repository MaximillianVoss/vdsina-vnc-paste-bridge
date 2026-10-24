"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const ui = require("../extension/content.js");
const core = require("../extension/core.js");
const bridge = require("../extension/main-bridge.js");

// A small DOM contract stub exercises actual UI handlers and the real message
// bridge. Rendering/layout is checked separately in the local browser harness.
function setup() {
  const controls = new Map();
  const listeners = new Map();
  const requests = [];
  const delivered = [];
  let disconnected = false;
  let panel;
  function control(tag, attributes) {
    const events = new Map();
    const attrs = new Map();
    for (const match of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(match[1], match[2]);
    return {
      value: attrs.get("value") || (tag === "select" ? "reject" : ""),
      disabled: /\sdisabled(?:\s|$)/.test(attributes), checked: false,
      hidden: /\shidden(?:\s|$)/.test(attributes), open: false,
      dataset: {}, files: [], textContent: "",
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) || null; },
      addEventListener(kind, handler) { events.set(kind, handler); },
      async trigger(kind) { const fn = events.get(kind); if (fn) await fn({ target: this }); }
    };
  }
  const document = {
    getElementById(id) { return panel && panel.id === id ? panel : null; },
    createElement() {
      const result = { setAttribute() {}, querySelector(selector) {
        return controls.get(selector.match(/data-vpb="([^"]+)"/)[1]);
      } };
      Object.defineProperty(result, "innerHTML", { set(html) {
        result.html = html;
        for (const match of html.matchAll(/<(\w+)\b([^>]*data-vpb="([^"]+)"[^>]*)>/g)) {
          controls.set(match[3], control(match[1], match[2]));
        }
      } });
      return result;
    },
    body: { appendChild(value) { panel = value; } }
  };
  const window = {
    document, location: { origin: core.TARGET_ORIGIN },
    addEventListener(kind, handler) {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(handler);
    },
    removeEventListener(kind, handler) { if (listeners.has(kind)) listeners.get(kind).delete(handler); },
    postMessage(message) {
      if (message.direction === "request") requests.push(message);
      queueMicrotask(() => {
        for (const fn of listeners.get("message") || []) fn({ data: message, source: window, origin: core.TARGET_ORIGIN });
      });
    }
  };
  const installed = bridge.install(window, { createAdapter: async () => {
    let disposed = false;
    return {
      id: webcrypto.randomUUID(), info: { title: "LOCAL MOCK", ip: "192.0.2.10" },
      assertReady() { if (disconnected || disposed) throw new core.PasteError("MOCK_OFFLINE", "Макет отключён."); },
      sendCharacter(value) { delivered.push(value); },
      pressEnter() { delivered.push("<Enter>"); },
      dispose() { disposed = true; }
    };
  } });
  ui.mount(window);
  async function settled(condition) {
    const limit = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > limit) throw new Error("UI condition timed out.");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { controls, requests, delivered, panel, settled,
    disconnect() { disconnected = true; },
    dispose() { for (const fn of Array.from(listeners.get("pagehide") || [])) fn(); installed.dispose(); } };
}

test("mount and collapse send nothing; all existing selectors remain and aria-expanded follows visibility", async () => {
  const f = setup();
  try {
    for (const name of ["text", "file", "connection", "batch", "char-delay", "batch-delay", "newline", "lf-warning", "ack-label", "ack", "preview", "send", "stop", "enter", "clear", "details", "status", "target", "collapse", "body"]) assert.ok(f.controls.has(name), name);
    assert.equal(f.requests.length, 0);
    assert.equal(f.controls.get("send").disabled, true);
    assert.equal(f.controls.get("enter").disabled, true);
    assert.equal(f.controls.get("advanced").open, false);
    assert.equal(f.controls.get("help").open, false);
    assert.match(f.panel.html, /href="https:\/\/github\.com\/MaximillianVoss\/vdsina-vnc-paste-bridge\/blob\/main\/docs\/USER_GUIDE\.md"[^>]*rel="noopener noreferrer"/);
    assert.match(f.controls.get("send-help").textContent, /Сначала нажмите «Проверить»/);
    assert.equal(f.controls.get("send").getAttribute("aria-describedby"), f.controls.get("send-help").getAttribute("id"));
    await f.controls.get("collapse").trigger("click");
    assert.equal(f.controls.get("body").hidden, true);
    assert.equal(f.controls.get("collapse").getAttribute("aria-expanded"), "false");
    await f.controls.get("collapse").trigger("click");
    assert.equal(f.controls.get("collapse").getAttribute("aria-expanded"), "true");
    assert.equal(f.requests.length, 0);
  } finally { f.dispose(); }
});

test("preview exposes metrics but no transmission; sending updates browser-only progress and requires a new probe for Enter", async () => {
  const f = setup(); const c = f.controls;
  try {
    c.get("text").value = "A(9)";
    await c.get("text").trigger("input");
    assert.equal(c.get("text-count").textContent, "4 символов");
    await c.get("preview").trigger("click");
    assert.deepEqual(f.requests.map(r => r.kind), ["probe"]);
    assert.deepEqual(f.delivered, []);
    assert.equal(c.get("metrics").hidden, false);
    assert.equal(c.get("metric-characters").textContent, "4");
    assert.equal(c.get("metric-batches").textContent, "1");
    assert.equal(c.get("send").disabled, false);
    await c.get("send").trigger("click");
    assert.equal(c.get("text").disabled, true);
    assert.match(c.get("send-help").textContent, /Передача уже идёт/);
    assert.match(c.get("stop-help").textContent, /символы не удаляет/);
    await f.settled(() => c.get("status").dataset.state === "browser-sent");
    assert.equal(f.delivered.join(""), "A(9)");
    assert.equal(c.get("progress-bar").value, 4);
    assert.equal(c.get("progress-count").textContent, "4 / 4");
    assert.match(c.get("progress-bar").getAttribute("aria-valuetext"), /получение сервером не подтверждено/);
    assert.equal(c.get("enter").disabled, true);
    assert.equal(c.get("send").disabled, true);
    assert.match(c.get("status").textContent, /Сверьте строку в консоли/);
    assert.match(c.get("status").textContent, /снова «Проверить», затем «Отдельный Enter»/);
    assert.match(c.get("status").textContent, /Повторная отправка вставит текст ещё раз/);
    assert.match(c.get("enter-help").textContent, /Сначала нажмите «Проверить», даже если текст уже передан/);
    await c.get("preview").trigger("click");
    await c.get("enter").trigger("click");
    await f.settled(() => c.get("status").dataset.state === "browser-sent" && f.delivered.includes("<Enter>"));
    assert.equal(f.delivered.filter(v => v === "<Enter>").length, 1);
    assert.match(c.get("status").textContent, /^Enter передан браузером/);
    assert.match(c.get("status").textContent, /выполнение на сервере ещё не подтверждено/);
    assert.doesNotMatch(c.get("status").textContent, /Для выполнения: снова/);
    assert.deepEqual(f.requests.map(r => r.kind), ["probe", "start", "probe", "enter"]);
  } finally { f.dispose(); }
});

test("LF choice and imported LF packet expose warning/ack; edits revoke acknowledgement and target", async () => {
  const f = setup(); const c = f.controls;
  try {
    c.get("newline").value = "enter";
    await c.get("newline").trigger("change");
    assert.equal(c.get("advanced").open, true);
    assert.equal(c.get("lf-warning").hidden, false);
    assert.equal(c.get("ack-label").hidden, false);
    c.get("text").value = "a\nb";
    await c.get("text").trigger("input");
    await c.get("preview").trigger("click");
    assert.equal(c.get("send").disabled, true);
    assert.match(c.get("send-help").textContent, /разрешите Enter для каждого LF/);
    assert.match(c.get("status").textContent, /LF: он может выполнить строку/);
    assert.doesNotMatch(c.get("status").textContent, /вставляет без Enter/);
    c.get("ack").checked = true;
    await c.get("ack").trigger("change");
    assert.equal(c.get("send").disabled, false);
    assert.match(c.get("send-help").textContent, /Каждый LF нажмёт Enter и может выполнить строку/);
    await c.get("text").trigger("input");
    assert.equal(c.get("ack").checked, false);
    assert.equal(c.get("send").disabled, true);
    assert.equal(c.get("enter").disabled, true);
    c.get("advanced").open = false;
    const packet = await core.createPacket("c\nd", { newline_mode: "enter" });
    const data = new TextEncoder().encode(JSON.stringify(packet));
    c.get("file").files = [{ name: "packet.json", size: data.length, arrayBuffer: async () => data.buffer }];
    await c.get("file").trigger("change");
    assert.equal(c.get("advanced").open, true);
    assert.equal(c.get("text-count").textContent, "3 символов");
    assert.equal(c.get("ack").checked, false);
    assert.deepEqual(f.delivered, []);
    await c.get("preview").trigger("click");
    c.get("ack").checked = true;
    await c.get("ack").trigger("change");
    await c.get("send").trigger("click");
    await f.settled(() => c.get("status").dataset.state === "browser-sent");
    assert.deepEqual(f.delivered, ["c", "<Enter>", "d"]);
    assert.match(c.get("status").textContent, /LF переданы как Enter и могли выполнить строки/);
    assert.match(c.get("status").textContent, /только для оставшейся незавершённой строки, после новой проверки/);
    assert.doesNotMatch(c.get("status").textContent, /Для выполнения: снова/);
  } finally { f.dispose(); }
});

test("Stop preserves the sent prefix; Clear only empties the local field", async () => {
  const f = setup(); const c = f.controls;
  try {
    c.get("text").value = "abcdef";
    c.get("char-delay").value = "100";
    await c.get("text").trigger("input");
    await c.get("preview").trigger("click");
    await c.get("send").trigger("click");
    await f.settled(() => f.delivered.length > 0);
    const sentPrefix = f.delivered.join("");
    assert.ok(sentPrefix.length < 6);
    await c.get("stop").trigger("click");
    await f.settled(() => !c.get("text").disabled);
    assert.equal(c.get("status").dataset.state, "uncertain");
    assert.equal(f.delivered.join(""), sentPrefix);
    assert.equal(c.get("text").value, "abcdef");
    const requestCount = f.requests.length;
    await c.get("clear").trigger("click");
    assert.equal(c.get("text").value, "");
    assert.equal(f.delivered.join(""), sentPrefix);
    assert.equal(f.requests.length, requestCount);
    assert.match(c.get("status").textContent, /Уже введённый в консоль текст не удалён/);
    await c.get("preview").trigger("click");
    assert.equal(c.get("send").disabled, true);
    assert.equal(c.get("enter").disabled, false);
    assert.match(c.get("send-help").textContent, /Поле пустое/);
    assert.equal(f.delivered.join(""), sentPrefix);
  } finally { f.dispose(); }
});

test("disconnect is explicit and leaves no automatic send or retry", async () => {
  const f = setup(); const c = f.controls;
  try {
    c.get("text").value = "abc";
    await c.get("text").trigger("input");
    await c.get("preview").trigger("click");
    f.disconnect();
    await c.get("send").trigger("click");
    await f.settled(() => c.get("status").dataset.state === "uncertain");
    assert.equal(c.get("status-card").dataset.state, "uncertain");
    assert.deepEqual(f.delivered, []);
    assert.equal(f.requests.filter(r => r.kind === "start").length, 1);
    assert.equal(c.get("send").disabled, true);
    assert.equal(c.get("enter").disabled, true);
  } finally { f.dispose(); }
});
