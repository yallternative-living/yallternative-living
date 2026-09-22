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
 * Staying inside the root is not enough on its own, because the root is a
 * working copy: it holds `.git/` (a remote URL can carry a token), a local
 * `.env` (.gitignore names it as where secrets live) and whatever else a
 * developer keeps beside the site. So, on top of the containment check:
 *   - any path segment starting with "." is a 404, except a leading
 *     `.well-known/` (security.txt and friends are part of the site);
 *   - symlinks are resolved and the REAL path must stay inside the real root,
 *     so a link inside the tree cannot publish a file outside it;
 *   - while bound to loopback, a request whose Host header is not localhost,
 *     127.0.0.1 or [::1] is refused with a 403. Binding to 127.0.0.1 keeps
 *     other machines out, but not a web page the developer has open: DNS
 *     rebinding points the attacker's own hostname at 127.0.0.1, and the
 *     browser then sends that hostname as Host. With HOST=0.0.0.0 the LAN is
 *     invited in on purpose and the Host check is off; the other two stay.
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

/* Bind addresses that only this machine can reach. */
const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/* The Host header a browser sends for this machine's own loopback server,
   with or without the port. A rebinding page's Host is its own name. */
const LOOPBACK_HOST_HEADER_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/**
 * Whether a bind address is loopback-only.
 * @param {?string} host The address passed to listen().
 * @return {boolean}
 */
function isLoopbackHost(host) {
  return LOOPBACK_BIND_HOSTS.indexOf(String(host || "").toLowerCase()) !== -1;
}

/**
 * Whether a request's Host header names this machine's loopback interface.
 * @param {?string} hostHeader The raw `req.headers.host`.
 * @return {boolean}
 */
function isLoopbackHostHeader(hostHeader) {
  return typeof hostHeader === "string" && LOOPBACK_HOST_HEADER_RE.test(hostHeader);
}

/**
 * Returns `full` relative to `rootAbs` when it lies inside the root and no
 * segment of it is hidden (starts with "."), apart from a leading
 * `.well-known`; otherwise null. Works on an already-resolved path, so "."
 * and ".." segments are gone by the time the segments are inspected.
 * @param {string} rootAbs Absolute root directory.
 * @param {string} full Absolute candidate path.
 * @return {?string} The relative path ("" for the root itself), or null.
 */
function publicRelativePath(rootAbs, full) {
  if (full !== rootAbs && full.indexOf(rootAbs + path.sep) !== 0) return null;
  const rel = path.relative(rootAbs, full);
  if (!rel) return "";
  const segments = rel.split(path.sep);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].charAt(0) !== ".") continue;
    if (i === 0 && segments[i] === ".well-known") continue;
    return null;
  }
  return rel;
}

/**
 * Maps a request URL onto a file under `root`, or returns null when the URL
 * cannot be decoded, resolves outside the root or names a hidden path. The
 * query string is dropped first so `?x=../..` never reaches the file system;
 * the path is decoded before resolving so an encoded dot segment is
 * normalised like a literal one. Symlinks are NOT followed here (this is a
 * pure path computation); the server checks the real path before serving.
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
  return publicRelativePath(rootAbs, full) === null ? null : full;
}

/**
 * Follows symlinks and returns the real path when it is still a public path
 * inside the real root, else null. A missing file (ENOENT), a path through a
 * file (ENOTDIR), a link loop (ELOOP) or an unreadable entry (EACCES) all
 * come back null too: there is nothing this server should send for them.
 * @param {string} realRoot The root, already passed through realpath.
 * @param {string} candidate Absolute path to check.
 * @return {?string}
 */
function realPublicPath(realRoot, candidate) {
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    return null;
  }
  return publicRelativePath(realRoot, real) === null ? null : real;
}

/* A file can vanish between realpath and stat; that is a 404, not a crash. */
function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (e) {
    return null;
  }
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

function notFound(res, realRoot) {
  const fallback = realPublicPath(realRoot, path.join(realRoot, "404.html"));
  const stat = fallback ? statOrNull(fallback) : null;
  if (stat && stat.isFile()) {
    sendFile(res, fallback, 404);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

/**
 * Builds the server without listening, so a test can pick an ephemeral port.
 * @param {string=} root Directory to publish; defaults to the repository.
 * @param {{host: (string|undefined)}=} options `host` is the address the
 *     caller is about to listen() on (default DEFAULT_HOST). While it is
 *     loopback, requests must carry a loopback Host header.
 * @return {!http.Server}
 */
function createStaticServer(root, options) {
  const rootAbs = path.resolve(root || DEFAULT_ROOT);
  let realRoot = rootAbs;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch (e) {
    /* A root that does not exist yet serves nothing but 404s. */
  }
  const bindHost = options && options.host != null ? String(options.host) : DEFAULT_HOST;
  const checkHostHeader = isLoopbackHost(bindHost);
  return http.createServer((req, res) => {
    if (checkHostHeader && !isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: unexpected Host header");
      return;
    }
    const requested = resolveRequestPath(rootAbs, req.url);
    // Everything from here on is judged by where the path REALLY is.
    let filePath = requested ? realPublicPath(realRoot, requested) : null;
    let stat = filePath ? statOrNull(filePath) : null;
    if (stat && stat.isDirectory()) {
      filePath = realPublicPath(realRoot, path.join(filePath, "index.html"));
      stat = filePath ? statOrNull(filePath) : null;
    }
    if (!stat || !stat.isFile()) {
      notFound(res, realRoot);
      return;
    }
    sendFile(res, filePath, 200);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  createStaticServer(DEFAULT_ROOT, { host }).listen(port, host, () => {
    console.log(`Live static server running at http://${host}:${port}`);
  });
}

module.exports = {
  createStaticServer,
  resolveRequestPath,
  isLoopbackHost,
  isLoopbackHostHeader,
  DEFAULT_PORT,
  DEFAULT_HOST
};
