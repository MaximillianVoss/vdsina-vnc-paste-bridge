"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extension = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));

test("MV3 permissions are exact loopback API; no cookie/clipboard/storage/CDP access", function () {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  for (const group of manifest.content_scripts) {
    assert.deepEqual(group.matches, [
      "https://cp.vdsina.ru/static/novnc/start.html",
      "https://cp.vdsina.ru/static/novnc/start.html?*"
    ]);
    assert.equal(group.all_frames, false);
    assert.equal(group.run_at, "document_idle");
    for (const file of (group.js || []).concat(group.css || [])) {
      assert.ok(fs.existsSync(path.join(extension, file)));
    }
  }
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[1].world, "ISOLATED");
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
});

test("packaged code has no eval, remote scripts, clipboard, private RFB, WebSocket or persistence calls", function () {
  const files = fs.readdirSync(extension).filter(function (name) { return name.endsWith(".js"); });
  for (const file of files) {
    const source = fs.readFileSync(path.join(extension, file), "utf8");
    assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\s*\(|new\s+WebSocket\s*\(/);
    assert.doesNotMatch(source, /navigator\.clipboard|document\.cookie|chrome\.cookies|chrome\.debugger/);
    assert.doesNotMatch(source, /chrome\.storage|localStorage|sessionStorage|indexedDB/);
    assert.doesNotMatch(source, /_rfbConnectionState|_websocket|_sock\b/);
    assert.doesNotMatch(source, /createElement\s*\(\s*["']script/);
  }
});

test("background rejects untrusted caller and never forwards a page-supplied URL/route", function () {
  const source = fs.readFileSync(path.join(extension, "background.js"), "utf8");
  assert.match(source, /sender\.id !== chrome\.runtime\.id/);
  assert.match(source, /sender\.frameId !== 0/);
  assert.match(source, /VncPasteCore\.isTargetUrl\(sender\.url\)/);
  const api = fs.readFileSync(path.join(extension, "api-client.js"), "utf8");
  assert.match(api, /connection\.base_url \+ "\/v1\/packet"/);
  assert.doesNotMatch(api, /connection\.route|connection\.path|message\.url/);
  assert.doesNotMatch(source + api, /console\.|JSON\.stringify\(connection/);
});
