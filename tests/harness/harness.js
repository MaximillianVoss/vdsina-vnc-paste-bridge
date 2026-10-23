"use strict";
(function () {
  const output = document.getElementById("mock-output");
  const count = document.getElementById("mock-count");
  let connected = true;
  let generation = 0;
  const record = { text: "", characters: 0, enters: 0, keyEvents: [], dispatchTimes: [] };
  window.VncPasteMock = record;
  function render() {
    output.textContent = record.text || "$ Здесь появится переданный текст…";
    count.textContent = "Получено макетом: " + record.characters + " символов; Enter: " + record.enters;
  }
  document.getElementById("mock-disconnect").addEventListener("click", function () {
    connected = false; generation += 1;
    document.getElementById("status").textContent = "Макет отключён";
  });
  document.getElementById("mock-connect").addEventListener("click", function () {
    connected = true; generation += 1;
    document.getElementById("status").textContent = "Макет подключён";
  });
  document.getElementById("mock-reset").addEventListener("click", function () {
    record.text = ""; record.characters = 0; record.enters = 0;
    record.keyEvents.length = 0; record.dispatchTimes.length = 0; render();
  });
  // Dependency injection belongs only to this local harness. The packaged
  // provider still enforces its real source, keyboard and connection gates.
  VncPasteMainBridge.install(window, { createAdapter: async function () {
    const ownGeneration = generation;
    let disposed = false;
    function assertReady() {
      if (disposed || !connected || generation !== ownGeneration) {
        throw new VncPasteCore.PasteError("MOCK_DISCONNECTED", "Тестовый макет отключён. Нужна новая проверка.");
      }
    }
    return {
      id: crypto.randomUUID(),
      info: { title: "Демонстрационный сервер · без VPS", ip: "192.0.2.10" },
      assertReady: assertReady,
      sendCharacter: async function (value) {
        assertReady();
        if (!/^[\x20-\x7e]$/.test(value)) throw new Error("Макет принимает один ASCII-символ.");
        record.text += value; record.characters += 1;
        record.dispatchTimes.push(performance.now()); render();
      },
      pressEnter: async function (signal) {
        assertReady();
        if (signal && signal.aborted) throw new VncPasteCore.PasteError("STOPPED", "Enter остановлен.");
        record.enters += 1; record.text += "\n"; render();
      },
      dispose: function () { disposed = true; }
    };
  } });
  VncPasteUi.mount(window, { fetchPacket: async function () {
    return { ok: true, packet: await VncPasteCore.createPacket("MOCK_API_PACKET") };
  } });
  render();
}());
