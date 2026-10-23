"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const folder = path.join(__dirname, "..", "fixtures", "qemu-v7.2.9");
const source = fs.readFileSync(path.join(folder, "en-us"), "utf8");
const named = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", apostrophe: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", minus: "-", period: ".", slash: "/",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@",
  bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~"
};
const keysyms = new Map(), guest = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^(\S+)\s+(0x[0-9a-f]+)(.*)$/i);
  if (!match) continue;
  const name = match[1], character = name.length === 1 ? name : named[name];
  const symbol = character ? character.charCodeAt(0) : ({ Shift_L: 0xffe1, Shift_R: 0xffe2, Return: 0xff0d })[name];
  if (symbol === undefined) continue;
  const scan = Number(match[2]), shifted = /\bshift\b/.test(match[3]);
  const mods = (shifted ? 0x100 : 0) | (/\baltgr\b/.test(match[3]) ? 0x800 : 0) | (/\bctrl\b/.test(match[3]) ? 0x200 : 0);
  if (!keysyms.has(symbol)) keysyms.set(symbol, []);
  keysyms.get(symbol).push({ scan, mods });
  if (character && scan < 0x80 && !(mods & ~0x100)) {
    if (!guest.has(scan)) guest.set(scan, {});
    guest.get(scan)[shifted ? "shift" : "base"] = character;
  }
}
for (let code = 32; code <= 126; code += 1) assert.ok(keysyms.has(code), "official US layout covers ASCII " + code);

function messages(wire) {
  return wire.map(bytes => {
    assert.ok(bytes.length === 8 || bytes.length === 12);
    const extended = bytes[0] === 255;
    assert.equal(bytes.length, extended ? 12 : 8);
    assert.equal(bytes[0], extended ? 255 : 4);
    if (extended) assert.equal(bytes[1], 0);
    return { down: Boolean(extended ? (bytes[2] << 8) + bytes[3] : bytes[1]),
      symbol: (bytes[4] * 0x1000000) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7],
      explicitScan: extended ? (bytes[8] * 0x1000000) + (bytes[9] << 16) + (bytes[10] << 8) + bytes[11] : null };
  });
}

// Source-backed model of QEMU v7.2.9 graphical console input, then a US guest
// keyboard. This is deliberately NOT chr(keysym): modifiers are separate state.
// Actual provider version/layout/LED features remain a separate live boundary.
function consoleText(wire, options = {}) {
  const pressed = new Set();
  let caps = Boolean(options.capsLock), text = "", enters = 0, shiftPairs = 0;
  const lockSync = options.lockKeySync !== false && !options.ledStateFeature;
  const shifted = () => pressed.has(0x2a) || pressed.has(0x36);
  for (const event of messages(wire)) {
    let scan = event.explicitScan;
    if (scan === null || options.forceClassic) {
      // QEMU lowercases ASCII letter keysyms before its layout lookup.
      const mappedSymbol = event.symbol >= 65 && event.symbol <= 90 ? event.symbol + 32 : event.symbol;
      const mappings = keysyms.get(mappedSymbol);
      assert.ok(mappings, "keysym has QEMU en-us mapping");
      let mapping = mappings[0];
      if (mappings.length > 1) mapping = event.down
        ? mappings.find(item => item.mods === (shifted() ? 0x100 : 0)) || mapping
        : mappings.find(item => pressed.has(item.scan & 0xff)) || mapping;
      scan = mapping.scan & 0xff; // ui/vnc.c masks away SCANCODE_SHIFT.
    }
    if (event.down && lockSync && ((event.symbol >= 65 && event.symbol <= 90) || (event.symbol >= 97 && event.symbol <= 122))) {
      const uppercase = event.symbol >= 65 && event.symbol <= 90;
      if ((caps && uppercase === shifted()) || (!caps && uppercase !== shifted())) caps = !caps;
    }
    if (!event.down) { pressed.delete(scan); continue; }
    pressed.add(scan);
    if (scan === 0x2a || scan === 0x36) { shiftPairs += 1; continue; }
    if (scan === 0x1c) { enters += 1; text += "\n"; continue; }
    const key = guest.get(scan);
    assert.ok(key && key.base, "US guest has physical key " + scan);
    const letter = /^[a-z]$/.test(key.base);
    const shift = letter ? shifted() !== caps : shifted();
    text += shift ? key.shift || key.base : key.base;
  }
  return { text, enters, shiftPairs, heldScans: Array.from(pressed), capsLock: caps };
}

function requiresUSShift(character) {
  const mappings = character.length === 1 ? keysyms.get(character.charCodeAt(0)) : null;
  // First mapping is the ordinary US key. Later entries may include an extra
  // ISO-102 key (e.g. bare '<'), which the ordinary US 101-key mapping lacks.
  return Boolean(mappings && (mappings[0].mods & 0x100) !== 0);
}

module.exports = { consoleText, messages, requiresUSShift };
