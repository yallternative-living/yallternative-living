/**
 * @fileoverview Node-only tests for scripts/serve.js, the local static server.
 *
 * Builds its own site root in a temp directory (fs.mkdtempSync) with a sentinel
 * file placed OUTSIDE that root, starts the server on an ephemeral loopback
 * port and sends request paths verbatim (http.request does not normalise `..`,
 * and a raw socket certainly does not). Anything that resolves outside the root
 * must get a 404 and never the sentinel's content, while ordinary pages still
 * load. The same goes for hidden paths inside the root (`.git/`, `.env`), for
 * symlinks whose real target is outside the root or hidden, and for a request
 * whose Host header is not loopback (DNS rebinding) while the socket is bound
 * to loopback -- judged from the address actually bound, so a HOST that is a
 * NAME resolving to loopback keeps the check on (proved end to end by running
 * the CLI with a dns.lookup preload). It unit-tests the segment normaliser
 * that stands in for case-insensitive and Windows file systems, checks the
 * no-Worker answer for /api/* and that nothing is sent `no-store`,
 * and drives the harness options (onRequest, headers, transform, mimeTypes,
 * listenLoopback). Nothing is written anywhere near the repository; the
 * fixture is removed in `finally`.
 * Run: node scripts/serve.test.js
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const serve = require("./serve.js");

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const REPO_ROOT = path.resolve(__dirname, "..");
const SENTINEL = "outside-root-secret-" + process.pid;
const INDEX_MARK = "serve-test-fixture-index";
const SUB_MARK = "serve-test-fixture-sub-index";
const NOT_FOUND_MARK = "serve-test-fixture-404";
const GIT_MARK = "serve-test-fixture-git-config";
const ENV_MARK = "serve-test-fixture-env-secret";
const WELL_KNOWN_MARK = "serve-test-fixture-security-txt";

/**
 * GET over http.request. `headers` overrides the defaults -- notably Host,
 * which http.request otherwise sets to "127.0.0.1:<port>".
 */
function get(port, rawPath, headers) {
  return new Promise((resolve, reject) => {
    const opts = { host: "127.0.0.1", port, path: rawPath, method: "GET" };
    if (headers) opts.headers = headers;
    const req = http.request(opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET over a raw socket. `hostLine` is the whole Host header line; pass ""
 * to send an HTTP/1.0 request with no Host header at all.
 */
function rawGet(port, rawPath, hostLine) {
  const host = hostLine === undefined ? "Host: localhost\r\n" : hostLine;
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write("GET " + rawPath + " HTTP/1.0\r\n" + host + "\r\n");
    });
    let data = "";
    sock.on("data", (c) => (data += c));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
  });
}

function listen(server, host) {
  return new Promise((resolve) =>
    server.listen(0, host || "127.0.0.1", () => resolve(server.address().port))
  );
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Runs `node -r <preload> serve.js` with extra env and resolves once it has
 * printed both start-up lines (or after 8s), with the port it reported.
 * @return {!Promise<{child: !ChildProcess, port: number, output: string}>}
 */
function startCli(preload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-r", preload, path.join(__dirname, "serve.js")], {
      env: Object.assign({}, process.env, env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const m = /running at http:\/\/[^\s]+:(\d+)/.exec(output);
      resolve({ child, port: m ? Number(m[1]) : 0, output: output.trim() });
    };
    const timer = setTimeout(finish, 8000);
    const onData = (chunk) => {
      output += chunk;
      if (/Host header check/.test(output)) finish();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", finish);
  });
}

/**
 * Lays out the fixture: <tmp>/site/{index.html,404.html,sub/index.html} and
 * <tmp>/secret.txt one level ABOVE the site root, which is what a traversal
 * of a single `..` from the root would read. Inside the root it adds what a
 * working copy really holds -- .git/config, .env, .well-known/security.txt --
 * and three symlinks: a directory and a file that point OUTSIDE the root,
 * and a public-looking name that points at the hidden .git/config.
 * `symlinks` is false where the platform refuses to create them (Windows
 * without the privilege), and the symlink assertions are skipped there.
 * @return {{tmp: string, site: string, secret: string, symlinks: boolean}}
 */
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yl-serve-test-"));
  const site = path.join(tmp, "site");
  fs.mkdirSync(path.join(site, "sub"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), `<html><body>${INDEX_MARK}</body></html>\n`);
  fs.writeFileSync(path.join(site, "404.html"), `<html><body>${NOT_FOUND_MARK}</body></html>\n`);
  fs.writeFileSync(path.join(site, "sub", "index.html"), `<html><body>${SUB_MARK}</body></html>\n`);
  fs.mkdirSync(path.join(site, ".git"));
  fs.writeFileSync(path.join(site, ".git", "config"), `[remote "origin"] ${GIT_MARK}\n`);
  fs.writeFileSync(path.join(site, ".env"), `API_KEY=${ENV_MARK}\n`);
  fs.mkdirSync(path.join(site, ".well-known"));
  fs.writeFileSync(path.join(site, ".well-known", "security.txt"), WELL_KNOWN_MARK + "\n");
  const secret = path.join(tmp, "secret.txt");
  fs.writeFileSync(secret, SENTINEL + "\n");
  let symlinks = true;
  try {
    fs.symlinkSync(tmp, path.join(site, "escape-dir"), "dir");
    fs.symlinkSync(secret, path.join(site, "escape-file.txt"), "file");
    fs.symlinkSync(path.join(site, ".git", "config"), path.join(site, "config.txt"), "file");
  } catch (e) {
    symlinks = false;
  }
  return { tmp, site, secret, symlinks };
}

(async () => {
  console.log("Running serve.js tests...\n");
  assert(typeof serve.createStaticServer === "function", "serve.js exports createStaticServer");
  assert(typeof serve.resolveRequestPath === "function", "serve.js exports resolveRequestPath");
  assert(serve.DEFAULT_HOST === "127.0.0.1", "server binds to loopback by default");

  const { tmp, site, secret, symlinks } = makeFixture();
  let server = null;
  try {
    // The fixture must exist before anything is asserted about it: a naive
    // path.join(root, req.url) would land exactly on the sentinel.
    assert(
      fs.readFileSync(secret, "utf8").indexOf(SENTINEL) === 0,
      "sentinel file exists outside the site root"
    );
    assert(
      path.resolve(site, "../secret.txt") === secret &&
        fs.existsSync(path.join(site, "..", "secret.txt")),
      "a naive join of /../secret.txt onto the root would reach the sentinel"
    );
    assert(
      fs.existsSync(path.join(site, "index.html")) && fs.existsSync(path.join(site, "404.html")),
      "fixture pages exist"
    );

    // Pure resolver.
    const r = (u) => serve.resolveRequestPath(site, u);
    assert(r("/") === site, "resolveRequestPath: / is the root");
    assert(r("/index.html") === path.join(site, "index.html"), "resolveRequestPath: plain file");
    assert(r("/index.html?v=1#x") === path.join(site, "index.html"), "query and hash are dropped");
    assert(r("/a%20b.html") === path.join(site, "a b.html"), "percent-decoding is applied");
    assert(r("/../secret.txt") === null, "literal .. to the sentinel is refused");
    assert(r("/%2e%2e/secret.txt") === null, "percent-encoded .. to the sentinel is refused");
    assert(r("/..%2fsecret.txt") === null, "encoded slash traversal is refused");
    assert(r("/sub/../../secret.txt") === null, "traversal below a real directory is refused");
    assert(r("/../../../etc/passwd") === null, "deep literal .. traversal is refused");
    assert(r("/%zz") === null, "undecodable path is refused rather than thrown");
    assert(r("/index.html%00.png") === null, "NUL byte is refused");
    assert(r("/sub/..") === site, "a dot segment that stays inside the root is fine");
    assert(r("/.git/config") === null, "resolveRequestPath: .git/ is hidden");
    assert(r("/.env") === null, "resolveRequestPath: .env is hidden");
    assert(r("/%2egit/config") === null, "resolveRequestPath: an encoded leading dot is hidden");
    assert(
      r("/sub/../.env") === null,
      "resolveRequestPath: a hidden name reached via .. is hidden"
    );
    assert(r("/sub/.hidden") === null, "resolveRequestPath: a hidden name below the top is hidden");
    assert(
      r("/.well-known/security.txt") === path.join(site, ".well-known", "security.txt"),
      "resolveRequestPath: a leading .well-known/ is public"
    );
    assert(
      r("/.well-known/.secret") === null,
      "resolveRequestPath: a hidden name inside .well-known/ is still hidden"
    );
    assert(
      r("/sub/.well-known/x.txt") === null,
      "resolveRequestPath: .well-known is only public at the top of the root"
    );

    // Host headers: loopback names (with or without a port) only.
    assert(serve.isLoopbackHost("127.0.0.1") && serve.isLoopbackHost("::1"), "loopback binds");
    assert(!serve.isLoopbackHost("0.0.0.0"), "0.0.0.0 is not a loopback bind");
    // Every spelling of loopback keeps the Host check on (red team, 2026-10-08:
    // a fixed list of four switched it off for 127.0.0.2 and friends).
    for (const h of ["127.0.0.2", "127.1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "LOCALHOST"]) {
      assert(serve.isLoopbackHost(h), JSON.stringify(h) + " is a loopback bind");
    }
    for (const h of ["::", "192.168.1.2", "example.com", "127.0.0.1.nip.io", ""]) {
      assert(!serve.isLoopbackHost(h), JSON.stringify(h) + " is not a loopback bind");
    }
    assert(serve.isLoopbackHostHeader("127.0.0.2:8082"), "Host 127.0.0.2 is loopback");
    // Git-ignored local files that are not dot-files are not part of the site.
    assert(
      r("/node_modules/x/package.json") === null,
      "resolveRequestPath: node_modules/ is hidden"
    );
    assert(
      r("/sub/node_modules/a.js") === null,
      "resolveRequestPath: a nested node_modules/ is hidden"
    );
    assert(r("/debug.log") === null, "resolveRequestPath: *.log files are hidden");
    assert(
      r("/catalog.html") === path.join(site, "catalog.html"),
      "...a name merely containing 'log' is not"
    );
    for (const h of ["localhost", "localhost:8082", "LOCALHOST:1", "127.0.0.1", "[::1]:8082"]) {
      assert(serve.isLoopbackHostHeader(h), "Host " + h + " is loopback");
    }
    for (const h of [
      undefined,
      "",
      "evil.example",
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "evil.example:8082",
      "localhost:8082@evil.example"
    ]) {
      assert(!serve.isLoopbackHostHeader(h), "Host " + JSON.stringify(h) + " is not loopback");
    }

    // Whether the Host check runs is decided from server.address() -- the
    // numeric address actually bound -- and fails closed when that is unknown.
    // (A missing export fails its own assertion and skips only the cases that
    // could not tell "off" from "absent"; nothing below crashes the run.)
    assert(typeof serve.hostCheckRequired === "function", "serve.js exports hostCheckRequired");
    if (typeof serve.hostCheckRequired === "function") {
      for (const a of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"]) {
        assert(
          serve.hostCheckRequired({ address: a, family: "IPv4", port: 1 }),
          "bound to " + a + ": Host check on"
        );
      }
      for (const a of ["0.0.0.0", "::", "192.0.2.2", "fe80::1"]) {
        assert(
          !serve.hostCheckRequired({ address: a, family: "IPv4", port: 1 }),
          "bound to " + a + ": Host check off (the network is invited in)"
        );
      }
      for (const a of [null, undefined, "/tmp/serve.sock", { address: "vm" }, { address: "" }]) {
        assert(
          serve.hostCheckRequired(a),
          "address " + JSON.stringify(a) + ": Host check fails closed"
        );
      }
    }

    // Case-insensitive and Windows file systems open names the byte-exact
    // rules never saw (red team, 2026-10-09): /NODE_MODULES/ on macOS,
    // `npm-debug.log.` and `x.log::$DATA` on NTFS, `NODE_M~1` as an 8.3 alias.
    // Linux opens none of them, so the normaliser is tested directly.
    assert(typeof serve.normalizeSegment === "function", "serve.js exports normalizeSegment");
    const n = (s) =>
      typeof serve.normalizeSegment === "function" ? serve.normalizeSegment(s) : undefined;
    for (const [input, want] of [
      ["about.html", "about.html"],
      ["Index.HTML", "index.html"],
      ["NODE_MODULES", "node_modules"],
      ["Node_Modules", "node_modules"],
      ["node_modules.", "node_modules"],
      ["node_modules ", "node_modules"],
      ["node_modules. .", "node_modules"],
      ["npm-debug.log.", "npm-debug.log"],
      ["NPM-DEBUG.LOG", "npm-debug.log"],
      [".ENV", ".env"],
      [".env.", ".env"],
      [".Well-Known", ".well-known"],
      ["a~b.html", "a~b.html"]
    ]) {
      assert(n(input) === want, `normalizeSegment(${JSON.stringify(input)}) -> ${want}`);
    }
    for (const input of [
      "x.log::$DATA",
      "index.html::$DATA",
      "file.txt:stream",
      "c:",
      "NODE_M~1",
      "GIT~1",
      "GITIGN~1",
      "ENV~1",
      "NPM-DE~1.LOG",
      "...",
      " ",
      ""
    ]) {
      assert(n(input) === null, `normalizeSegment(${JSON.stringify(input)}) is refused`);
    }
    // ...and the resolver applies it to every segment before every rule.
    for (const u of [
      "/NODE_MODULES/x/package.json",
      "/Node_Modules/x/package.json",
      "/sub/NODE_MODULES/a.js",
      "/node_modules./x/package.json",
      "/node_modules%20/x/package.json",
      "/NODE_M~1/x/package.json",
      "/npm-debug.LOG",
      "/npm-debug.log.",
      "/npm-debug.log%20",
      "/npm-debug.log::$DATA",
      "/index.html::$DATA",
      "/.ENV",
      "/.env.",
      "/.GIT/config",
      "/.git./config",
      "/GIT~1/config",
      "/sub/.WELL-KNOWN/x.txt"
    ]) {
      assert(r(u) === null, "resolveRequestPath: " + u + " is refused");
    }
    assert(
      r("/About.html") === path.join(site, "About.html") &&
        r("/.WELL-KNOWN/security.txt") === path.join(site, ".WELL-KNOWN", "security.txt"),
      "resolveRequestPath: a public name in another case is still public"
    );
    // A rewrite target is decoded once, never twice: %252e%252e is "%2e%2e", not "..".
    assert(
      typeof serve.decodeRequestPath === "function" &&
        serve.decodeRequestPath("/%252e%252e/secret.txt") === "/%2e%2e/secret.txt",
      "decodeRequestPath decodes exactly once"
    );

    // Live server on the fixture root.
    server = serve.createStaticServer(site);
    const port = await listen(server);

    let res = await get(port, "/index.html");
    assert(res.status === 200, "/index.html -> 200 (got " + res.status + ")");
    assert(res.body.indexOf(INDEX_MARK) !== -1, "/index.html serves the fixture page");
    assert(
      res.headers["content-type"] === "text/html; charset=utf-8",
      "/index.html has text/html; charset=utf-8 type (got " + res.headers["content-type"] + ")"
    );

    res = await get(port, "/");
    assert(res.status === 200 && res.body.indexOf(INDEX_MARK) !== -1, "/ serves index.html");

    res = await get(port, "/index.html?cache=1");
    assert(res.status === 200, "query string is ignored for lookup");

    res = await get(port, "/sub");
    assert(
      res.status === 200 && res.body.indexOf(SUB_MARK) !== -1,
      "/sub serves the directory index (got " + res.status + ")"
    );

    res = await get(port, "/no-such-page.html");
    assert(res.status === 404, "missing page -> 404 (got " + res.status + ")");
    assert(
      res.body.indexOf(NOT_FOUND_MARK) !== -1,
      "missing page is answered with the root's 404.html"
    );
    // no-cache, never no-store: Chromium never finishes loading a no-store
    // 4xx whose body page script leaves unread, so networkidle0 never came.
    for (const [p, want] of [
      ["/index.html", 200],
      ["/no-such.json", 404]
    ]) {
      res = await get(port, p, { Accept: "application/json" });
      const cc = String(res.headers["cache-control"] || "");
      assert(
        res.status === want && /\bno-cache\b/.test(cc) && !/no-store/.test(cc),
        p + " -> " + want + " with Cache-Control no-cache and no no-store (got " + cc + ")"
      );
    }

    // /api/* is the checkout Worker's: no Worker here, so it answers the way a
    // misrouted proxy would -- a short HTML page the site reads as
    // "unavailable" -- never a 404 (read as "no such order") and never a file.
    for (const [method, p] of [
      ["GET", "/api/inventory"],
      ["POST", "/api/order-status"],
      ["GET", "/api"]
    ]) {
      res = await new Promise((resolve, reject) => {
        const rq = http.request(
          { host: "127.0.0.1", port, path: p, method, headers: { Accept: "application/json" } },
          (rs) => {
            let body = "";
            rs.setEncoding("utf8");
            rs.on("data", (c) => (body += c));
            rs.on("end", () => resolve({ status: rs.statusCode, body, headers: rs.headers }));
          }
        );
        rq.on("error", reject);
        rq.end(method === "POST" ? '{"sessionId":"cs_test_1","email":"a@b.c"}' : undefined);
      });
      let parsed = true;
      try {
        JSON.parse(res.body);
      } catch (e) {
        parsed = false;
      }
      assert(
        res.status === 200 &&
          res.headers["x-static-server"] === "no-worker" &&
          /not part of this static server/.test(res.body) &&
          !parsed,
        method + " " + p + " -> the no-Worker page, which is not JSON (got " + res.status + ")"
      );
    }
    res = await get(port, "/apiary.html");
    assert(
      res.status === 404,
      "/apiary.html is a file path, not the Worker's (got " + res.status + ")"
    );

    // Traversal to the sentinel, request path sent verbatim by http.request.
    const traversals = [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/sub/../../secret.txt",
      "/%2e%2e%2fsecret.txt"
    ];
    for (const t of traversals) {
      res = await get(port, t);
      assert(res.status === 404, t + " -> 404 (got " + res.status + ")");
      assert(res.body.indexOf(SENTINEL) === -1, t + " does not serve the sentinel");
      assert(res.body.indexOf(NOT_FOUND_MARK) !== -1, t + " is answered with 404.html");
    }

    res = await get(port, "/../../../../../../etc/passwd");
    assert(res.status === 404, "/../../../etc/passwd -> 404 (got " + res.status + ")");
    assert(res.body.indexOf("root:") === -1, "traversal body does not contain /etc/passwd");

    // Same again over a raw socket, which applies no client-side normalisation at all.
    for (const t of ["/../secret.txt", "/%2e%2e/secret.txt"]) {
      const raw = await rawGet(port, t);
      assert(/^HTTP\/1\.[01] 404/.test(raw), "raw-socket " + t + " -> 404");
      assert(raw.indexOf(SENTINEL) === -1, "raw-socket " + t + " does not leak the sentinel");
    }
    const rawOk = await rawGet(port, "/index.html");
    assert(
      /^HTTP\/1\.[01] 200/.test(rawOk) && rawOk.indexOf(INDEX_MARK) !== -1,
      "raw-socket /index.html -> 200"
    );

    // Hidden files inside the root: a working copy's .git/ and .env.
    for (const [t, mark] of [
      ["/.git/config", GIT_MARK],
      ["/%2egit/config", GIT_MARK],
      ["/.env", ENV_MARK],
      ["/sub/../.env", ENV_MARK]
    ]) {
      res = await get(port, t);
      assert(res.status === 404, t + " -> 404 (got " + res.status + ")");
      assert(res.body.indexOf(mark) === -1, t + " does not serve the hidden file");
    }
    res = await get(port, "/.well-known/security.txt");
    assert(
      res.status === 200 && res.body.indexOf(WELL_KNOWN_MARK) !== -1,
      "/.well-known/security.txt is still served (got " + res.status + ")"
    );

    // Symlinks are judged by their real target.
    if (symlinks) {
      for (const t of ["/escape-dir/secret.txt", "/escape-file.txt"]) {
        res = await get(port, t);
        assert(res.status === 404, "symlink " + t + " -> 404 (got " + res.status + ")");
        assert(res.body.indexOf(SENTINEL) === -1, "symlink " + t + " does not leak the sentinel");
      }
      res = await get(port, "/config.txt");
      assert(
        res.status === 404 && res.body.indexOf(GIT_MARK) === -1,
        "a public name linked to .git/config -> 404 (got " + res.status + ")"
      );
    } else {
      console.log("  (symlinks unavailable on this platform; symlink checks skipped)");
    }

    // DNS rebinding: the attacker's hostname arrives as Host on 127.0.0.1.
    for (const h of ["rebind.attacker.example", "rebind.attacker.example:" + port]) {
      res = await get(port, "/index.html", { Host: h });
      assert(res.status === 403, "Host " + h + " -> 403 (got " + res.status + ")");
      assert(res.body.indexOf(INDEX_MARK) === -1, "Host " + h + " gets no page content");
    }
    res = await get(port, "/index.html", { Host: "localhost:" + port });
    assert(res.status === 200, "Host localhost:<port> -> 200 (got " + res.status + ")");
    res = await get(port, "/index.html", { Host: "[::1]:" + port });
    assert(res.status === 200, "Host [::1]:<port> -> 200 (got " + res.status + ")");
    const rawNoHost = await rawGet(port, "/index.html", "");
    assert(/^HTTP\/1\.[01] 403/.test(rawNoHost), "a request with no Host header -> 403");

    await close(server);
    server = null;

    // The Host check follows the socket, not the string (red team, 2026-10-09).
    // HOST=vm -- a NAME that resolves to loopback, as $(hostname) does on
    // Debian -- used to switch the check off on a loopback socket.
    server = serve.createStaticServer(site, { host: "yl-dev-box" });
    const namedPort = await listen(server, "127.0.0.1");
    for (const h of ["rebind.attacker.example:" + namedPort, "yl-dev-box.attacker.example"]) {
      res = await get(namedPort, "/index.html", { Host: h });
      assert(
        res.status === 403 && res.body.indexOf(INDEX_MARK) === -1,
        "HOST named yl-dev-box, bound to 127.0.0.1: Host " + h + " -> 403 (got " + res.status + ")"
      );
    }
    for (const h of ["yl-dev-box:" + namedPort, "YL-DEV-BOX", "localhost:" + namedPort]) {
      res = await get(namedPort, "/index.html", { Host: h });
      assert(
        res.status === 200 && res.body.indexOf(INDEX_MARK) !== -1,
        "HOST named yl-dev-box: its own name and loopback still load (Host " + h + ")"
      );
    }
    await close(server);
    server = null;

    // Told 0.0.0.0, bound to 127.0.0.1: the socket is loopback, so the check is on.
    server = serve.createStaticServer(site, { host: "0.0.0.0" });
    const saidLanPort = await listen(server, "127.0.0.1");
    res = await get(saidLanPort, "/index.html", { Host: "rebind.attacker.example:" + saidLanPort });
    assert(
      res.status === 403,
      "host option 0.0.0.0 but bound to 127.0.0.1 -> Host check on (got " + res.status + ")"
    );
    await close(server);
    server = null;

    // Really bound to 0.0.0.0, the LAN is invited in on purpose: any Host is
    // accepted, but hidden files stay hidden.
    server = serve.createStaticServer(site);
    const lanPort = await listen(server, "0.0.0.0");
    assert(server.address().address === "0.0.0.0", "the LAN case really is bound to 0.0.0.0");
    res = await get(lanPort, "/index.html", { Host: "192.168.1.20:" + lanPort });
    assert(res.status === 200, "a LAN bind accepts a non-loopback Host (got " + res.status + ")");
    res = await get(lanPort, "/.env", { Host: "192.168.1.20:" + lanPort });
    assert(
      res.status === 404 && res.body.indexOf(ENV_MARK) === -1,
      "a LAN bind still refuses .env"
    );
    await close(server);
    server = null;

    // The same thing end to end through the CLI: HOST=yl-rebind-test.invalid,
    // which a preloaded dns.lookup resolves to 127.0.0.1 -- exactly what
    // HOST=$(hostname) does on a stock Debian box. PORT=0 takes a free port.
    const preload = path.join(tmp, "resolve-to-loopback.js");
    fs.writeFileSync(
      preload,
      [
        'const dns = require("dns");',
        "const original = dns.lookup;",
        "dns.lookup = function (hostname, options, callback) {",
        '  if (String(hostname).toLowerCase() !== "yl-rebind-test.invalid") {',
        "    return original.apply(this, arguments);",
        "  }",
        '  if (typeof options === "function") callback = options;',
        "  if (options && options.all) {",
        '    return process.nextTick(callback, null, [{ address: "127.0.0.1", family: 4 }]);',
        "  }",
        '  return process.nextTick(callback, null, "127.0.0.1", 4);',
        "};",
        ""
      ].join("\n")
    );
    const cli = await startCli(preload, { HOST: "yl-rebind-test.invalid", PORT: "0" });
    try {
      assert(cli.port > 0, "CLI with HOST=yl-rebind-test.invalid printed its URL: " + cli.output);
      assert(
        /Bound to 127\.0\.0\.1 \(loopback\): Host header check ON/.test(cli.output),
        "CLI reports the loopback socket and the Host check as on"
      );
      if (cli.port > 0) {
        res = await get(cli.port, "/index.html", { Host: "attacker.example:" + cli.port });
        assert(
          res.status === 403,
          "CLI HOST=<name resolving to loopback>: rebinding Host -> 403 (got " + res.status + ")"
        );
        res = await get(cli.port, "/index.html", { Host: "yl-rebind-test.invalid:" + cli.port });
        assert(
          res.status === 200 && /<html/i.test(res.body),
          "CLI HOST=<name>: the printed URL's own Host still loads (got " + res.status + ")"
        );
      }
    } finally {
      cli.child.kill();
    }

    // Harness options: a stubbed route, a rewrite, headers, a body transform
    // and extra types -- all behind the Host check and the path rules.
    const seen = [];
    server = serve.createStaticServer(site, {
      onRequest(req, response, ctx) {
        seen.push(ctx.pathname);
        if (ctx.pathname === "/api/stub") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"stub":true}');
          return true;
        }
        if (ctx.pathname === "/start") {
          ctx.serve("/sub/index.html");
          return true;
        }
        if (ctx.pathname === "/start-outside") {
          ctx.serve("/../secret.txt");
          return true;
        }
        if (ctx.pathname === "/throws") throw new Error("hook failed");
        return false;
      },
      headers: (info) => ({ "X-Served": info.status + " " + info.pathname }),
      // Would rewrite the 404 page as well, if a transform ever reached it.
      transform: (body) =>
        body
          .toString("utf8")
          .replace(INDEX_MARK, "rewritten")
          .replace(NOT_FOUND_MARK, "rewritten-404"),
      mimeTypes: { ".html": "text/html; charset=x-test" }
    });
    const hookPort = await listen(server, "127.0.0.1");
    res = await get(hookPort, "/api/stub");
    assert(res.status === 200 && res.body === '{"stub":true}', "onRequest answers a stubbed route");
    res = await get(hookPort, "/api/stub", { Host: "rebind.attacker.example" });
    assert(res.status === 403, "a stubbed route is still behind the Host check");
    res = await get(hookPort, "/start");
    assert(
      res.status === 200 && res.body.indexOf(SUB_MARK) !== -1,
      "ctx.serve() rewrites to another static path"
    );
    res = await get(hookPort, "/start-outside");
    assert(
      res.status === 404 && res.body.indexOf(SENTINEL) === -1,
      "ctx.serve() keeps the containment rule (no sentinel)"
    );
    res = await get(hookPort, "/throws");
    assert(
      res.status === 500,
      "a throwing onRequest is a 500, not a crash (got " + res.status + ")"
    );
    res = await get(hookPort, "/index.html");
    assert(
      res.status === 200 &&
        res.body.indexOf("rewritten") !== -1 &&
        res.body.indexOf(INDEX_MARK) === -1 &&
        res.headers["x-served"] === "200 /index.html" &&
        res.headers["content-type"] === "text/html; charset=x-test",
      "transform, headers and mimeTypes apply to a 200"
    );
    res = await get(hookPort, "/no-such.html");
    assert(
      res.status === 404 &&
        res.body.indexOf(NOT_FOUND_MARK) !== -1 &&
        res.body.indexOf("rewritten-404") === -1 &&
        res.headers["x-served"] === "404 /no-such.html",
      "headers apply to the 404 page too; transform does not"
    );
    res = await get(hookPort, "/%252e%252e/secret.txt");
    assert(
      res.status === 404 && res.body.indexOf(SENTINEL) === -1,
      "double-encoded .. is not decoded twice"
    );
    assert(seen.indexOf("/%2e%2e/secret.txt") !== -1, "onRequest saw the once-decoded path");
    if (symlinks) {
      res = await get(hookPort, "/escape-file.txt");
      assert(
        res.status === 404 && res.body.indexOf(SENTINEL) === -1,
        "with options set, a symlink out of the root is still refused"
      );
    }
    await close(server);
    server = null;

    // listenLoopback: 127.0.0.1 always; a taken port is an error, or an
    // ephemeral port with fallbackToEphemeral -- never somebody else's server.
    assert(typeof serve.listenLoopback === "function", "serve.js exports listenLoopback");
    const squatter = net.createServer();
    await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const takenPort = squatter.address().port;
    if (typeof serve.listenLoopback === "function") {
      let refused = null;
      try {
        await serve.listenLoopback(serve.createStaticServer(site), takenPort);
      } catch (e) {
        refused = e;
      }
      assert(
        refused && refused.code === "EADDRINUSE",
        "listenLoopback on a taken port rejects with EADDRINUSE"
      );
      server = await serve.listenLoopback(serve.createStaticServer(site), takenPort, {
        fallbackToEphemeral: true
      });
      const a = server.address();
      assert(
        a.address === "127.0.0.1" && a.port > 0 && a.port !== takenPort,
        "fallbackToEphemeral binds a fresh loopback port (" + JSON.stringify(a) + ")"
      );
      res = await get(a.port, "/index.html");
      assert(res.status === 200 && res.body.indexOf(INDEX_MARK) !== -1, "...and serves from it");
      await close(server);
      server = null;
    }
    squatter.close();

    // The default root (the repository) still serves its real pages.
    server = serve.createStaticServer(REPO_ROOT);
    const repoPort = await listen(server);
    res = await get(repoPort, "/index.html");
    assert(
      res.status === 200 && /<html/i.test(res.body),
      "repository /index.html -> 200 (got " + res.status + ")"
    );
    res = await get(repoPort, "/../secret.txt");
    assert(
      res.status === 404 && res.body.indexOf(SENTINEL) === -1,
      "repository root refuses /../secret.txt too"
    );
  } finally {
    if (server) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert(!fs.existsSync(tmp), "fixture temp dir was removed");

  console.log(`\nserve.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("serve.test.js crashed:", err);
  process.exit(1);
});
