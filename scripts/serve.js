/**
 * @fileoverview Local static dev server for the built site.
 *
 * Run: node scripts/serve.js           (http://127.0.0.1:8082)
 *      PORT=9000 node scripts/serve.js
 *      HOST=0.0.0.0 node scripts/serve.js   (expose to the LAN, e.g. a phone)
 *
 * It binds to 127.0.0.1 by default. The first version listened on every
 * interface and joined `req.url` straight onto the repository root, so
 * `curl --path-as-is http://host:8082/../../../etc/passwd` read any file the
 * process could -- from any machine on the network. Every request path is now
 * percent-decoded, resolved against the root and refused with a 404 unless it
 * stays inside it (so `%2e%2e` is caught as well as a literal `..`).
 *
 * Nothing else in the repository starts this server: puppeteer_tests.js and
 * the browser suites each run their own on port 8082. It is a convenience for
 * a human looking at the site, and `serve.test.js` drives it in-process.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 8082;
const DEFAULT_HOST = "127.0.0.1";

const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon"
};

/**
 * Maps a request URL onto a file under `root`, or returns null when the URL
 * cannot be decoded or resolves outside the root. The query string is dropped
 * first so `?x=../..` never reaches the file system; the path is decoded
 * before resolving so an encoded dot segment is normalised like a literal one.
 * @param {string} root Absolute directory the server publishes.
 * @param {string} url The raw `req.url`.
 * @return {?string} Absolute path inside `root`, or null.
 */
function resolveRequestPath(root, url) {
  const rootAbs = path.resolve(root);
  let pathname = String(url || "")
    .split("?")[0]
    .split("#")[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (pathname.indexOf("\0") !== -1) return null;
  const full = path.resolve(rootAbs, "." + (pathname.startsWith("/") ? pathname : "/" + pathname));
  if (full !== rootAbs && full.indexOf(rootAbs + path.sep) !== 0) return null;
  return full;
}

function sendFile(res, filePath, status) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("Error loading file");
      return;
    }
    res.writeHead(status, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0"
    });
    res.end(data);
  });
}

function notFound(res, root) {
  const fallback = path.join(root, "404.html");
  if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) {
    sendFile(res, fallback, 404);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

/**
 * Builds the server without listening, so a test can pick an ephemeral port.
 * @param {string=} root Directory to publish; defaults to the repository.
 * @return {!http.Server}
 */
function createStaticServer(root) {
  const rootAbs = path.resolve(root || DEFAULT_ROOT);
  return http.createServer((req, res) => {
    let filePath = resolveRequestPath(rootAbs, req.url);
    if (!filePath) {
      notFound(res, rootAbs);
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      if (fs.existsSync(indexPath)) filePath = indexPath;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      notFound(res, rootAbs);
      return;
    }
    sendFile(res, filePath, 200);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  createStaticServer(DEFAULT_ROOT).listen(port, host, () => {
    console.log(`Live static server running at http://${host}:${port}`);
  });
}

module.exports = { createStaticServer, resolveRequestPath, DEFAULT_PORT, DEFAULT_HOST };
