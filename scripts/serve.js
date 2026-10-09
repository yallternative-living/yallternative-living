/**
 * @fileoverview Local static server for the built site -- the one a human
 * runs, and the one every browser harness in scripts/ starts for itself.
 *
 * Run: node scripts/serve.js           (http://127.0.0.1:8082)
 *      PORT=9000 node scripts/serve.js     (PORT=0 picks a free port)
 *      HOST=0.0.0.0 node scripts/serve.js   (expose to the LAN, e.g. a phone)
 *
 * It binds to 127.0.0.1 by default. The first version listened on every
 * interface and joined `req.url` straight onto the repository root, so
 * `curl --path-as-is http://host:8082/../../../etc/passwd` read any file the
 * process could -- from any machine on the network. Every request path is now
 * percent-decoded (once), resolved against the root and refused with a 404
 * unless it stays inside it (so `%2e%2e` is caught as well as a literal `..`).
 *
 * Staying inside the root is not enough on its own, because the root is a
 * working copy: it holds `.git/` (a remote URL can carry a token), a local
 * `.env` (.gitignore names it as where secrets live) and whatever else a
 * developer keeps beside the site. So, on top of the containment check:
 *   - any path segment starting with "." is a 404, except a leading
 *     `.well-known/` (security.txt and friends are part of the site);
 *   - so is anything under `node_modules/` and any `*.log` file -- both
 *     git-ignored, both local, neither part of the site;
 *   - those three rules judge each segment the way a case-insensitive,
 *     Windows-style file system would open it (normalizeSegment): lowercased,
 *     trailing dots and spaces dropped, and a segment holding ":" (an NTFS
 *     stream, `x.log::$DATA`) or "~<digit>" (an 8.3 alias, `NODE_M~1`)
 *     refused outright. Matching the exact spelling let `/NODE_MODULES/...`
 *     and `/npm-debug.log.` through on macOS and Windows (red team,
 *     2026-10-09);
 *   - symlinks are resolved and the REAL path must stay inside the real root,
 *     so a link inside the tree cannot publish a file outside it;
 *   - while the socket is bound to a loopback address, a request whose Host
 *     header is not localhost, a 127.x.x.x address, [::1] -- or the name the
 *     server was told to bind (`HOST=vm` -> `Host: vm:8082`) -- is refused
 *     with a 403. Binding to loopback keeps other machines out, but not a web
 *     page the developer has open: DNS rebinding points the attacker's own
 *     hostname at 127.0.0.1, and the browser then sends that hostname as
 *     Host. The decision is made from server.address() -- the numeric address
 *     actually bound -- and not from the string handed to listen(): with
 *     HOST set to a NAME that resolves to loopback (`$(hostname)` is 127.0.1.1
 *     on Debian; tcsh exports HOST on its own) the old string test switched
 *     the check off on a loopback socket (red team, 2026-10-09). Bound to a
 *     non-loopback address (HOST=0.0.0.0, ::, a LAN IP) the LAN is invited in
 *     on purpose and the Host check is off; every other rule stays.
 *
 * A missing file is a real 404 carrying 404.html. /api/* -- the checkout
 * Worker's, never this server's -- answers like a misrouted proxy (see
 * NO_WORKER_HTML), so the site's own lookups take their "unavailable" branch.
 * Responses say `Cache-Control: no-cache`, never `no-store` (see
 * CACHE_HEADERS).
 *
 * The browser harnesses (puppeteer_tests.js, a11y-check.js, every
 * *.browser.test.js ...) build their servers with createStaticServer() and
 * bind them with listenLoopback(). Until 2026-10-09 thirty-six scripts ran a
 * server of their own: thirty-four joined req.url onto the root with
 * path.join (some behind a `startsWith(ROOT)` test, none with the dot-file,
 * node_modules, symlink or Host rules), run_audit.js among them listening on
 * every interface, and the other two used resolveRequestPath but served a
 * symlink's target wherever it pointed (red team). What a harness needs beyond plain
 * files (a stubbed route, a fixture standing in for a generated data file, a
 * CSP read from _headers, a rewritten page) goes through the options below,
 * so it gets every one of the protections above for free. serve.test.js
 * fails if a script in scripts/ starts an HTTP server any other way.
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 8082;
const DEFAULT_HOST = "127.0.0.1";

/* Every type the site and the CMS admin actually serve. Text types carry
   their charset, as Netlify sends them. A harness can add or override with
   the `mimeTypes` option. */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

/* A read that fails with one of these is retried once: a loaded CI runner
   can hand out EMFILE/EAGAIN for a moment (translator-script-order saw it on
   2026-09-09). Anything else, or a second failure, is a 500 naming the code. */
const TRANSIENT_READ_ERRORS = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY"]);

/* The Host header a browser sends for this machine's own loopback server,
   with or without the port. A rebinding page's Host is its own name. Any
   dotted 127.x.x.x is accepted, so binding to 127.0.0.2 still works. */
const LOOPBACK_HOST_HEADER_RE =
  /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])(?::\d{1,5})?$/i;

/* A plain lowercase DNS name (labels of letters, digits and inner hyphens). */
const DNS_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Whether an address is loopback-only: localhost, anything in 127.0.0.0/8
 * or ::1, however it is spelled (127.1, 0:0:0:0:0:0:0:1, ::ffff:127.0.0.1).
 * A fixed list of four spellings used to switch the Host check off for the
 * rest (red team, 2026-10-08). The WHATWG URL parser does the normalising.
 * This judges a STRING; a name such as `vm` that merely resolves to loopback
 * is not loopback here -- which is why the server asks server.address().
 * @param {?string} host An address or name.
 * @return {boolean}
 */
function isLoopbackHost(host) {
  let h = String(host || "")
    .trim()
    .toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return false;
  let hostname;
  try {
    hostname = new URL("http://" + (net.isIPv6(h) ? "[" + h + "]" : h)).hostname;
  } catch (e) {
    return false;
  }
  return (
    hostname === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === "[::1]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
  );
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
 * Whether a server bound at `address` must insist on a loopback Host header.
 * True unless the socket is bound to a non-loopback IP (0.0.0.0, ::, a LAN
 * address) -- and true when the address is unknown (not listening yet, or a
 * pipe), so the check fails closed.
 * @param {?(string|{address: string})} address What server.address() returned.
 * @return {boolean}
 */
function hostCheckRequired(address) {
  if (!address || typeof address !== "object" || !net.isIP(String(address.address))) return true;
  return isLoopbackHost(address.address);
}

/**
 * The DNS name a server was told to bind (HOST=vm), lowercased, or null when
 * it was given an IP literal or nothing. A browser pointed at http://vm:8082
 * sends `Host: vm:8082`, which the Host check must accept; a rebinding page
 * cannot choose that name, because the developer's own resolver answers it.
 * @param {*} host
 * @return {?string}
 */
function boundHostName(host) {
  const h = String(host == null ? "" : host)
    .trim()
    .toLowerCase();
  return h && !net.isIP(h) && DNS_NAME_RE.test(h) ? h : null;
}

/**
 * Whether a Host header is one a loopback-bound server should answer:
 * a loopback name or address, or exactly `name` (with or without a port).
 * @param {?string} hostHeader
 * @param {?string} name From boundHostName().
 * @return {boolean}
 */
function isAllowedHostHeader(hostHeader, name) {
  if (isLoopbackHostHeader(hostHeader)) return true;
  if (!name || typeof hostHeader !== "string") return false;
  const m = /^([^:[\]]+)(?::\d{1,5})?$/.exec(hostHeader);
  return !!m && m[1].toLowerCase() === name;
}

/**
 * One path segment as a case-insensitive, Windows-style file system would
 * really open it: lowercased, with trailing dots and spaces removed (Win32
 * drops them, so `npm-debug.log.` opens `npm-debug.log`). Returns null for a
 * segment no such file system should be asked about at all: one holding ":"
 * (an NTFS alternate data stream such as `x.log::$DATA`, or a drive-relative
 * name), one holding "~<digit>" (an 8.3 short-name alias such as `NODE_M~1`
 * or `GIT~1`, which opens the long name it abbreviates), or one that is
 * nothing but dots and spaces. On Linux none of this changes which file is
 * opened; it changes which NAME the rules judge, and a rule that judges a
 * spelling the disk ignores is no rule at all on macOS or Windows.
 * @param {string} segment
 * @return {?string}
 */
function normalizeSegment(segment) {
  const s = String(segment);
  if (s.indexOf(":") !== -1 || /~\d/.test(s)) return null;
  const trimmed = s.replace(/[. ]+$/, "");
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Returns `full` relative to `rootAbs` when it lies inside the root and no
 * segment of it is hidden (starts with "."), apart from a leading
 * `.well-known`, is `node_modules`, or is a `*.log` file -- each judged on
 * its normalizeSegment() form -- otherwise null. Works on an already-resolved
 * path, so "." and ".." segments are gone by the time the segments are
 * inspected.
 * @param {string} rootAbs Absolute root directory.
 * @param {string} full Absolute candidate path.
 * @return {?string} The relative path ("" for the root itself), or null.
 */
function publicRelativePath(rootAbs, full) {
  if (full !== rootAbs && full.indexOf(rootAbs + path.sep) !== 0) return null;
  const rel = path.relative(rootAbs, full);
  if (!rel) return "";
  const segments = rel.split(path.sep).map(normalizeSegment);
  if (segments.indexOf(null) !== -1) return null;
  if (/\.log$/.test(segments[segments.length - 1])) return null;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "node_modules") return null;
    if (segments[i].charAt(0) !== ".") continue;
    if (i === 0 && segments[i] === ".well-known") continue;
    return null;
  }
  return rel;
}

/**
 * The request path of a raw `req.url`: query string and fragment dropped
 * (so `?x=../..` never reaches the file system), percent-decoded exactly
 * once, with a leading "/". Null when it cannot be decoded or holds a NUL.
 * @param {string} url
 * @return {?string}
 */
function decodeRequestPath(url) {
  let pathname = String(url || "")
    .split("?")[0]
    .split("#")[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (pathname.indexOf("\0") !== -1) return null;
  return pathname.startsWith("/") ? pathname : "/" + pathname;
}

/**
 * Maps an already-DECODED request path onto a file under `rootAbs`, or null
 * when it resolves outside the root or names a hidden path. Taking the
 * decoded form is what keeps a harness's rewrite (ctx.serve) from decoding
 * twice, which would turn `%252e%252e` into `..`.
 * @param {string} rootAbs Absolute root directory.
 * @param {string} pathname
 * @return {?string}
 */
function resolvePathname(rootAbs, pathname) {
  if (typeof pathname !== "string" || pathname.indexOf("\0") !== -1) return null;
  const full = path.resolve(rootAbs, "." + (pathname.startsWith("/") ? pathname : "/" + pathname));
  return publicRelativePath(rootAbs, full) === null ? null : full;
}

/**
 * Maps a request URL onto a file under `root`, or returns null when the URL
 * cannot be decoded, resolves outside the root or names a hidden path.
 * Symlinks are NOT followed here (this is a pure path computation); the
 * server checks the real path before serving.
 * @param {string} root Absolute directory the server publishes.
 * @param {string} url The raw `req.url`.
 * @return {?string} Absolute path inside `root`, or null.
 */
function resolveRequestPath(root, url) {
  const pathname = decodeRequestPath(url);
  return pathname === null ? null : resolvePathname(path.resolve(root), pathname);
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

/* /api/* belongs to the checkout Worker (workers/checkout.js), which shares
   the site's origin in production and never runs behind this server. Such a
   request is answered the way a misrouted proxy would answer it: a 200 with
   a short HTML page. Every caller in main.js already treats a body it cannot
   parse as "unavailable" -- the inventory fetch keeps the static counts, the
   order lookup hands over to a person -- and reads that body to the end.
   That is exactly what the harnesses' own servers used to send (404.html
   with a 200, by accident); here it is on purpose, and only for /api/*.
   Neither status that sounds more honest works: the order lookup reads a 404
   as the Worker saying "no such order", and any 4xx/5xx makes Chromium log
   "Failed to load resource" on every page that asks for live stock -- a
   console error none of the harnesses' servers ever produced. A harness that
   needs a real answer stubs the route with onRequest or Puppeteer
   interception. */
const NO_WORKER_HTML =
  "<!DOCTYPE html><title>No Worker</title><p>/api/* is served by the checkout Worker, " +
  "which is not part of this static server.</p>\n";

/**
 * Whether a decoded request path is one of the Worker's (see NO_WORKER_HTML).
 * @param {string} pathname
 * @return {boolean}
 */
function isWorkerPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/* Every response is revalidated on every use, so an edit shows up on the
   next reload -- but it is `no-cache`, never `no-store`. Measured on
   2026-10-09 with Puppeteer's Chromium: a 4xx response that page script
   never reads (main.js's live-stock fetch reads the body only when res.ok)
   NEVER finishes loading when it says no-store, so `waitUntil:
   "networkidle0"` times out; the same response with no-cache, or with no
   Cache-Control at all, finishes in about a second. Size makes no
   difference. The old serve.js said no-store, and the first cut of the
   shared harness server timed out nine suites on it. */
const CACHE_HEADERS = {
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Expires: "0"
};

/* A file can vanish between realpath and stat; that is a 404, not a crash. */
function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (e) {
    return null;
  }
}

/**
 * Builds the server without listening, so the caller picks the port (see
 * listenLoopback). Everything a harness needs beyond plain files goes through
 * `options`, and every option runs behind the Host check:
 *
 *   host        The address or name the caller is about to listen() on.
 *               Only used to accept that NAME as a Host header (HOST=vm ->
 *               `Host: vm:8082`); whether the Host check runs at all is
 *               decided from server.address() once the socket is bound.
 *   onRequest   function(req, res, ctx) called for every request with a
 *               decodable path, before the file system is touched. Return
 *               true once it has answered `res` (a stubbed /api route, a
 *               fixture standing in for a generated data file); anything
 *               else falls through to the static files. ctx.pathname is the
 *               decoded path ("/" stays "/"); ctx.serve(pathname) answers
 *               with the static file at another DECODED path ("/" ->
 *               "/journal.html") under every rule above.
 *   headers     An object, or function(info) returning one, merged into
 *               every file response -- the 404 page included -- where info
 *               is {pathname, filePath, status} (pathname "" for a URL that
 *               would not decode, filePath null for a 404 with no 404.html).
 *               For a CSP read from _headers, Service-Worker-Allowed and
 *               the like.
 *   transform   function(body, info) -> string|Buffer, applied to 200
 *               responses only (e.g. neutralising a PDP's redirect).
 *   mimeTypes   Extra or overriding {".ext": "type"} entries.
 *
 * A missing file is a 404 carrying the root's 404.html (a one-line body when
 * there is none) -- never 404.html with a 200, which made every link checker
 * built on
 * `status() >= 400` pass vacuously. A directory serves its index.html.
 * /api/* (the Worker's, after onRequest has had its turn) gets NO_WORKER_HTML.
 *
 * @param {string=} root Directory to publish; defaults to the repository.
 * @param {{host: (string|undefined),
 *          onRequest: (function(!http.IncomingMessage, !http.ServerResponse,
 *              {pathname: string, serve: function(string)}): *|undefined),
 *          headers: (Object|function(Object): Object|undefined),
 *          transform: (function(!Buffer, Object): (string|!Buffer)|undefined),
 *          mimeTypes: (Object<string, string>|undefined)}=} options
 * @return {!http.Server}
 */
function createStaticServer(root, options) {
  const opts = options || {};
  const rootAbs = path.resolve(root || DEFAULT_ROOT);
  let realRoot = rootAbs;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch (e) {
    /* A root that does not exist yet serves nothing but 404s. */
  }
  const types = Object.assign({}, MIME_TYPES, opts.mimeTypes || {});
  const allowedName = boundHostName(opts.host);
  // Fail closed until the socket is bound and we know where.
  let checkHostHeader = true;

  function extraHeaders(info) {
    const h = typeof opts.headers === "function" ? opts.headers(info) : opts.headers;
    return h && typeof h === "object" ? h : {};
  }

  function serverError(res, err, label) {
    console.error(`  [serve.js] ${label} -> ${(err && (err.code || err.message)) || err}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Server error: ${(err && (err.code || err.message)) || "unknown"}`);
  }

  function sendFile(res, filePath, status, pathname, attempt) {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (attempt < 2 && TRANSIENT_READ_ERRORS.has(err.code)) {
          setTimeout(() => sendFile(res, filePath, status, pathname, attempt + 1), 50);
          return;
        }
        serverError(res, err, filePath);
        return;
      }
      const info = { pathname, filePath, status };
      let body = data;
      let headers;
      try {
        if (status === 200 && typeof opts.transform === "function") {
          body = opts.transform(data, info);
        }
        headers = Object.assign(
          {
            "Content-Type":
              types[path.extname(filePath).toLowerCase()] || "application/octet-stream"
          },
          CACHE_HEADERS,
          extraHeaders(info)
        );
      } catch (e) {
        serverError(res, e, filePath);
        return;
      }
      res.writeHead(status, headers);
      res.end(body);
    });
  }

  function notFound(res, pathname) {
    const fallback = realPublicPath(realRoot, path.join(realRoot, "404.html"));
    const stat = fallback ? statOrNull(fallback) : null;
    if (stat && stat.isFile()) {
      sendFile(res, fallback, 404, pathname, 1);
      return;
    }
    let headers;
    try {
      headers = extraHeaders({ pathname, filePath: null, status: 404 });
    } catch (e) {
      serverError(res, e, "404");
      return;
    }
    res.writeHead(
      404,
      Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, CACHE_HEADERS, headers)
    );
    res.end("Not found");
  }

  function serveStatic(res, pathname) {
    const requested = resolvePathname(rootAbs, pathname);
    // Everything from here on is judged by where the path REALLY is.
    let filePath = requested ? realPublicPath(realRoot, requested) : null;
    let stat = filePath ? statOrNull(filePath) : null;
    if (stat && stat.isDirectory()) {
      filePath = realPublicPath(realRoot, path.join(filePath, "index.html"));
      stat = filePath ? statOrNull(filePath) : null;
    }
    if (!stat || !stat.isFile()) {
      notFound(res, pathname);
      return;
    }
    sendFile(res, filePath, 200, pathname, 1);
  }

  const server = http.createServer((req, res) => {
    if (checkHostHeader && !isAllowedHostHeader(req.headers.host, allowedName)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden: unexpected Host header");
      return;
    }
    const pathname = decodeRequestPath(req.url);
    if (pathname === null) {
      notFound(res, "");
      return;
    }
    if (typeof opts.onRequest === "function") {
      let handled;
      try {
        handled = opts.onRequest(req, res, {
          pathname,
          serve: (other) => serveStatic(res, other)
        });
      } catch (e) {
        serverError(res, e, "onRequest " + pathname);
        return;
      }
      if (handled) return;
    }
    if (isWorkerPath(pathname)) {
      res.writeHead(
        200,
        Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CACHE_HEADERS, {
          "X-Static-Server": "no-worker"
        })
      );
      res.end(NO_WORKER_HTML);
      return;
    }
    serveStatic(res, pathname);
  });
  server.on("listening", () => {
    checkHostHeader = hostCheckRequired(server.address());
  });
  return server;
}

/**
 * listen()s on 127.0.0.1 and resolves with the server once it is bound, or
 * rejects with the listen error. With `fallbackToEphemeral`, a port that is
 * already taken is replaced by an ephemeral one rather than failing -- the
 * caller then reads the port from server.address(). Never "use whatever is
 * already on that port": that tests somebody else's server, which is how a
 * suite running beside another checkout reported on the wrong tree.
 * @param {!http.Server} server
 * @param {number} port 0 for an ephemeral port.
 * @param {{fallbackToEphemeral: (boolean|undefined)}=} options
 * @return {!Promise<!http.Server>}
 */
function listenLoopback(server, port, options) {
  const fallback = !!(options && options.fallbackToEphemeral);
  return new Promise((resolve, reject) => {
    let retried = false;
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    const onError = (err) => {
      if (fallback && !retried && err && err.code === "EADDRINUSE" && port !== 0) {
        retried = true;
        server.listen(0, DEFAULT_HOST);
        return;
      }
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(err);
    };
    server.on("error", onError);
    server.once("listening", onListening);
    server.listen(port, DEFAULT_HOST);
  });
}

if (require.main === module) {
  const envPort = process.env.PORT;
  const port =
    envPort != null && envPort !== "" && Number.isInteger(Number(envPort))
      ? Number(envPort)
      : DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  const server = createStaticServer(DEFAULT_ROOT, { host });
  server.on("error", (err) => {
    console.error(`serve.js: cannot listen on ${host}:${port} -- ${err.code || err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const shown =
      boundHostName(host) || (net.isIPv6(addr.address) ? `[${addr.address}]` : addr.address);
    console.log(`Live static server running at http://${shown}:${addr.port}`);
    console.log(
      hostCheckRequired(addr)
        ? `Bound to ${addr.address} (loopback): Host header check ON`
        : `Bound to ${addr.address} (reachable from the network): Host header check OFF`
    );
  });
}

module.exports = {
  createStaticServer,
  listenLoopback,
  resolveRequestPath,
  decodeRequestPath,
  normalizeSegment,
  isLoopbackHost,
  isLoopbackHostHeader,
  hostCheckRequired,
  MIME_TYPES,
  DEFAULT_PORT,
  DEFAULT_HOST
};
