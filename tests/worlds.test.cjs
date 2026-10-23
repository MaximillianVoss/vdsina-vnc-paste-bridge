"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const extension = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));

// The live Chromium receipt showed core.js only in MAIN despite registration
// in both worlds. Model that observed path deduplication, with separate globals.
function bootstrap(groups) {
  const panels = [];
  const controls = new Map();
  const document = {
    getElementById(id) { return panels.find(panel => panel.id === id) || null; },
    createElement() {
      return {
        setAttribute() {},
        querySelector(selector) {
          if (!controls.has(selector)) controls.set(selector, {
            value: "reject", checked: false, disabled: false,
            addEventListener() {}, setAttribute() {}
          });
          return controls.get(selector);
        }
      };
    },
    body: { appendChild(panel) { panels.push(panel); } }
  };
  let dispatches = 0;
  const worlds = {};
  for (const name of ["MAIN", "ISOLATED"]) {
    worlds[name] = vm.createContext({
      TextEncoder, URL, crypto: webcrypto, AbortController,
      setTimeout, clearTimeout, setInterval, clearInterval, performance,
      location: { href: "https://cp.vdsina.ru/static/novnc/start.html?v=08", origin: "https://cp.vdsina.ru" },
      document, addEventListener() {}, removeEventListener() {},
      postMessage() { dispatches += 1; }
    });
    vm.runInContext("globalThis.top = globalThis", worlds[name]);
  }
  const seen = new Set();
  for (const group of groups) for (const file of group.js || []) {
    if (seen.has(file)) continue;
    seen.add(file);
    vm.runInContext(fs.readFileSync(path.join(extension, file), "utf8"), worlds[group.world], { filename: file });
  }
  return { worlds, panels, controls, dispatches };
}

test("MAIN and ISOLATED use distinct static paths with identical accepted core bytes", () => {
  const main = manifest.content_scripts.find(group => group.world === "MAIN");
  const isolated = manifest.content_scripts.find(group => group.world === "ISOLATED");
  assert.notEqual(main.js[0], isolated.js[0]);
  assert.deepEqual(fs.readFileSync(path.join(extension, main.js[0])), fs.readFileSync(path.join(extension, isolated.js[0])));
});

test("separate-world bootstrap mounts the panel and starts no command", () => {
  const result = bootstrap(manifest.content_scripts);
  for (const name of ["MAIN", "ISOLATED"]) {
    assert.equal(vm.runInContext("VncPasteCore.isTargetUrl(location.href)", result.worlds[name]), true);
  }
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].id, "vpb-widget");
  assert.match(result.panels[0].innerHTML, /Вставка в VNC/);
  assert.match(result.panels[0].innerHTML, /class="vpb-version">1\.1\.0</);
  assert.equal(result.controls.get('[data-vpb="send"]').disabled, true);
  assert.equal(result.controls.get('[data-vpb="enter"]').disabled, true);
  assert.equal(result.dispatches, 0);
});

test("old shared path reproduces the observed pre-mount TypeError", () => {
  const groups = structuredClone(manifest.content_scripts);
  groups.find(group => group.world === "MAIN").js[0] = "core.js";
  assert.throws(() => bootstrap(groups), /reading 'isTargetUrl'/);
});
