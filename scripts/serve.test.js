/**
 * @fileoverview Node-only tests for scripts/serve.js, the local static server.
 *
 * Builds its own site root in a temp directory (fs.mkdtempSync) with a sentinel
 * file placed OUTSIDE that root, starts the server on an ephemeral loopback
 * port and sends request paths verbatim (http.request does not normalise `..`,
 * and a raw socket certainly does not). Anything that resolves outside the root
 * must get a 404 and never the sentinel's content, while ordinary pages still
 * load. Nothing is written anywhere near the repository; the fixture is removed
 * in `finally`. Run: node scripts/serve.test.js
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

function get(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write("GET " + rawPath + " HTTP/1.0\r\nHost: localhost\r\n\r\n");
    });
    let data = "";
    sock.on("data", (c) => (data += c));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  );
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Lays out the fixture: <tmp>/site/{index.html,404.html,sub/index.html} and
 * <tmp>/secret.txt one level ABOVE the site root, which is what a traversal
 * of a single `..` from the root would read.
 * @return {{tmp: string, site: string, secret: string}}
 */
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yl-serve-test-"));
  const site = path.join(tmp, "site");
  fs.mkdirSync(path.join(site, "sub"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), `<html><body>${INDEX_MARK}</body></html>\n`);
  fs.writeFileSync(path.join(site, "404.html"), `<html><body>${NOT_FOUND_MARK}</body></html>\n`);
  fs.writeFileSync(path.join(site, "sub", "index.html"), `<html><body>${SUB_MARK}</body></html>\n`);
  const secret = path.join(tmp, "secret.txt");
  fs.writeFileSync(secret, SENTINEL + "\n");
  return { tmp, site, secret };
}

(async () => {
  console.log("Running serve.js tests...\n");
  assert(typeof serve.createStaticServer === "function", "serve.js exports createStaticServer");
  assert(typeof serve.resolveRequestPath === "function", "serve.js exports resolveRequestPath");
  assert(serve.DEFAULT_HOST === "127.0.0.1", "server binds to loopback by default");

  const { tmp, site, secret } = makeFixture();
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

    // Live server on the fixture root.
    server = serve.createStaticServer(site);
    const port = await listen(server);

    let res = await get(port, "/index.html");
    assert(res.status === 200, "/index.html -> 200 (got " + res.status + ")");
    assert(res.body.indexOf(INDEX_MARK) !== -1, "/index.html serves the fixture page");
    assert(res.headers["content-type"] === "text/html", "/index.html has text/html type");

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

    await close(server);
    server = null;

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
