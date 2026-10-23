(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else root.VncPasteApi = factory(root.VncPasteCore);
}(typeof globalThis === "object" ? globalThis : this, function (core) {
  "use strict";

  async function readBounded(response, signal) {
    const declared = response.headers.get("content-length");
    if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > core.MAX_JSON_BYTES)) {
      throw new core.PasteError("RESPONSE_TOO_LARGE", "API ответ превышает допустимый размер.");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new core.PasteError("NO_STREAM", "Потоковый ответ API недоступен.");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new core.PasteError("API_TIMEOUT", "API import прерван.");
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > core.MAX_JSON_BYTES) {
          throw new core.PasteError("RESPONSE_TOO_LARGE", "API ответ превышает допустимый размер.");
        }
        chunks.push(item.value);
      }
    } finally {
      if (size > core.MAX_JSON_BYTES || signal.aborted) await reader.cancel().catch(function () {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  async function fetchPacket(value, fetchImpl) {
    const connection = core.validateConnection(value);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 5000);
    try {
      const response = await (fetchImpl || fetch)(connection.base_url + "/v1/packet", {
        method: "GET", headers: { Authorization: "Bearer " + connection.token },
        credentials: "omit", redirect: "error", cache: "no-store",
        referrerPolicy: "no-referrer", signal: controller.signal
      });
      if (!response.ok) throw new core.PasteError("API_HTTP_ERROR", "API вернул HTTP " + response.status + ".");
      const type = response.headers.get("content-type") || "";
      if (!/^application\/json(?:\s*;|$)/i.test(type)) {
        throw new core.PasteError("API_CONTENT_TYPE", "API должен вернуть application/json.");
      }
      return await core.validatePacket(JSON.parse(await readBounded(response, controller.signal)));
    } catch (error) {
      if (controller.signal.aborted) throw new core.PasteError("API_TIMEOUT", "Таймаут API. Автоповтора нет.");
      if (error instanceof core.PasteError) throw error;
      throw new core.PasteError("API_IMPORT_ERROR", "Не удалось получить и проверить packet из локального API.");
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({ fetchPacket: fetchPacket });
}));
