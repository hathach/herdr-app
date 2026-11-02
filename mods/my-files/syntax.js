// Lexical colouring for C/C++, Python, Markdown and reST source, line by line: runs of [text, category]. Not a parser
// and no rendering. Pure (no herdr imports) so `node --test` loads it; my-changes and my-files keep identical copies,
// since a mod cannot import another mod's files.

const EXT = { c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", "c++": "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", ino: "cpp", ipp: "cpp", inl: "cpp",
  py: "python", pyi: "python", pyw: "python", md: "markdown", markdown: "markdown", rst: "rst", rest: "rst" };
const LABEL = { ...EXT, python: "python", python3: "python", py3: "python" };

// Theme colour names for each category; anything else draws in the text colour.
export const COLORS = { keyword: "ansi5", directive: "ansi5", marker: "ansi5", string: "ansi2", literal: "ansi2", comment: "dim",
  function: "ansi4", link: "ansi4", type: "ansi3", heading: "ansi3", number: "ansi1", constant: "ansi6", emphasis: "ansi6" };

export function languageOf(path) {
  const name = path.split(/[\\/]/).pop(), dot = name.lastIndexOf(".");
  return dot > 0 ? EXT[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

const words = (s) => new Set(s.split(" "));
const C_KEYWORDS = words("auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local static_assert alignas alignof");
const CPP_KEYWORDS = words("class namespace template typename public private protected virtual override final friend operator new delete this throw try catch using constexpr consteval constinit decltype explicit mutable noexcept co_await co_return co_yield concept requires export import module static_cast dynamic_cast reinterpret_cast const_cast");
const C_TYPES = words("void char short int long float double signed unsigned bool _Bool _Complex size_t ssize_t ptrdiff_t intptr_t uintptr_t wchar_t char8_t char16_t char32_t FILE va_list");
const C_CONSTANTS = words("true false NULL nullptr");
const PY_KEYWORDS = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case");
const PY_TYPES = words("int float complex str bytes bytearray bool list dict set frozenset tuple object type range memoryview");
const PY_CONSTANTS = words("True False None NotImplemented Ellipsis __name__ __file__");

// Collects runs, merging neighbours of one category.
function runs() {
  const out = [];
  return {
    out,
    add(text, category = null) {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last[1] === category) last[0] += text;
      else out.push([text, category]);
    },
  };
}

const C_NUMBER = /^(?:0[xX][\da-fA-F']+|0[bB][01']+|(?:\d[\d']*\.?[\d']*|\.\d[\d']*)(?:[eEpP][+-]?\d+)?)[uUlLfFzZ]*/;
const PY_NUMBER = /^(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[jJ]?/;
const WORD = /^[A-Za-z_]\w*/;
const constantName = (w) => w.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(w);

// A quoted string from `at` (on its opening quote) -> its end, or -1 when the line ends first.
function quoted(line, at, quote) {
  for (let i = at + quote.length; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}

// state: null, { block } inside /* */, { raw: ')delim"' }, { cont: "comment" | "string" } after a trailing backslash.
function lexC(cpp) {
  const keywords = cpp ? new Set([...C_KEYWORDS, ...CPP_KEYWORDS]) : C_KEYWORDS;
  return (line, state) => {
    const r = runs();
    let i = 0;
    const continued = /\\\r?$/.test(line);
    if (state?.block) {
      const end = line.indexOf("*/");
      if (end < 0) { r.add(line, "comment"); return [r.out, state]; }
      r.add(line.slice(0, end + 2), "comment"); i = end + 2;
    } else if (state?.raw) {
      const end = line.indexOf(state.raw);
      if (end < 0) { r.add(line, "string"); return [r.out, state]; }
      r.add(line.slice(0, end + state.raw.length), "string"); i = end + state.raw.length;
    } else if (state?.cont === "comment") {
      r.add(line, "comment"); return [r.out, continued ? state : null];
    } else if (state?.cont === "string") {
      const end = quoted(" " + line, 0, '"');
      if (end < 0) { r.add(line, "string"); return [r.out, continued ? state : null]; }
      r.add(line.slice(0, end - 1), "string"); i = end - 1;
    }
    const directive = i === 0 && /^\s*#\s*\w+/.exec(line);
    if (directive) {
      r.add(directive[0], "keyword"); i = directive[0].length;
      const header = /^(\s*)(<[^>]*>)/.exec(line.slice(i));
      if (/include|import/.test(directive[0]) && header) { r.add(header[1]); r.add(header[2], "string"); i += header[0].length; }
    }
    let previous = "";
    while (i < line.length) {
      const rest = line.slice(i);
      if (rest.startsWith("//")) { r.add(rest, "comment"); return [r.out, continued ? { cont: "comment" } : null]; }
      if (rest.startsWith("/*")) {
        const end = line.indexOf("*/", i + 2);
        if (end < 0) { r.add(rest, "comment"); return [r.out, { block: true }]; }
        r.add(line.slice(i, end + 2), "comment"); i = end + 2; continue;
      }
      const raw = cpp && /^(?:u8|[uUL])?R"([^()\\\s]{0,16})\(/.exec(rest);
      if (raw) {
        const close = `)${raw[1]}"`, end = line.indexOf(close, i + raw[0].length);
        if (end < 0) { r.add(rest, "string"); return [r.out, { raw: close }]; }
        r.add(line.slice(i, end + close.length), "string"); i = end + close.length; continue;
      }
      const prefix = /^(?:u8|[uUL])?(["'])/.exec(rest);
      if (prefix && (prefix[0].length === 1 || !/\w/.test(line[i - 1] ?? ""))) {
        const end = quoted(line, i + prefix[0].length - 1, prefix[1]);
        if (end < 0) { r.add(rest, "string"); return [r.out, continued && prefix[1] === '"' ? { cont: "string" } : null]; }
        r.add(line.slice(i, end), "string"); i = end; continue;
      }
      const number = !/\w/.test(line[i - 1] ?? "") && C_NUMBER.exec(rest);
      if (number) { r.add(number[0], "number"); i += number[0].length; continue; }
      const word = WORD.exec(rest);
      if (word) {
        const w = word[0], after = line.slice(i + w.length);
        const category = keywords.has(w) ? "keyword" : C_TYPES.has(w) || /_t$/.test(w) ? "type" : C_CONSTANTS.has(w) || constantName(w) ? "constant"
          : keywords.has(previous) && /^(struct|class|enum|union)$/.test(previous) ? "type" : /^\s*\(/.test(after) ? "function" : null;
        r.add(w, category); i += w.length; previous = w; continue;
      }
      if (!/\s/.test(rest[0])) previous = "";
      r.add(rest[0]); i++;
    }
    return [r.out, null];
  };
}

// state: null, { quote } inside a string that continues on the next line (triple-quoted, or a backslash at the end).
function lexPython(line, state) {
  const r = runs();
  let i = 0, previous = "";
  if (state?.quote) {
    const end = quoted(" ".repeat(state.quote.length) + line, 0, state.quote);
    if (end < 0) { r.add(line, "string"); return [r.out, state.quote.length === 3 || /\\\r?$/.test(line) ? state : null]; }
    i = end - state.quote.length; r.add(line.slice(0, i), "string");
  }
  const decorator = i === 0 && /^(\s*)(@[\w.]+)/.exec(line);
  if (decorator) { r.add(decorator[1]); r.add(decorator[2], "function"); i = decorator[0].length; }
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest[0] === "#") { r.add(rest, "comment"); return [r.out, null]; }
    const string = !/\w/.test(line[i - 1] ?? "") && /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(rest);
    if (string) {
      const quote = string[2], end = quoted(line, i + string[1].length, quote);
      if (end < 0) { r.add(rest, "string"); return [r.out, quote.length === 3 || /\\\r?$/.test(line) ? { quote } : null]; }
      r.add(line.slice(i, end), "string"); i = end; continue;
    }
    const number = !/\w/.test(line[i - 1] ?? "") && PY_NUMBER.exec(rest);
    if (number) { r.add(number[0], "number"); i += number[0].length; continue; }
    const word = WORD.exec(rest);
    if (word) {
      const w = word[0];
      const category = previous === "def" ? "function" : previous === "class" ? "type" : PY_KEYWORDS.has(w) ? "keyword" : PY_CONSTANTS.has(w) || constantName(w) ? "constant"
        : PY_TYPES.has(w) ? "type" : /^\s*\(/.test(line.slice(i + w.length)) ? "function" : null;
      r.add(w, category); i += w.length; previous = w; continue;
    }
    if (!/\s/.test(rest[0])) previous = "";
    r.add(rest[0]); i++;
  }
  return [r.out, null];
}

const LEXERS = { c: lexC(false), cpp: lexC(true), python: lexPython };

// Inline markup shared by Markdown and reST: each rule is [regex at the start, category].
function inline(r, text, rules) {
  let plain = "";
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i), boundary = !/[\w\\]/.test(text[i - 1] ?? "");
    let hit = null;
    for (const [re, category, needsBoundary] of rules) {
      const m = (!needsBoundary || boundary) && re.exec(rest);
      if (m) { hit = [m[0], category]; break; }
    }
    if (hit) { r.add(plain); plain = ""; r.add(hit[0], hit[1]); i += hit[0].length; }
    else { plain += text[i]; i++; }
  }
  r.add(plain);
}

const MD_INLINE = [
  [/^(`+)[^`][\s\S]*?\1(?!`)/, "literal"],
  [/^<!--[\s\S]*?(?:-->|$)/, "comment"],
  [/^!?\[[^\]]*\]\([^)]*\)/, "link"],
  [/^!?\[[^\]]*\]\[[^\]]*\]/, "link"],
  [/^<(?:https?:|mailto:)[^>\s]+>/, "link"],
  [/^(\*\*|__)(?=\S)[\s\S]*?\S\1/, "emphasis", true],
  [/^([*_])(?=[^\s*_])[\s\S]*?[^\s\\]\1(?!\w)/, "emphasis", true],
];

// A known fence or code-block label -> its lexer's language.
const labelled = (label) => { const lang = LABEL[label?.toLowerCase()]; return LEXERS[lang] ? lang : null; };

// Lexes a line inside a code block with its own language, or as literal text.
function nested(r, line, state) {
  if (!state.lang) { r.add(line, "literal"); return state; }
  const [inner, next] = LEXERS[state.lang](line, state.inner);
  for (const [text, category] of inner) r.add(text, category);
  return { ...state, inner: next };
}

// A comment run left open (outside code spans: those match first) continues on the next lines.
function openComment(out) {
  const last = out[out.length - 1];
  return last?.[1] === "comment" && last[0].lastIndexOf("<!--") > last[0].lastIndexOf("-->") ? { html: true } : null;
}

// state: null, { fence, lang, inner } inside fenced code, { html } inside an HTML comment.
function lexMarkdown(line, state, next) {
  const r = runs();
  if (state?.fence) {
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === state.fence[0] && close[1].length >= state.fence.length) { r.add(line, "marker"); return [r.out, null]; }
    return [r.out, nested(r, line, state)];
  }
  if (state?.html) {
    const end = line.indexOf("-->");
    if (end < 0) { r.add(line, "comment"); return [r.out, state]; }
    r.add(line.slice(0, end + 3), "comment"); inline(r, line.slice(end + 3), MD_INLINE); return [r.out, openComment(r.out)];
  }
  const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
  if (fence) { r.add(line, "marker"); return [r.out, { fence: fence[1], lang: labelled(fence[2]), inner: null }]; }
  if (/^ {0,3}#{1,6}(\s|$)/.test(line) || /^ {0,3}=+\s*$/.test(line)) { r.add(line, "heading"); return [r.out, null]; }
  if (line.trim() && /^ {0,3}(=+|-+)\s*$/.test(next ?? "") && !/^ {0,3}([-*+]|\d+[.)])\s/.test(line)) { r.add(line, "heading"); return [r.out, null]; }
  if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { r.add(line, "marker"); return [r.out, null]; }
  const lead = /^(\s*(?:>\s?)*)(\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s)?/.exec(line);
  r.add(lead[1], "marker"); r.add(lead[2], "marker");
  inline(r, line.slice(lead[0].length), MD_INLINE);
  return [r.out, openComment(r.out)];
}

const RST_INLINE = [
  [/^``[\s\S]+?``(?!\w)/, "literal", true],
  [/^:[\w:.+-]+:(?=`)/, "keyword", true],
  [/^`[^`]+`__?(?!\w)/, "link", true],
  [/^`[^`]+`/, "link", true],
  [/^\|[^|\s][^|]*\|(?:__?)?/, "constant", true],
  [/^\[(?:#?\w*|\*)\]_/, "link", true],
  [/^\*\*(?=\S)[\s\S]*?\S\*\*(?!\w)/, "emphasis", true],
  [/^\*(?=[^\s*])[\s\S]*?[^\s\\]\*(?!\w)/, "emphasis", true],
  [/^https?:\/\/[^\s<>`]+[^\s<>`.,;:!?)]/, "link", true],
];
const ADORNMENT = /^([!-/:-@[-`{-~])\1{2,}\s*$/;
const CODE = /^(?:code-block|code|sourcecode|highlight)$/;
const indentOf = (line) => /^\s*/.exec(line)[0].length;

// state: null, or { indent, kind: "literal" | "comment" | "code" | "directive", lang, inner } for an indented block
// below a line at `indent`; `body` once a directive is past its options.
function lexRst(line, state, next) {
  const r = runs();
  if (state && (!line.trim() || indentOf(line) > state.indent)) {
    if (!line.trim()) { r.add(line); return [r.out, state]; }
    if (state.kind === "comment") { r.add(line, "comment"); return [r.out, state]; }
    if (state.kind === "literal") { r.add(line, "literal"); return [r.out, state]; }
    const option = /^(\s*)(:[\w-]+:)/.exec(line);
    if (option && !state.body) { r.add(option[1]); r.add(option[2], "type"); r.add(line.slice(option[0].length)); return [r.out, state]; }
    if (state.kind === "code") return [r.out, { ...nested(r, line, state), body: true }];
    inline(r, line, RST_INLINE); return [r.out, { ...state, body: true }];
  }
  if (ADORNMENT.test(line)) { r.add(line, "heading"); return [r.out, null]; }
  if (line.trim() && !/^\s/.test(line) && ADORNMENT.test(next ?? "")) { r.add(line, "heading"); return [r.out, null]; }
  const explicit = /^(\s*)\.\.(\s+|$)(.*)$/.exec(line);
  if (explicit) {
    const indent = explicit[1].length, body = explicit[3], directive = /^(\|[^|]+\|\s+)?([\w:+-]+)::(\s*)(.*)$/.exec(body);
    r.add(explicit[1]);
    if (directive) {
      r.add(".." + explicit[2], "directive");
      if (directive[1]) r.add(directive[1], "constant");
      r.add(directive[2] + "::", "directive"); r.add(directive[3]); r.add(directive[4], CODE.test(directive[2]) ? "type" : null);
      return [r.out, CODE.test(directive[2]) ? { indent, kind: "code", lang: labelled(directive[4].trim()), inner: null } : { indent, kind: "directive" }];
    }
    if (/^(_[^:]*:|\[[^\]]*\])/.test(body)) { r.add(line.slice(indent), "link"); return [r.out, null]; }
    r.add(line.slice(indent), "comment"); return [r.out, { indent, kind: "comment" }];
  }
  const field = /^(\s*)(:[^:\s][^:]*:)(\s|$)/.exec(line);
  if (field) { r.add(field[1]); r.add(field[2], "type"); inline(r, line.slice(field[1].length + field[2].length), RST_INLINE); }
  else {
    const bullet = /^(\s*)([-*+•]|\d+[.)]|#\.)(\s+)/.exec(line);
    if (bullet) { r.add(bullet[1]); r.add(bullet[2], "marker"); r.add(bullet[3]); }
    inline(r, line.slice(bullet ? bullet[0].length : 0), RST_INLINE);
  }
  return [r.out, /::\s*$/.test(line) ? { indent: indentOf(line), kind: "literal" } : null];
}

const LINES = { ...LEXERS, markdown: lexMarkdown, rst: lexRst };
// A longer line (minified code, a generated table) is not lexed, since the lexers rescan the rest of a line at each
// token and their work grows with the square of its length. Its state is then unknown, so it and the rest draw plain.
const MAX_RUNS = 256, LONG = 4000;

// Runs for each line, carrying multi-line state from the first line. Lines past `budget` characters (newlines
// counted) get null, as do a line over LONG characters and those after it. On the UI thread, Herdr's engine lexes
// ordinary C at about 1,000 characters a millisecond; adversarial markup is slower. Joining a line's runs gives the line back; at most 255 coloured runs, then one plain rest.
export function highlightLines(lang, lines, budget = 200000) {
  const lex = LINES[lang];
  if (!lex) return lines.map(() => null);
  let state = null, used = 0;
  return lines.map((line, i) => {
    used += line.length > LONG ? Infinity : line.length + 1;
    if (used > budget) return null;
    let out;
    [out, state] = lex(line, state, lines[i + 1]);
    if (out.length > MAX_RUNS) out = [...out.slice(0, MAX_RUNS - 1), [out.slice(MAX_RUNS - 1).map(([text]) => text).join(""), null]];
    return out;
  });
}
