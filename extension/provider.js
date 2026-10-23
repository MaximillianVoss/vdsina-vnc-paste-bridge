(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else root.VncPasteProvider = factory(root.VncPasteCore);
}(typeof globalThis === "object" ? globalThis : this, function (core) {
  "use strict";

  const HANDLER_SHA256 = "a339141f01a4c09b3798f232237029fcbceb20d047550bd30cd6b92e1d343562";
  const SOURCE_SHA256 = "e3fac50cd8d1a3d56ed6edeb6e4ef4cd56a89949d5fcc48f77e5b1b42bb7082d";
  const INLINE_SHA256 = "7ba5da367d3fda24f3cc0c3b9f8484b8a16be78e7366ef60157dd2e8a91013d9";
  const SOURCE_TIMEOUT_MS = 2500;
  const SOURCE_PINS = Object.freeze([
    Object.freeze({ path: "start.html?v=08", sha256: SOURCE_SHA256 }),
    Object.freeze({ path: "core/input/keyboard.js", sha256: "f9c77fa3f5400b89cdb64e7e235bd76431a9f3199d8982e36977c9882976c5c5" }),
    Object.freeze({ path: "core/input/util.js", sha256: "43bfb6f255a7030c6ca38749c3ee1a5feeb601e296ff32f6a1d0bd483edfa852" }),
    Object.freeze({ path: "core/rfb.js", sha256: "36a359fb324419b5215d600f3076011105849c0866b4b5f34087f303d8be2d8d" }),
    Object.freeze({ path: "core/input/keysymdef.js", sha256: "76f338d45fb73b7decb7d8b4ef6e95edf7ce9583722c5220642a9be85fc2cc89" }),
    Object.freeze({ path: "core/input/xtscancodes.js", sha256: "f0fc982627e1c02feaac1bd50d7fdd3bcbb05f0062b910d8002f47d1b08967a6" })
  ]);
  const MODULE_PINS = Object.freeze({
    Keyboard: "d323eb5664f3e8eef0b4caed5ca6a4965119710b26494c638f81cf6f59bd5ec5",
    RFB: "1b782b7b1c3b550863ddfed64b335ffb593cc1efc0eeef447b32c4fe4fe2f1c2",
    getKeycode: "bf152b067b5108f79be7586e875644df347285216b2368bc412673312994dab6",
    getKey: "f15a47d0db7135e22408592ecdab5ed3a333e100fd0aae7604ea4b2d7775f4c4",
    getKeysym: "5e2d1e769c192575fafd1661efee88a200be9c3cc5d5a09c825f838aa97a8dc6",
    Keyboard_sendKeyEvent: "684108f7c1f4c475a23a2b593a20b29e33a79cbd7357436775482a765b829236",
    Keyboard_getKeyCode: "417a813abf525cf139d64aca65b592b71411f65b006ad2f64e4ae8a2ed3e88a5",
    Keyboard_handleKeyDown: "d5d9168ed3ebec4f64e42eac64034167152d511c05547b67ad2222dc3631ff36",
    Keyboard_handleKeyUp: "c57f340490bedc7416a674ff5bad2b781bffa8ff986cb4f844f1e0461cd67089",
    Keyboard_grab: "da0025076c043d8aefdb66e90da541b51f60cfe6f1285e793e0c58449d26982d",
    Keyboard_ungrab: "6bb8564ecba3c990db2c0bb992c69f0a11b1f338c3cd3750950695c0eaf5db3b",
    RFB_sendKey: "8802952c30594fde9197183354e3aa5a1b29a4186154888ef7bcddd43f0dbb75",
    RFB_handleKeyEvent: "425e5b64a3d4aeb012697b083c34a06fcd5fd892a7e4404d94b9b227e752ca5a",
    RFB_keyEvent: "4a5623ef7ae0bd267aa1a53d14afb1e3f72017ced6bb3cd4cdb6167c1214c677",
    RFB_QEMUExtendedKeyEvent: "f3174ae9bca46c1d6a98724bfe85f78f77aa1fb65bdaafc939c03e5c922d9abb",
    lookup: "0f548aa3e21f4c44aab193ffffdc6f16b91224f807887166aa14a7e83ce3c982"
  });
  const sourceGates = new WeakMap();

  function unavailable(code, message) { throw new core.PasteError(code, message); }

  function inlineModule(documentObject) {
    const scripts = documentObject.querySelectorAll('script[type="module"]');
    if (scripts.length !== 1 || scripts[0].getAttribute("src") ||
        documentObject.querySelectorAll("base").length !== 0) {
      unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Источник клавиатуры VNC не подтверждён.");
    }
    return scripts[0];
  }

  function needsShift(character) {
    return /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(character);
  }

  function virtualEvent(windowObject, type, key, shifted) {
    const modifier = key === "Shift";
    const shift = modifier ? type === "keydown" : Boolean(shifted);
    const code = modifier ? "ShiftLeft" : "Unidentified";
    const keyCode = modifier ? 16 : 0;
    const location = modifier ? 1 : 0;
    const event = new windowObject.KeyboardEvent(type, {
      key: key, code: code, keyCode: keyCode, charCode: 0, which: keyCode,
      location: location, shiftKey: shift, ctrlKey: false, altKey: false, metaKey: false,
      repeat: false, isComposing: false, bubbles: false, cancelable: true
    });
    if (event.key !== key || event.code !== code || event.keyCode !== keyCode ||
        event.which !== keyCode || event.location !== location || event.shiftKey !== shift || event.ctrlKey ||
        event.altKey || event.metaKey || event.repeat || event.isComposing) {
      unavailable("KEYBOARD_EVENT_UNSUPPORTED", "Браузер изменил контракт виртуальной клавиши.");
    }
    return event;
  }

  async function loadPublicModules() {
    // These exact module URLs have already been loaded by the pinned page before
    // clipboardSend exists. Import only returns their cached public exports.
    const base = core.TARGET_ORIGIN + "/static/novnc/";
    const loaded = await Promise.all([
      import(base + "core/input/keyboard.js"), import(base + "core/input/util.js"),
      import(base + "core/rfb.js"), import(base + "core/input/keysymdef.js"),
      import(base + "core/input/xtscancodes.js")
    ]);
    return { Keyboard: loaded[0].default, util: loaded[1], RFB: loaded[2].default,
      keysyms: loaded[3].default, scancodes: loaded[4].default };
  }

  async function confirmKeyboard(documentObject, windowObject, options) {
    const old = sourceGates.get(documentObject);
    if (old) return old;
    const settings = options || {};
    const checking = (async function () {
      if (!core.isTargetUrl(windowObject.location.href) ||
          new URL(documentObject.baseURI).origin !== core.TARGET_ORIGIN ||
          new URL(documentObject.baseURI).pathname !== core.TARGET_PATH) {
        unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Нужна штатная верхняя страница VDSina VNC.");
      }
      const script = inlineModule(documentObject);
      const scriptText = script.textContent;
      if (await core.sha256(normalizeHandler(scriptText)) !== INLINE_SHA256) {
        unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Код подключения VNC изменился.");
      }
      const controller = new AbortController();
      let deadline;
      const expired = new Promise(function (_, reject) {
        deadline = setTimeout(function () {
          controller.abort();
          reject(new core.PasteError("KEYBOARD_SOURCE_TIMEOUT", "Проверка источников VNC превысила 2,5 секунды. Ввод не начат."));
        }, SOURCE_TIMEOUT_MS);
      });
      let modules;
      try {
        const confirmed = Promise.all([
          Promise.all(SOURCE_PINS.map(async function (pin) {
            const url = core.TARGET_ORIGIN + "/static/novnc/" + pin.path;
            const response = await windowObject.fetch(url, {
              credentials: "omit", redirect: "error", cache: "force-cache", signal: controller.signal
            });
            if (response.status !== 200 || response.url !== url) {
              unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Публичный источник VNC недоступен или перенаправлен.");
            }
            const source = await response.text();
            if (source.length > 262144 || await core.sha256(source) !== pin.sha256) {
              unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "SHA-256 публичного источника VNC изменился.");
            }
          })),
          (settings.loadModules || loadPublicModules)()
        ]);
        modules = (await Promise.race([confirmed, expired]))[1];
      } catch (error) {
        controller.abort();
        if (error instanceof core.PasteError) throw error;
        unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Не удалось подтвердить клавиатурные модули VNC; ввод закрыт.");
      } finally { clearTimeout(deadline); }
      const functions = [
        [modules.Keyboard, MODULE_PINS.Keyboard], [modules.RFB, MODULE_PINS.RFB],
        [modules.util.getKeycode, MODULE_PINS.getKeycode],
        [modules.util.getKey, MODULE_PINS.getKey], [modules.util.getKeysym, MODULE_PINS.getKeysym]
      ];
      for (const item of functions) {
        if (typeof item[0] !== "function" ||
            await core.sha256(normalizeHandler(Function.prototype.toString.call(item[0]))) !== item[1]) {
          unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Загруженный модуль клавиатуры не совпадает с проверенным кодом.");
        }
      }
      const references = [
        [modules.Keyboard.prototype, "_sendKeyEvent", "Keyboard_sendKeyEvent"],
        [modules.Keyboard.prototype, "_getKeyCode", "Keyboard_getKeyCode"],
        [modules.Keyboard.prototype, "_handleKeyDown", "Keyboard_handleKeyDown"],
        [modules.Keyboard.prototype, "_handleKeyUp", "Keyboard_handleKeyUp"],
        [modules.Keyboard.prototype, "grab", "Keyboard_grab"],
        [modules.Keyboard.prototype, "ungrab", "Keyboard_ungrab"],
        [modules.RFB.prototype, "sendKey", "RFB_sendKey"],
        [modules.RFB.prototype, "_handleKeyEvent", "RFB_handleKeyEvent"],
        [modules.RFB.messages, "keyEvent", "RFB_keyEvent"],
        [modules.RFB.messages, "QEMUExtendedKeyEvent", "RFB_QEMUExtendedKeyEvent"],
        [modules.util, "getKeycode", "getKeycode"],
        [modules.util, "getKey", "getKey"], [modules.util, "getKeysym", "getKeysym"],
        [modules.keysyms, "lookup", "lookup"]
      ].map(function (pair) { return { object: pair[0], name: pair[1], value: pair[0][pair[1]], pin: MODULE_PINS[pair[2]] }; });
      for (const ref of references) {
        if (typeof ref.value !== "function" ||
            await core.sha256(normalizeHandler(Function.prototype.toString.call(ref.value))) !== ref.pin) {
          unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "Привязка публичной клавиатурной функции изменена.");
        }
      }
      function checkEvent(event, expected) {
        if (references.some(function (ref) { return ref.object[ref.name] !== ref.value; }) ||
            modules.scancodes.Unidentified !== undefined || modules.scancodes.ShiftLeft !== 0x2a ||
            modules.util.getKeycode(event) !== (expected === 0xffe1 ? "ShiftLeft" : "Unidentified") ||
            modules.util.getKeysym(event) !== expected) {
          unavailable("KEYBOARD_CAPABILITY_CHANGED", "Контракт клавиатуры VNC изменился. Нужна новая проверка.");
        }
      }
      // Pure capability checks: create event objects, never dispatch probe keys.
      for (let code = 32; code <= 126; code += 1) {
        const character = String.fromCharCode(code);
        const event = virtualEvent(windowObject, "keydown", character, needsShift(character));
        if (modules.keysyms.lookup(code) !== code) {
          unavailable("KEYBOARD_SOURCE_UNCONFIRMED", "ASCII keysym mapping не подтверждён.");
        }
        checkEvent(event, code);
      }
      checkEvent(virtualEvent(windowObject, "keydown", "Enter"), 0xff0d);
      checkEvent(virtualEvent(windowObject, "keydown", "Shift"), 0xffe1);
      checkEvent(virtualEvent(windowObject, "keyup", "Shift"), 0xffe1);
      return Object.freeze({ script: script, checkEvent: checkEvent,
        assertCurrent: function () {
          if (inlineModule(documentObject) !== script || !script.isConnected || script.textContent !== scriptText ||
              references.some(function (ref) { return ref.object[ref.name] !== ref.value; }) ||
              modules.scancodes.Unidentified !== undefined || modules.scancodes.ShiftLeft !== 0x2a) {
            unavailable("KEYBOARD_CAPABILITY_CHANGED", "Источник или привязка клавиатуры изменились.");
          }
        } });
    }());
    sourceGates.set(documentObject, checking);
    // A failed document gate is not retried against a possibly changed source.
    // Reload the page explicitly before another source/capability validation.
    return checking;
  }

  function normalizeHandler(source) {
    return source.replace(/\r\n?/g, "\n").split("\n").map(function (line) {
      return line.trim();
    }).join("\n").trim();
  }

  function text(value, limit) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function markerClassState(value) {
    const classes = Array.from(new Set(String(value || "").split(/[\t\n\f\r ]+/).filter(Boolean)));
    return {
      hidden: classes.includes("hidden"),
      stable: classes.filter(function (name) { return name !== "selected"; }).sort().join(" ")
    };
  }

  function targetInfo(documentObject) {
    const info = documentObject.getElementById("info");
    const details = text(info ? info.textContent : "", 240);
    const address = details.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    return Object.freeze({
      title: text(documentObject.title, 160) || "Название сервера неизвестно",
      ip: address ? address[0] : null,
      details: details,
      adapter: "public-canvas-virtual-key",
      handler_sha256: HANDLER_SHA256
    });
  }

  class DomAdapter {
    constructor(documentObject, windowObject, elements, handlerSource, observer, keyboard) {
      this.document = documentObject;
      this.window = windowObject;
      this.elements = elements;
      this.handlerSource = handlerSource;
      this.info = targetInfo(documentObject);
      this.id = crypto.randomUUID();
      this.generationChanged = false;
      this.observer = observer;
      this.keyboard = keyboard;
      this.href = windowObject.location.href;
      this.baseURI = documentObject.baseURI;
    }

    assertReady() {
      const e = this.elements;
      if (!core.isTargetUrl(this.window.location.href) || this.window.location.href !== this.href ||
          this.document.baseURI !== this.baseURI) {
        throw new core.PasteError("TARGET_CHANGED", "Адрес выбранной консоли изменился.");
      }
      this.keyboard.assertCurrent();
      if (this.generationChanged ||
          this.document.getElementById("clipboard_text") !== e.input ||
          this.document.getElementById("clipboard_send_button") !== e.send ||
          this.document.getElementById("clipboard_button") !== e.marker ||
          this.document.getElementById("info") !== e.info ||
          this.document.querySelector("canvas") !== e.canvas ||
          this.document.querySelectorAll("canvas").length !== 1) {
        throw new core.PasteError("CONNECTION_CHANGED", "Страница или соединение изменились. Нужна новая проверка.");
      }
      if (e.marker.classList.contains("hidden") || e.info.style.display !== "block") {
        throw new core.PasteError("DISCONNECTED", "Индикатор провайдера не подтверждает подключение.");
      }
      if (e.send.disabled || e.input.disabled ||
          typeof e.send.onclick !== "function" ||
          normalizeHandler(Function.prototype.toString.call(e.send.onclick)) !== this.handlerSource) {
        throw new core.PasteError("HANDLER_CHANGED", "Обработчик провайдера изменился. Отправка закрыта.");
      }
      const current = targetInfo(this.document);
      if (current.title !== this.info.title || current.details !== this.info.details) {
        throw new core.PasteError("TARGET_CHANGED", "Выбранный сервер изменился.");
      }
      if (e.input.value !== "") {
        throw new core.PasteError("PROVIDER_INPUT_BUSY", "Сначала очистите штатное поле вставки VNC.");
      }
    }

    async sendCharacter(character) {
      if (typeof character !== "string" || !/^[\x20-\x7e]$/.test(character)) {
        throw new core.PasteError("INVALID_CHARACTER", "Provider handler принимает только один печатный ASCII.");
      }
      this.assertReady();
      this.sendVirtual(character, character.charCodeAt(0));
      await core.wait(core.PROVIDER_SETTLE_MS);
      this.assertReady();
    }

    pressEnter() {
      this.assertReady();
      this.sendVirtual("Enter", 0xff0d);
      this.assertReady();
    }

    sendVirtual(key, keysym) {
      const canvas = this.elements.canvas;
      const shifted = needsShift(key);
      const down = virtualEvent(this.window, "keydown", key, shifted);
      const up = virtualEvent(this.window, "keyup", key, shifted);
      this.keyboard.checkEvent(down, keysym);
      this.keyboard.checkEvent(up, keysym);
      const shiftDown = shifted ? virtualEvent(this.window, "keydown", "Shift") : null;
      const shiftUp = shifted ? virtualEvent(this.window, "keyup", "Shift") : null;
      if (shifted) {
        this.keyboard.checkEvent(shiftDown, 0xffe1);
        this.keyboard.checkEvent(shiftUp, 0xffe1);
      }
      canvas.focus();
      // noVNC's virtual-key branch synchronously emits RFB down/up. A false
      // dispatchEvent return is its normal preventDefault, not a delivery ACK.
      // QEMU maps classic keysyms to physical scancodes. A shifted keysym alone
      // does not press Shift in the guest; keep the modifier around this one key.
      // No await separates down/up/cleanup, so Stop never leaves a queued Shift.
      try {
        if (shifted) canvas.dispatchEvent(shiftDown);
        try { canvas.dispatchEvent(down); }
        finally { canvas.dispatchEvent(up); }
      } finally { if (shifted) canvas.dispatchEvent(shiftUp); }
    }

    dispose() { if (this.observer) this.observer.disconnect(); }
  }

  async function create(documentObject, windowObject, options) {
    const e = {
      input: documentObject.getElementById("clipboard_text"),
      send: documentObject.getElementById("clipboard_send_button"),
      marker: documentObject.getElementById("clipboard_button"),
      info: documentObject.getElementById("info"),
      canvas: documentObject.querySelector("canvas")
    };
    if (!e.input || !e.send || !e.marker || !e.info || !e.canvas ||
        documentObject.querySelectorAll("canvas").length !== 1 ||
        typeof e.send.onclick !== "function") {
      throw new core.PasteError("API_UNAVAILABLE", "Подтверждённый интерфейс провайдера не найден.");
    }
    const source = normalizeHandler(Function.prototype.toString.call(e.send.onclick));
    if (await core.sha256(source) !== HANDLER_SHA256) {
      throw new core.PasteError("HANDLER_UNCONFIRMED", "Версия VNC handler не совпадает с проверенным источником.");
    }
    const keyboard = await confirmKeyboard(documentObject, windowObject, options);
    let adapter = null;
    const observer = new windowObject.MutationObserver(function (changes) {
      if (!adapter || !changes.length) return;
      const current = markerClassState(e.marker.getAttribute("class"));
      for (const change of changes) {
        // Info and unknown mutations remain fail closed. The public close handler
        // only removes selected, including a no-op write on subsequent characters.
        if (change.type !== "attributes" || change.target !== e.marker ||
            change.attributeName !== "class" ||
            (change.oldValue !== null && typeof change.oldValue !== "string")) {
          adapter.generationChanged = true;
          return;
        }
        const previous = markerClassState(change.oldValue);
        // Every old value preserves transient hidden states, even when disconnect
        // and reconnect occur before this single observer callback is delivered.
        if (previous.hidden || current.hidden || previous.stable !== current.stable) {
          adapter.generationChanged = true;
          return;
        }
      }
    });
    observer.observe(e.marker, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    observer.observe(e.info, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
    observer.observe(keyboard.script, { childList: true, characterData: true, subtree: true });
    adapter = new DomAdapter(documentObject, windowObject, e, source, observer, keyboard);
    try { adapter.assertReady(); } catch (error) { adapter.dispose(); throw error; }
    return adapter;
  }

  // For a future explicitly confirmed public instance. The current provider
  // keeps RFB in a closure, so production discovery never guesses a global path.
  function createPublicRfbAdapter(rfb, assertConnected) {
    if (!rfb || typeof rfb.sendKey !== "function" || typeof assertConnected !== "function") {
      throw new core.PasteError("API_UNAVAILABLE", "Public RFB instance не подтверждён.");
    }
    function ready() {
      assertConnected();
      if (rfb.viewOnly !== false) {
        throw new core.PasteError("VIEW_ONLY_OR_UNKNOWN", "RFB input permission не подтверждено.");
      }
    }
    function pair(keysym, code) {
      ready();
      rfb.sendKey(keysym, code, true);
      rfb.sendKey(keysym, code, false);
    }
    return Object.freeze({
      assertReady: ready,
      sendCharacter: function (character) {
        if (!/^[\x20-\x7e]$/.test(character)) {
          throw new core.PasteError("INVALID_CHARACTER", "Ожидается один ASCII символ.");
        }
        pair(character.charCodeAt(0), null);
      },
      pressEnter: function () { pair(0xff0d, "Enter"); }
    });
  }

  return Object.freeze({
    HANDLER_SHA256: HANDLER_SHA256, SOURCE_SHA256: SOURCE_SHA256,
    SOURCE_PINS: SOURCE_PINS, MODULE_PINS: MODULE_PINS,
    normalizeHandler: normalizeHandler, create: create,
    createPublicRfbAdapter: createPublicRfbAdapter
  });
}));
