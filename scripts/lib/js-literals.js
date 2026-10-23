/**
 * @fileoverview The string and template literals of a JavaScript source, cooked
 * (escapes decoded), in source order. Nothing else: no comments, no regex
 * bodies, no identifiers.
 *
 * Why it exists: the dictionary gate in scripts/build-site-data.js has to know
 * whether a string the site renders from a shipped script ("Next appearance",
 * an event's note) is still in that script. Searching the raw file would let a
 * comment that quotes old copy keep a dead key alive, and would misread a
 * regex like /["']/ as the start of a string. A real tokenizer (acorn) gets
 * this right, but the build is deliberately dependency-free -- several tests
 * copy the tree WITHOUT node_modules and run it -- so this is the small subset
 * of one that the question needs.
 *
 * The one genuinely ambiguous thing in JS lexing is `/`: division or the start
 * of a regex. It is decided the standard way, from the previous significant
 * token. `)` and `]` and `}` read as division, which is wrong only for
 * statement-position regexes after a block or a parenthesised condition --
 * none of which this repo writes. scripts/build-site-data.test.js pins the
 * output against acorn's on every shipped script, so a construct this gets
 * wrong fails a test instead of quietly weakening the gate.
 */

const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await"
]);

const SIMPLE_ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

function isIdentChar(ch) {
  return /[A-Za-z0-9_$\u0080-￿]/.test(ch);
}

/**
 * Decode one escape sequence starting at src[i] === "\\". Returns
 * [cookedText, nextIndex].
 */
function readEscape(src, i) {
  const c = src[i + 1];
  if (c === undefined) return ["", i + 1];
  if (c === "\r" && src[i + 2] === "\n") return ["", i + 3];
  if (c === "\n" || c === "\r" || c === " " || c === " ") return ["", i + 2];
  if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, c) && !/[0-9]/.test(src[i + 2] || "")) {
    return [SIMPLE_ESCAPES[c], i + 2];
  }
  if (c === "x") {
    const hex = src.slice(i + 2, i + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), i + 4];
  }
  if (c === "u") {
    if (src[i + 2] === "{") {
      const end = src.indexOf("}", i + 3);
      const hex = src.slice(i + 3, end);
      if (end !== -1 && /^[0-9a-fA-F]+$/.test(hex)) {
        return [String.fromCodePoint(parseInt(hex, 16)), end + 1];
      }
    }
    const hex = src.slice(i + 2, i + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), i + 6];
  }
  return [c, i + 2];
}

/**
 * @param {string} src JavaScript source.
 * @return {!Array<string>} Cooked string and template-chunk values, in order.
 */
function extractJsLiterals(src) {
  const out = [];
  const n = src.length;
  /* The previous significant token, for the regex-or-division decision:
     {kind: "ident"|"num"|"punct"|"literal", value}. */
  let prev = null;
  let i = src.startsWith("#!") ? src.indexOf("\n") : 0;
  if (i === -1) return out;

  /* A stack of brace depths, one per template literal whose ${...} we are
     inside. When the `}` that closes the substitution arrives, scanning
     resumes inside that template. */
  const templateDepths = [];
  let braceDepth = 0;

  function regexAllowed() {
    if (!prev) return true;
    if (prev.kind === "num" || prev.kind === "literal") return false;
    if (prev.kind === "ident") return REGEX_AFTER_KEYWORD.has(prev.value);
    return prev.value !== ")" && prev.value !== "]" && prev.value !== "}";
  }

  /* Scan a template body from i (just past ` or the } closing a ${}). Pushes
     each cooked chunk. Returns the index just past the closing ` or the ${. */
  function scanTemplateChunk() {
    let cooked = "";
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        const r = readEscape(src, i);
        cooked += r[0];
        i = r[1];
      } else if (ch === "`") {
        i++;
        if (cooked) out.push(cooked);
        prev = { kind: "literal" };
        return;
      } else if (ch === "$" && src[i + 1] === "{") {
        i += 2;
        if (cooked) out.push(cooked);
        templateDepths.push(braceDepth);
        braceDepth++;
        prev = { kind: "punct", value: "${" };
        return;
      } else {
        cooked += ch;
        i++;
      }
    }
    if (cooked) out.push(cooked);
  }

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? n : end;
    } else if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'" || ch === '"') {
      let cooked = "";
      i++;
      while (i < n && src[i] !== ch && src[i] !== "\n") {
        if (src[i] === "\\") {
          const r = readEscape(src, i);
          cooked += r[0];
          i = r[1];
        } else {
          cooked += src[i++];
        }
      }
      i++;
      if (cooked) out.push(cooked);
      prev = { kind: "literal" };
    } else if (ch === "`") {
      i++;
      scanTemplateChunk();
    } else if (ch === "/" && regexAllowed()) {
      // Regex literal: skip it, honouring escapes and [...] classes.
      let inClass = false;
      i++;
      while (i < n && src[i] !== "\n") {
        const c = src[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && isIdentChar(src[i])) i++; // flags
      prev = { kind: "literal" };
    } else if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next || ""))) {
      while (i < n && /[0-9A-Za-z_.]/.test(src[i])) i++;
      prev = { kind: "num" };
    } else if (isIdentChar(ch) || ch === "#") {
      const start = i;
      i++;
      while (i < n && isIdentChar(src[i])) i++;
      prev = { kind: "ident", value: src.slice(start, i) };
    } else if (ch === "{") {
      braceDepth++;
      i++;
      prev = { kind: "punct", value: "{" };
    } else if (ch === "}") {
      braceDepth--;
      i++;
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === braceDepth) {
        templateDepths.pop();
        scanTemplateChunk();
      } else {
        prev = { kind: "punct", value: "}" };
      }
    } else {
      i++;
      prev = { kind: "punct", value: ch };
    }
  }
  return out;
}

module.exports = { extractJsLiterals };
