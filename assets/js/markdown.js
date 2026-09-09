/**
 * @fileoverview The ONE Markdown renderer for Apothecary Journal post text.
 *
 * A post's `content` is written by Savanna in /admin (the field is a rich-text
 * editor that stores Markdown) and is drawn in two places: by the build
 * (scripts/build-site-data.js renders every post into its own static page at
 * /journal/<slug>.html) and by the browser (assets/js/main.js, which still
 * renders a post in place on journal.html when a `#post-<slug>` link cannot be
 * redirected). Two copies of this function would drift the first time one of
 * them was edited, so both load THIS file: the build `require()`s it and
 * journal.html loads it as a plain <script> that publishes `window.YL_MARKDOWN`.
 * scripts/markdown.test.js asserts the two entry points are the same function
 * and that every published post renders identically through each.
 *
 * The renderer has exactly two jobs: cover the handful of formatting marks a
 * shop owner actually needs, and never let post text become live markup.
 *
 * Why this isn't a vendored library. Self-hosting one would have been fine --
 * the site's CSP only blocks CDN scripts, and we already self-host the fonts
 * for that same reason (docs/SELF-HOSTING-FONTS.md) -- so this was a trade,
 * not a constraint:
 *   - snarkdown (1.9 KB minified, MIT) is the closest fit by size, but its
 *     last release was 2020, it passes raw HTML straight through (an
 *     `<img src=x onerror=...>` in a post survives verbatim), writes hrefs
 *     with no scheme check (`[x](javascript:alert(1))` becomes a live link),
 *     and separates paragraphs with `<br />` instead of `<p>` -- which on its
 *     own would restyle every post already published, since the journal
 *     styles `.content p`. Fixing the first two means forking its single
 *     dense minified regex, which throws away the reason to vendor it.
 *   - marked (40 KB minified) and markdown-it (124 KB minified) are each
 *     bigger than every file this site ships except main.js itself, for a
 *     page that renders a couple of posts. marked doesn't sanitize either
 *     (its docs hand you off to DOMPurify); markdown-it is genuinely safe by
 *     default (html:false plus a scheme allowlist) but is ~15x the size of
 *     the ~8 KB below for the same handful of formatting marks.
 * So: escape FIRST, then add formatting to text that can no longer contain
 * markup. Anything unsupported degrades to plain text.
 */
/* global module */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.YL_MARKDOWN = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Same table as attrEsc() in main.js and escapeHtml() in the build: the
     output lands in text nodes AND attribute values (href), so quotes and
     backticks are escaped too. */
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/`/g, "&#96;");
  }

  /* Strips every control character and space BEFORE deciding what the scheme
     is, so " javascript:alert(1)" and "java<TAB>script:alert(1)" are both
     caught. Only http, https and mailto may carry a scheme; a relative
     reference ("shop.html", "/journal.html", "#gift-cards") cannot execute
     and passes through. Identical to safeLinkUrl() in main.js. */
  function safeLinkUrl(url) {
    if (!url) return "";
    var raw = String(url);
    var cleaned = "";
    for (var i = 0; i < raw.length; i++) {
      var code = raw.charCodeAt(i);
      if (code > 32 && code !== 127) cleaned += raw.charAt(i);
    }
    if (!cleaned) return "";
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (scheme) {
      var name = scheme[1].toLowerCase();
      if (name !== "http" && name !== "https" && name !== "mailto") return "";
      return cleaned;
    }
    return cleaned;
  }

  /* Inline emphasis. Only ever runs on text escapeHtml() has already escaped,
     so there is no "<" left for it to turn into a tag. Sveltia's editor
     writes **bold** and _italic_; *italic* and __bold__ are accepted too
     because that's what people type by hand. An underscore inside a word
     (soap_batch_2) is not emphasis, which is why those two rules check the
     characters on either side. */
  function mdEmphasis(escaped) {
    return escaped
      .replace(/(^|[^A-Za-z0-9_])__([^\n]+?)__(?![A-Za-z0-9_])/g, "$1<strong>$2</strong>")
      .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>")
      .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  }

  /* [label](url). The URL may not contain whitespace, and may contain at most
     one nested pair of parentheses -- enough for the Wikipedia-style
     ".../Arnica_(plant)" links an herbal blog actually uses, while staying a
     single unambiguous match per link (the two alternatives can't match the
     same character, so there is nothing here to backtrack over). */
  var MD_LINK_RE = /\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g;

  /* One run of markdown text -> safe HTML. Escaping happens per slice so the
     URL is checked in its raw form (before "&" becomes "&amp;") and only then
     escaped for the attribute it lands in. */
  function mdInline(text) {
    var html = "";
    var lastIndex = 0;
    var match;
    MD_LINK_RE.lastIndex = 0;
    while ((match = MD_LINK_RE.exec(text)) !== null) {
      html += mdEmphasis(escapeHtml(text.slice(lastIndex, match.index)));
      var href = safeLinkUrl(match[2]);
      var label = mdEmphasis(escapeHtml(match[1]));
      // A rejected URL (javascript:, data:, ...) keeps the words and drops
      // the link -- it never reaches an href.
      html += href ? '<a href="' + escapeHtml(href) + '">' + label + "</a>" : label;
      lastIndex = MD_LINK_RE.lastIndex;
    }
    return html + mdEmphasis(escapeHtml(text.slice(lastIndex)));
  }

  /* Block structure: blank-line separated paragraphs (what every post written
     before this existed already is), "## " headings, "- " bullet lists,
     "1. " numbered lists, and "***" dividers. Deliberately not a CommonMark
     parser -- no tables, code blocks, blockquotes or images, all of which are
     also switched off in the editor (see admin/config.yml's `buttons` and
     `editor_components` for the journal `content` field).

     options.headingLevel is the tag a "##" heading becomes (a "###" or deeper
     heading is one level below it, and nothing goes past <h6>). It defaults
     to 3 because on journal.html the post title is the page's <h2>, so
     headings inside a post start at <h3> and never skip a level; the static
     post pages put the title in an <h1> and pass 2 for the same reason. */
  function renderMarkdown(text, options) {
    if (text == null) return "";
    var base = options && options.headingLevel ? Number(options.headingLevel) : 3;
    if (!(base >= 1 && base <= 6)) base = 3;
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var html = "";
    var para = [];
    var items = [];
    var listTag = "";

    function flushPara() {
      if (!para.length) return;
      // Joined with "\n", not " ": a plain-text post then renders the exact
      // same bytes it did before this function existed.
      html += "<p>" + mdInline(para.join("\n")) + "</p>";
      para = [];
    }

    function flushList() {
      if (!items.length) return;
      html +=
        "<" +
        listTag +
        ">" +
        items
          .map(function (item) {
            return "<li>" + mdInline(item) + "</li>";
          })
          .join("") +
        "</" +
        listTag +
        ">";
      items = [];
      listTag = "";
    }

    function pushItem(tag, item) {
      // A "1." right after a "-" starts a second, differently-tagged list.
      if (listTag && listTag !== tag) flushList();
      flushPara();
      listTag = tag;
      items.push(item);
    }

    lines.forEach(function (line) {
      var trimmed = line.trim();
      var heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      var bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
      var numbered = /^\d{1,9}[.)]\s+(.+)$/.exec(trimmed);

      if (!trimmed) {
        flushPara();
        flushList();
      } else if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
        flushPara();
        flushList();
        html += "<hr>";
      } else if (heading) {
        flushPara();
        flushList();
        var level = Math.min(6, heading[1].length > 2 ? base + 1 : base);
        var tag = "h" + level;
        html += "<" + tag + ">" + mdInline(heading[2]) + "</" + tag + ">";
      } else if (bullet) {
        pushItem("ul", bullet[1]);
      } else if (numbered) {
        pushItem("ol", numbered[1]);
      } else {
        flushList();
        para.push(line);
      }
    });

    flushPara();
    flushList();
    return html;
  }

  return {
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
    safeLinkUrl: safeLinkUrl
  };
});
