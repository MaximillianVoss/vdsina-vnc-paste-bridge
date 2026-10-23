"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const flag = process.argv.indexOf("--port");
const port = flag < 0 ? 4173 : Number(process.argv[flag + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local harness port.");
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = http.createServer(function (request, response) {
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
  catch (_) { response.writeHead(400); response.end(); return; }
  if (pathname === "/") { response.writeHead(302, { Location: "/tests/harness/index.html" }); response.end(); return; }
  const file = path.resolve(root, "." + pathname);
  const relative = path.relative(root, file);
  const type = types[path.extname(file)];
  if (!type || relative.startsWith("..") || path.isAbsolute(relative) ||
      !(relative.startsWith("extension" + path.sep) || relative.startsWith("tests" + path.sep + "harness" + path.sep))) {
    response.writeHead(404); response.end(); return;
  }
  fs.readFile(file, function (error, data) {
    if (error) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, {
      "Content-Type": type, "Content-Security-Policy": csp,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"
    });
    response.end(data);
  });
});
server.listen(port, "127.0.0.1", function () {
  process.stdout.write("Local mock only: http://127.0.0.1:" + port + "/tests/harness/index.html\n");
});
