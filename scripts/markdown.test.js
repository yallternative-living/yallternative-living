/**
 * @fileoverview Unit tests for assets/js/markdown.js -- the ONE Markdown
 * renderer for journal post text, loaded by both the build (which writes each
 * post's static page) and journal.html (main.js's in-page fallback).
 *
 * The parity block at the end is the point of the file: it proves the build
 * and the browser render every published post through the same function,
 * so the two cannot drift. Run: node scripts/markdown.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const md = require("../assets/js/markdown.js");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

console.log("Running markdown.js unit tests...\n");

/* 1. Module shape: both entry points exist. */
assert(typeof md.renderMarkdown === "function", "module exports renderMarkdown");
assert(typeof md.escapeHtml === "function", "module exports escapeHtml");
assert(typeof md.safeLinkUrl === "function", "module exports safeLinkUrl");

/* Browser entry point: evaluated as a plain script it publishes
   window.YL_MARKDOWN with the same function. */
(function browserGlobal() {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "assets/js/markdown.js"), "utf8");
  const sandbox = { self: {} };
  sandbox.self.self = sandbox.self;
  vm.runInNewContext(src, sandbox);
  const browserMd = sandbox.self.YL_MARKDOWN;
  assert(
    browserMd && typeof browserMd.renderMarkdown === "function",
    "as a <script>, publishes window.YL_MARKDOWN.renderMarkdown"
  );
  eq(
    browserMd && browserMd.renderMarkdown("**a** [b](https://x.test)\n\n- c"),
    md.renderMarkdown("**a** [b](https://x.test)\n\n- c"),
    "the browser global and the Node export render identically"
  );
})();

/* 2. Plain text: a post with no Markdown renders exactly as the pre-Markdown
   code did (blank-line paragraphs, escaped). */
const legacyRender = (content) =>
  content
    .split("\n\n")
    .map((p) => "<p>" + md.escapeHtml(p) + "</p>")
    .join("");
[
  "A single paragraph with no formatting at all.",
  "First paragraph.\n\nSecond paragraph.\n\nThird one.",
  "Ends with a space before the break. \n\nAnd continues here.",
  "We've all been there & it's fine.",
  "2012, was a year.\n\nSo was 2013."
].forEach((content, i) => {
  eq(
    md.renderMarkdown(content),
    legacyRender(content),
    "plain-text post #" + (i + 1) + " is unchanged"
  );
});
eq(md.renderMarkdown(null), "", "null renders as empty");
eq(md.renderMarkdown(""), "", "empty string renders as empty");

/* 3. XSS: HTML in a post can never become live markup. */
eq(
  md.renderMarkdown("<script>alert(1)</script>"),
  "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  "escapes a <script> tag"
);
assert(
  md.renderMarkdown('<img src=x onerror="alert(1)">').indexOf("<img") === -1,
  "never emits <img>"
);
assert(
  md.renderMarkdown("## <iframe src=evil>").indexOf("<iframe") === -1,
  "escapes HTML in a heading"
);
assert(
  md.renderMarkdown("- <svg onload=alert(1)>").indexOf("<svg") === -1,
  "escapes HTML in a list item"
);
eq(
  md.renderMarkdown("**<b>bold</b>**"),
  "<p><strong>&lt;b&gt;bold&lt;/b&gt;</strong></p>",
  "formats around escaped HTML instead of un-escaping it"
);
eq(
  md.renderMarkdown("[x](javascript:alert(1))"),
  "<p>x</p>",
  "drops a javascript: link, keeps the words"
);
assert(
  md.renderMarkdown("[x](javascript:alert(1))").indexOf("javascript") === -1,
  "javascript: never reaches the output"
);
assert(
  md.renderMarkdown("[x](java\tscript:alert(1))").indexOf("<a") === -1,
  "a tab inside the scheme does not smuggle javascript:"
);
assert(
  md.renderMarkdown("[x](data:text/html,<script>alert(1)</script>)").indexOf("<a ") === -1,
  "no anchor for a data: URL"
);
assert(
  md.renderMarkdown('[x](https://ok.test/" onmouseover="alert(1))').indexOf('"alert(1)"') === -1,
  "cannot break out of an href attribute"
);
eq(md.renderMarkdown("`x`"), "<p>&#96;x&#96;</p>", "backticks are escaped, not rendered as code");

/* 4. The formatting a shop owner actually uses. */
eq(
  md.renderMarkdown("**bold** and _italic_"),
  "<p><strong>bold</strong> and <em>italic</em></p>",
  "bold + italic"
);
eq(
  md.renderMarkdown("*italic* and __bold__"),
  "<p><em>italic</em> and <strong>bold</strong></p>",
  "star italic + underscore bold"
);
eq(
  md.renderMarkdown("soap_batch_2 is fine"),
  "<p>soap_batch_2 is fine</p>",
  "underscore inside a word is not emphasis"
);
eq(
  md.renderMarkdown("[Arnica](https://en.wikipedia.org/wiki/Arnica_(plant))"),
  '<p><a href="https://en.wikipedia.org/wiki/Arnica_(plant)">Arnica</a></p>',
  "a link with one nested parenthesis pair"
);
eq(
  md.renderMarkdown("[x](https://a.test/?q=1&r=2)"),
  '<p><a href="https://a.test/?q=1&amp;r=2">x</a></p>',
  "ampersand in an href is escaped once"
);
eq(md.renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>", "bullet list");
eq(md.renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>", "numbered list");
eq(
  md.renderMarkdown("- a\n1. b"),
  "<ul><li>a</li></ul><ol><li>b</li></ol>",
  "a numbered item after a bullet starts a new list"
);
eq(md.renderMarkdown("para\n***\npara"), "<p>para</p><hr><p>para</p>", "*** is a divider");
eq(md.renderMarkdown("a\r\nb\r\n\r\nc"), "<p>a\nb</p><p>c</p>", "CRLF is normalised");

/* 5. Heading level: journal.html's in-page view puts the title in an <h2>,
   so post headings default to h3/h4; a static post page has an <h1> title
   and passes headingLevel 2 so nothing skips a level. */
eq(
  md.renderMarkdown("## Two\n### Three\n#### Four"),
  "<h3>Two</h3><h4>Three</h4><h4>Four</h4>",
  "default headings start at h3"
);
eq(
  md.renderMarkdown("## Two\n### Three\n#### Four", { headingLevel: 2 }),
  "<h2>Two</h2><h3>Three</h3><h3>Four</h3>",
  "headingLevel 2 starts at h2"
);
eq(md.renderMarkdown("## T", { headingLevel: 6 }), "<h6>T</h6>", "headingLevel 6 stays inside h6");
eq(
  md.renderMarkdown("### T", { headingLevel: 6 }),
  "<h6>T</h6>",
  "a deeper heading never goes past h6"
);
eq(
  md.renderMarkdown("## T", { headingLevel: 42 }),
  "<h3>T</h3>",
  "an out-of-range headingLevel falls back to the default"
);

/* 6. Parity: the build and the browser render every published post through
   the same function. main.js delegates to this module (require() in Node,
   window.YL_MARKDOWN in the browser) and build-site-data.js require()s it;
   assert the wiring on both sides for every post on disk, so a re-implemented
   copy on either side would fail here the day it appeared. */
(function parity() {
  const postsDir = path.join(ROOT, "assets/data/journal");
  const posts = fs.existsSync(postsDir)
    ? fs
        .readdirSync(postsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(fs.readFileSync(path.join(postsDir, f), "utf8")))
    : [];
  assert(posts.length > 0, "parity check has posts to compare (assets/data/journal/*.json)");

  const build = require("./build-site-data.js");
  assert(
    build.renderMarkdown === md.renderMarkdown,
    "build-site-data.js uses the module's renderMarkdown, not a copy"
  );

  /* main.js needs a DOM to load, which scripts/main.test.js already stubs;
     the post-by-post comparison of main.renderMarkdown against this module
     lives there. What this suite can prove without a DOM is that main.js has
     no renderer of its own any more: it delegates to the module on both of
     its paths and none of the old implementation's names survive. */
  const mainSrc = fs.readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8");
  assert(
    mainSrc.indexOf("window.YL_MARKDOWN") !== -1,
    "main.js reads window.YL_MARKDOWN in the browser"
  );
  assert(
    mainSrc.indexOf('require("./markdown.js")') !== -1,
    "main.js require()s the module in Node"
  );
  ["function mdInline", "function mdEmphasis", "MD_LINK_RE", "function flushPara"].forEach(
    (name) => {
      assert(mainSrc.indexOf(name) === -1, "main.js no longer carries its own " + name);
    }
  );
  const journalHtml = fs.readFileSync(path.join(ROOT, "journal.html"), "utf8");
  const mdTag = journalHtml.indexOf('src="assets/js/markdown.js');
  const mainTag = journalHtml.indexOf('src="assets/js/main.js');
  assert(
    mdTag !== -1 && mainTag !== -1 && mdTag < mainTag,
    "journal.html loads markdown.js before main.js"
  );
  posts.forEach((post) => {
    assert(
      md.renderMarkdown(post.content).indexOf("<script") === -1,
      '"' + post.title + '" renders no <script>'
    );
  });
})();

console.log(`\nmarkdown.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
