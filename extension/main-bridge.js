(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./provider.js"));
  } else {
    const api = factory(root.VncPasteCore, root.VncPasteProvider);
    root.VncPasteMainBridge = api;
    if (api && api.allowed(root.location.href) && root.top === root) api.install(root);
  }
}(typeof globalThis === "object" ? globalThis : this, function (core, provider) {
  "use strict";
  const PROTOCOL = "vnc-paste-bridge/v1";

  function allowed(url) { return Boolean(core && core.isTargetUrl(url)); }

  function install(windowObject, options) {
    const settings = options || {};
    const getAdapter = settings.createAdapter || function () {
      return provider.create(windowObject.document, windowObject);
    };
    const origin = windowObject.location.origin;
    let adapter = null;
    let active = null;
    let disposed = false;
    let probing = false;
    const seen = new Set();

    function send(request, kind, value) {
      if (disposed) return;
      windowObject.postMessage(Object.assign({
        protocol: PROTOCOL, direction: "response", channel: request.channel,
        id: request.id, kind: kind
      }, value), origin);
    }
    function reject(request, error) {
      send(request, "result", {
        ok: false, code: error.code || "BRIDGE_ERROR",
        error: error.message || "Связь с VNC недоступна."
      });
    }
    function valid(event) {
      const r = event.data;
      return event.source === windowObject && event.origin === origin &&
        r && r.protocol === PROTOCOL && r.direction === "request" &&
        typeof r.channel === "string" && /^[0-9a-f-]{36}$/.test(r.channel) &&
        typeof r.id === "string" && /^[0-9a-f-]{36}$/.test(r.id) &&
        ["probe", "start", "stop", "enter"].includes(r.kind);
    }
    async function receive(event) {
      if (disposed || !valid(event)) return;
      const request = event.data;
      if (seen.has(request.id)) {
        reject(request, new core.PasteError("DUPLICATE_REQUEST", "Повтор запроса заблокирован."));
        return;
      }
      if (seen.size >= 4096) {
        if (active) active.controller.abort();
        reject(request, new core.PasteError("REQUEST_LIMIT", "Лимит запросов; перезагрузите страницу и выполните новую проверку."));
        return;
      }
      seen.add(request.id);
      try {
        if (request.kind === "stop") {
          core.exactKeys(request, ["protocol", "direction", "channel", "id", "kind"], "Стоп");
          if (active) active.controller.abort();
          send(request, "result", { ok: true, stopped: true, remote_verified: false });
          return;
        }
        if (active || probing) throw new core.PasteError("BUSY", "Очередь или проверка уже активна.");
        if (request.kind === "probe") {
          core.exactKeys(request, ["protocol", "direction", "channel", "id", "kind"], "Probe");
          probing = true;
          if (adapter && adapter.dispose) adapter.dispose();
          adapter = null;
          try { adapter = await getAdapter(); } finally { probing = false; }
          if (disposed) { if (adapter.dispose) adapter.dispose(); return; }
          adapter.assertReady();
          send(request, "result", { ok: true, target_id: adapter.id, target: adapter.info });
          return;
        }
        const keys = ["protocol", "direction", "channel", "id", "kind", "target_id"];
        if (request.kind === "start") keys.push("packet");
        core.exactKeys(request, keys, "Start/Enter");
        if (!adapter || request.target_id !== adapter.id) {
          throw new core.PasteError("PREVIEW_REQUIRED", "Нужна новая проверка текущего соединения.");
        }
        adapter.assertReady();
        const selected = adapter;
        const controller = new AbortController();
        active = { controller: controller, request: request };
        send(request, "result", { ok: true, accepted: true, remote_verified: false });
        let result;
        try {
          if (request.kind === "enter") {
            selected.assertReady();
            if (controller.signal.aborted) throw new core.PasteError("STOPPED", "Enter остановлен.");
            try {
              await selected.pressEnter(controller.signal);
              selected.assertReady();
              result = { state: "browser-sent", browser_sent: 1, total: 1,
                remote_verified: false, message: "Enter передан браузером. Выполнение на сервере не подтверждено." };
            } catch (error) {
              result = { state: "uncertain", browser_sent: 0, total: 1,
                remote_verified: false, code: error.code || "ENTER_ERROR", message: error.message };
            }
          } else {
            result = await core.sendPacket(request.packet, selected, {
              signal: controller.signal,
              onProgress: function (status) { send(request, "progress", { status: status }); }
            });
          }
          send(request, "finished", { status: result });
        } finally {
          active = null;
          if (selected.dispose) selected.dispose();
          adapter = null;
        }
      } catch (error) { reject(request, error); }
    }
    function shutdown() {
      if (active) active.controller.abort();
      if (adapter && adapter.dispose) adapter.dispose();
      disposed = true;
      windowObject.removeEventListener("message", receive);
      windowObject.removeEventListener("pagehide", shutdown);
    }
    windowObject.addEventListener("message", receive);
    windowObject.addEventListener("pagehide", shutdown, { once: true });
    return Object.freeze({ dispose: shutdown });
  }

  return Object.freeze({ PROTOCOL: PROTOCOL, allowed: allowed, install: install });
}));
