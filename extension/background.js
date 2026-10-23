"use strict";
importScripts("core.js", "api-client.js");

chrome.runtime.onMessage.addListener(function (message, sender, respond) {
  if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !VncPasteCore.isTargetUrl(sender.url)) return false;
  if (!message || message.kind !== "fetch-packet") return false;
  try { VncPasteCore.exactKeys(message, ["kind", "connection"], "Запрос API"); }
  catch (error) { respond({ ok: false, code: error.code, error: error.message }); return false; }
  VncPasteApi.fetchPacket(message.connection).then(function (packet) {
    respond({ ok: true, packet: packet });
  }).catch(function (error) {
    respond({ ok: false, code: error.code || "API_IMPORT_ERROR", error: error.message });
  });
  return true;
});
