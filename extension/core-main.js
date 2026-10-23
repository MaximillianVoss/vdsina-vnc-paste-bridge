/* Standalone bounded queue. Shares only the browser/Node module pattern with
 * the 2026-08-06 local helper; no legacy clipboard or remote-ACK assumptions. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VncPasteCore = api;
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const PACKET_SCHEMA = "vnc-paste-packet/v1";
  const CONNECTION_SCHEMA = "vnc-paste-connection/v1";
  const MAX_BYTES = 32768;
  const MAX_JSON_BYTES = 262144;
  const SESSION_TIMEOUT_MS = 600000;
  const PROVIDER_SETTLE_MS = 4;
  const TARGET_ORIGIN = "https://cp.vdsina.ru";
  const TARGET_PATH = "/static/novnc/start.html";
  const PACKET_KEYS = [
    "schema", "text", "sha256", "utf8_bytes", "code_points", "batch_size",
    "character_delay_ms", "batch_delay_ms", "newline_mode"
  ];
  const DEFAULTS = Object.freeze({
    batch_size: 256, character_delay_ms: 12, batch_delay_ms: 120,
    newline_mode: "reject"
  });
  const encoder = new TextEncoder();

  class PasteError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "PasteError";
      this.code = code;
    }
  }

  function fail(code, message) { throw new PasteError(code, message); }

  function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("INVALID_OBJECT", label + ": требуется JSON-объект.");
    }
    const actual = Object.keys(value).sort();
    const expected = keys.slice().sort();
    if (actual.length !== expected.length ||
        actual.some(function (key, index) { return key !== expected[index]; })) {
      fail("INVALID_KEYS", label + ": набор полей не соответствует контракту.");
    }
  }

  function boundedInteger(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      fail("INVALID_BOUNDS", label + ": вне диапазона " + min + "…" + max + ".");
    }
  }

  function validateText(text, mode) {
    if (typeof text !== "string") fail("INVALID_TEXT", "Текст должен быть строкой.");
    if (mode !== "reject" && mode !== "enter") {
      fail("INVALID_NEWLINE_MODE", "Режим LF должен быть reject либо enter.");
    }
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 10 && mode === "enter") continue;
      if (code < 32 || code > 126) {
        fail("UNSUPPORTED_CHARACTER",
          "Позиция " + (index + 1) + ": допускается печатный ASCII; LF только в явном режиме Enter. CR, Tab и Unicode отклонены.");
      }
    }
    const bytes = encoder.encode(text).byteLength;
    if (bytes > MAX_BYTES) fail("TEXT_TOO_LARGE", "Максимум 32768 UTF-8 байт.");
    return { utf8_bytes: bytes, code_points: text.length };
  }

  async function sha256(text) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      fail("CRYPTO_UNAVAILABLE", "Для SHA-256 нужен Web Crypto.");
    }
    const hash = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text));
    return Array.from(new Uint8Array(hash), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  async function createPacket(text, options) {
    const settings = Object.assign({}, DEFAULTS, options || {});
    exactKeys(settings, Object.keys(DEFAULTS), "Параметры");
    const counts = validateText(text, settings.newline_mode);
    return validatePacket(Object.assign({
      schema: PACKET_SCHEMA, text: text, sha256: await sha256(text),
      utf8_bytes: counts.utf8_bytes, code_points: counts.code_points
    }, settings));
  }

  async function validatePacket(value) {
    exactKeys(value, PACKET_KEYS, "Packet");
    // Capture every field synchronously. Never read the caller's object after
    // the asynchronous digest; text/options may otherwise change mid-validation.
    const snapshot = {};
    PACKET_KEYS.forEach(function (key) { snapshot[key] = value[key]; });
    if (snapshot.schema !== PACKET_SCHEMA) fail("INVALID_SCHEMA", "Неизвестная схема packet.");
    boundedInteger(snapshot.batch_size, 1, 256, "Размер пакета");
    boundedInteger(snapshot.character_delay_ms, 8, 100, "Пауза символа");
    boundedInteger(snapshot.batch_delay_ms, 80, 2000, "Пауза пакета");
    const counts = validateText(snapshot.text, snapshot.newline_mode);
    if (counts.utf8_bytes !== snapshot.utf8_bytes || counts.code_points !== snapshot.code_points) {
      fail("COUNT_MISMATCH", "Размер или число символов не совпадает с текстом.");
    }
    if (typeof snapshot.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.sha256) ||
        await sha256(snapshot.text) !== snapshot.sha256) {
      fail("HASH_MISMATCH", "SHA-256 не совпадает с исходным текстом.");
    }
    return Object.freeze(snapshot);
  }

  function validateConnection(value) {
    exactKeys(value, ["schema", "base_url", "token"], "Connection");
    const snapshot = { schema: value.schema, base_url: value.base_url, token: value.token };
    if (snapshot.schema !== CONNECTION_SCHEMA) fail("INVALID_SCHEMA", "Неизвестная схема connection.");
    if (typeof snapshot.base_url !== "string") fail("INVALID_URL", "base_url должен быть строкой.");
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(snapshot.base_url);
    if (!match || Number(match[1]) > 65535) {
      fail("INVALID_URL", "Разрешён только http://127.0.0.1:<port>, без пути, параметров и credentials.");
    }
    if (typeof snapshot.token !== "string" || snapshot.token.length < 32 ||
        snapshot.token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(snapshot.token)) {
      fail("INVALID_TOKEN", "Connection содержит неподдерживаемый Bearer token.");
    }
    return Object.freeze(snapshot);
  }

  function isTargetUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === TARGET_ORIGIN && url.pathname === TARGET_PATH &&
        !url.username && !url.password;
    } catch (_) { return false; }
  }

  function describe(packet) {
    const count = packet.code_points;
    const batches = count ? Math.ceil(count / packet.batch_size) : 0;
    const lf = (packet.text.match(/\n/g) || []).length;
    const estimated_ms = count * PROVIDER_SETTLE_MS +
      Math.max(0, count - 1) * packet.character_delay_ms +
      Math.max(0, batches - 1) * packet.batch_delay_ms;
    return Object.freeze({
      utf8_bytes: packet.utf8_bytes, code_points: count, sha256: packet.sha256,
      batches: batches, lf: lf, estimated_ms: estimated_ms,
      timeout_ms: SESSION_TIMEOUT_MS
    });
  }

  function cancelled(signal) {
    if (signal && signal.aborted) fail("STOPPED", "Очередь остановлена.");
  }

  function wait(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new PasteError("STOPPED", "Очередь остановлена."));
        return;
      }
      let timer = null;
      function cleanup() {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      function onAbort() {
        clearTimeout(timer); cleanup();
        reject(new PasteError("STOPPED", "Очередь остановлена."));
      }
      timer = setTimeout(function () { cleanup(); resolve(); }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function sendPacket(value, adapter, options) {
    const settings = options || {};
    const signal = settings.signal;
    const now = settings.now || function () { return performance.now(); };
    const pause = settings.wait || wait;
    const timeout = settings.timeout_ms === undefined ? SESSION_TIMEOUT_MS : settings.timeout_ms;
    boundedInteger(timeout, 1, SESSION_TIMEOUT_MS, "Таймаут");
    let packet = null;
    let sent = 0;
    let attempts = 0;
    let started = now();

    function progress(state, code, message) {
      const status = Object.freeze({
        state: state, browser_sent: sent, dispatch_attempts: attempts,
        total: packet ? packet.code_points : 0,
        code: code || null, message: message || "",
        remote_verified: false
      });
      if (settings.onProgress) {
        try { settings.onProgress(status); } catch (_) { /* UI is not a receipt. */ }
      }
      return status;
    }

    function guard() {
      cancelled(signal);
      if (now() - started >= timeout) fail("TIMEOUT", "Истёк таймаут. Автоповтора нет.");
      adapter.assertReady();
    }

    try {
      packet = await validatePacket(value);
      if (describe(packet).estimated_ms + 5000 > timeout) {
        fail("DURATION_LIMIT", "Очередь превышает 10 минут. Подготовьте меньший текст.");
      }
      if (!adapter || typeof adapter.assertReady !== "function" ||
          typeof adapter.sendCharacter !== "function" ||
          typeof adapter.pressEnter !== "function") {
        fail("API_UNAVAILABLE", "Публичный интерфейс VNC не подтверждён.");
      }
      started = now();
      guard();
      progress("sending");
      for (let index = 0; index < packet.text.length; index += 1) {
        guard();
        attempts += 1;
        if (packet.text[index] === "\n") await adapter.pressEnter(signal);
        else await adapter.sendCharacter(packet.text[index], signal);
        sent += 1;
        guard();
        progress("sending");
        if (index + 1 < packet.text.length) {
          await pause(packet.character_delay_ms, signal);
          guard();
          if ((index + 1) % packet.batch_size === 0) {
            await pause(packet.batch_delay_ms, signal);
            guard();
          }
        }
      }
      return progress("browser-sent", null,
        "Очередь передана браузером. Получение и выполнение на сервере не подтверждены.");
    } catch (error) {
      const code = error && error.code ? error.code : "DISPATCH_ERROR";
      const state = attempts ? "uncertain" : code === "STOPPED" ? "stopped" : "blocked";
      return progress(state, code, error && error.message ? error.message : "Отправка прервана.");
    }
  }

  return Object.freeze({
    PACKET_SCHEMA: PACKET_SCHEMA, CONNECTION_SCHEMA: CONNECTION_SCHEMA,
    MAX_BYTES: MAX_BYTES, MAX_JSON_BYTES: MAX_JSON_BYTES, DEFAULTS: DEFAULTS,
    SESSION_TIMEOUT_MS: SESSION_TIMEOUT_MS, PROVIDER_SETTLE_MS: PROVIDER_SETTLE_MS,
    TARGET_ORIGIN: TARGET_ORIGIN,
    TARGET_PATH: TARGET_PATH, PasteError: PasteError, exactKeys: exactKeys,
    validateText: validateText, sha256: sha256, createPacket: createPacket,
    validatePacket: validatePacket, validateConnection: validateConnection,
    isTargetUrl: isTargetUrl, describe: describe, wait: wait, sendPacket: sendPacket
  });
}));
