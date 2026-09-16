/**
 * @fileoverview Node-only tests for scripts/serve.js, the local static server.
 *
 * Starts the server on an ephemeral loopback port and sends request paths
 * verbatim (http.request does not normalise `..`, and a raw socket certainly
 * does not), asserting that anything resolving outside the site root gets a
 * 404 while ordinary pages still load. Run: node scripts/serve.test.js
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
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

const ROOT = path.resolve(__dirname, "..");
const SECRET = path.resolve(ROOT, "..", "yl-serve-test-outside-root.txt");

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

(async () => {
  console.log("Running serve.js tests...\n");
  assert(typeof serve.createStaticServer === "function", "serve.js exports createStaticServer");
  assert(typeof serve.resolveRequestPath === "function", "serve.js exports resolveRequestPath");
  assert(serve.DEFAULT_HOST === "127.0.0.1", "server binds to loopback by default");
  assert(
    fs.existsSync(path.join(ROOT, "index.html")) && fs.existsSync(path.join(ROOT, "404.html")),
    "subject pages index.html and 404.html exist"
  );

  // Pure resolver.
  const r = (u) => serve.resolveRequestPath(ROOT, u);
  assert(r("/") === ROOT, "resolveRequestPath: / is the root");
  assert(r("/index.html") === path.join(ROOT, "index.html"), "resolveRequestPath: plain file");
  assert(r("/index.html?v=1#x") === path.join(ROOT, "index.html"), "query and hash are dropped");
  assert(r("/a%20b.html") === path.join(ROOT, "a b.html"), "percent-decoding is applied");
  assert(r("/../../../etc/passwd") === null, "literal .. traversal is refused");
  assert(r("/%2e%2e/%2e%2e/etc/passwd") === null, "percent-encoded .. traversal is refused");
  assert(r("/..%2f..%2fetc/passwd") === null, "encoded slash traversal is refused");
  assert(r("/products/../../etc/passwd") === null, "traversal below a real directory is refused");
  assert(r("/%zz") === null, "undecodable path is refused rather than thrown");
  assert(r("/index.html%00.png") === null, "NUL byte is refused");
  assert(r("/products/..") === ROOT, "a dot segment that stays inside the root is fine");

  // Live server on an ephemeral port. A sentinel file one level above the
  // repository proves a traversal would have had something to read.
  let wroteSecret = false;
  try {
    fs.writeFileSync(SECRET, "outside-root-secret\n");
    wroteSecret = true;
  } catch (e) {
    /* parent dir not writable: the /etc/passwd checks still stand */
  }
  const server = serve.createStaticServer(ROOT);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    let res = await get(port, "/index.html");
    assert(res.status === 200, "/index.html -> 200 (got " + res.status + ")");
    assert(/<html/i.test(res.body), "/index.html serves HTML");
    assert(res.headers["content-type"] === "text/html", "/index.html has text/html type");

    res = await get(port, "/");
    assert(res.status === 200 && /<html/i.test(res.body), "/ serves index.html");

    res = await get(port, "/index.html?cache=1");
    assert(res.status === 200, "query string is ignored for lookup");

    res = await get(port, "/admin");
    assert(
      res.status === 200 && /<html/i.test(res.body),
      "/admin serves the directory index (got " + res.status + ")"
    );

    res = await get(port, "/../../../etc/passwd");
    assert(res.status === 404, "/../../../etc/passwd -> 404 (got " + res.status + ")");
    assert(res.body.indexOf("root:") === -1, "traversal body does not contain /etc/passwd");

    res = await get(port, "/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
    assert(res.status === 404, "encoded traversal -> 404 (got " + res.status + ")");
    assert(res.body.indexOf("root:") === -1, "encoded traversal body does not leak");

    if (wroteSecret) {
      res = await get(port, "/../" + path.basename(SECRET));
      assert(res.status === 404, "sentinel above the root -> 404 (got " + res.status + ")");
      assert(res.body.indexOf("outside-root-secret") === -1, "sentinel content is not served");
      res = await get(port, "/products/../../" + path.basename(SECRET));
      assert(res.status === 404, "sentinel via nested traversal -> 404");
    }

    res = await get(port, "/no-such-page.html");
    assert(res.status === 404, "missing page -> 404 (got " + res.status + ")");

    const raw = await rawGet(port, "/../../../etc/passwd");
    assert(/^HTTP\/1\.[01] 404/.test(raw), "raw-socket traversal -> 404");
    assert(raw.indexOf("root:") === -1, "raw-socket traversal does not leak /etc/passwd");
    const rawOk = await rawGet(port, "/index.html");
    assert(/^HTTP\/1\.[01] 200/.test(rawOk), "raw-socket /index.html -> 200");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (wroteSecret) {
      try {
        fs.unlinkSync(SECRET);
      } catch (e) {
        /* already gone */
      }
    }
  }

  console.log(`\nserve.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("serve.test.js crashed:", err);
  process.exit(1);
});
