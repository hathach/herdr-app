// node --no-warnings --test mods/my-changes/syntax.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { highlightLines, languageOf } from "./syntax.js";
import { diffRows, splitRows, wholeSides, colourSides, paint, CUT, parseNumstat, parseNameStatus } from "./diff.js";

// Each line as "text" with coloured pieces written [category:text].
const marked = (lang, text) => highlightLines(lang, text.split("\n")).map((runs) => runs.map(([t, c]) => (c ? `[${c}:${t}]` : t)).join(""));

test("my-files keeps an identical copy", () => {
  assert.equal(readFileSync(new URL("../my-files/syntax.js", import.meta.url), "utf8"), readFileSync(new URL("./syntax.js", import.meta.url), "utf8"));
});

test("languageOf", () => {
  assert.deepEqual(["a.c", "b.H", "x/y.hpp", "k.ino", "s.py", "r.MD", "d.rst", "Makefile", ".bashrc", "a.txt"].map(languageOf),
    ["c", "c", "cpp", "cpp", "python", "markdown", "rst", null, null, null]);
});

test("runs join back to each line", () => {
  const samples = { c: "int a; /* x\ny */ \"s\\\"\" 'c'\n#include <a.h>", cpp: 'R"d(x\n)d" u8"s"', python: 'x = """a\nb""" # c\n@d\ndef f(): pass',
    markdown: "# h\n```py\nx = 1\n```\n- *a* `b` [c](d)", rst: "T\n=\n.. note:: x\n   body\n:f: v\n``l`` :r:`t`" };
  for (const [lang, text] of Object.entries(samples)) {
    const lines = text.split("\n");
    highlightLines(lang, lines).forEach((runs, i) => assert.equal(runs.map(([t]) => t).join(""), lines[i], `${lang} ${i}`));
  }
});

test("C: comments, strings, preprocessor, words", () => {
  assert.deepEqual(marked("c", '#include <stdio.h>\nstatic int f(uint8_t x) { return 0x1Fu; } // c\n/* a\nb */ NULL;'), [
    "[keyword:#include] [string:<stdio.h>]",
    "[keyword:static] [type:int] [function:f]([type:uint8_t] x) { [keyword:return] [number:0x1Fu]; } [comment:// c]",
    "[comment:/* a]", "[comment:b */] [constant:NULL];"]);
  assert.deepEqual(marked("c", "// a \\\nstill\nx"), ["[comment:// a \\]", "[comment:still]", "x"]);
  assert.deepEqual(marked("c", '"a\\\nb" x'), ['[string:"a\\]', '[string:b"] x']);
});

test("C++: raw strings and keywords", () => {
  assert.deepEqual(marked("cpp", 'auto s = R"x(a\n)" still)x"; nullptr'), ['[keyword:auto] s = [string:R"x(a]', '[string:)" still)x"]; [constant:nullptr]']);
  assert.deepEqual(marked("c", "class x"), ["class x"]);
});

test("Python: triple quotes, decorators, def", () => {
  assert.deepEqual(marked("python", '@app.get("/")\ndef f(x=1):\n    """doc\n    more""" # c\nNone'), [
    '[function:@app.get]([string:"/"])', "[keyword:def] [function:f](x=[number:1]):", '    [string:"""doc]', '[string:    more"""] [comment:# c]', "[constant:None]"]);
});

test("Markdown: headings, fences with their language, inline", () => {
  assert.deepEqual(marked("markdown", "# T\n````c\nint x; /* a\n```\n````\nT2\n==\n> *e* `c` [l](u)"), [
    "[heading:# T]", "[marker:````c]", "[type:int] x; [comment:/* a]", "[comment:```]", "[marker:````]", "[heading:T2]", "[heading:==]",
    "[marker:> ][emphasis:*e*] [literal:`c`] [link:[l](u)]"]);
  assert.deepEqual(marked("markdown", "```\n# not a heading\n```"), ["[marker:```]", "[literal:# not a heading]", "[marker:```]"]);
});

test("reST: titles, directives, code blocks, literal blocks, comments", () => {
  assert.deepEqual(marked("rst", "Title\n=====\n.. code-block:: python\n   :linenos:\n\n   def f(): pass\nText::\n\n   lit\n.. a comment\n   more\nA ``l`` :ref:`t`."), [
    "[heading:Title]", "[heading:=====]", "[directive:.. code-block::] [type:python]", "   [type::linenos:]", "",
    "   [keyword:def] [function:f](): [keyword:pass]", "Text::", "", "[literal:   lit]", "[comment:.. a comment]", "[comment:   more]",
    "A [literal:``l``] [keyword::ref:][link:`t`]."]);
});

test("limits: budget and runs per line", () => {
  assert.deepEqual(highlightLines("c", ["int a;", "int b;"], 8), [[["int", "type"], [" a;", null]], null]);
  const runs = highlightLines("c", ["a(1)".repeat(200)])[0];
  assert.equal(runs.length, 256);
  assert.equal(runs.map(([t]) => t).join(""), "a(1)".repeat(200));
  assert.equal(runs[255][1], null);
  assert.deepEqual(highlightLines("go", ["x"]), [null]);
});

const full = (body) => `diff --git a/f.c b/f.c\n--- a/f.c\n+++ b/f.c\n${body}\n`;

test("wholeSides needs one hunk from line 1 with its counts", () => {
  assert.deepEqual(wholeSides(full("@@ -1,2 +1,2 @@\n a\n-b\n+c")), { old: ["a", "b"], new: ["a", "c"] });
  assert.deepEqual(wholeSides(full("@@ -0,0 +1 @@\n+x")), { old: [], new: ["x"] });
  assert.deepEqual(wholeSides(full("@@ -1 +0,0 @@\n-x\n\\ No newline at end of file")), { old: ["x"], new: [] });
  assert.deepEqual(wholeSides(full("@@ -5,2 +5,2 @@\n a\n-b\n+c")), { old: null, new: null });
  assert.deepEqual(wholeSides(full("@@ -1,3 +1,3 @@\n a\n-b\n+c")), { old: null, new: null });
  assert.deepEqual(wholeSides(full("@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d")), { old: null, new: null });
  assert.deepEqual(wholeSides(""), { old: null, new: null });
});

test("paint: a hunk inside a block comment, per side", () => {
  // The old side opens a comment on line 1 that the new side removed; line 3 is context in both.
  const sides = wholeSides(full("@@ -1,3 +1,3 @@\n-/* open\n+int x;\n x */\n y"));
  const rows = paint(diffRows(["@@ -2,2 +2,2 @@", " x */", " y"]), colourSides(sides, "c"));
  assert.deepEqual(rows[1].oldRuns, [["x */", "comment"]]);
  assert.deepEqual(rows[1].newRuns, [["x */", null]]);
  assert.deepEqual(rows[2].oldRuns, [["y", null]]);
  assert.equal(rows[0].oldRuns, undefined);
});

test("paint: cut lines, empty lines, mismatches, missing sides", () => {
  const long = "int " + "a".repeat(10);
  const sides = colourSides({ old: null, new: [long, "", "int b;"] }, "c");
  const rows = paint(diffRows(["@@ -0,0 +1,3 @@", "+int aaa" + CUT, "+", "+int c;"]), sides);
  assert.deepEqual(rows[1].newRuns, [["int", "type"], [" aaa", null], [CUT, null]]);
  assert.deepEqual(rows[2].newRuns, []);
  assert.equal(rows[2].text, " ");
  assert.equal(rows[3].newRuns, null);
  const del = paint(diffRows(["@@ -1 +0,0 @@", "-int a;"]), sides);
  assert.equal(del[1].oldRuns, null);
});

test("splitRows keeps both sides' rows", () => {
  const pairs = splitRows(diffRows(["@@ -1,2 +1,2 @@", " a", "-b", "+c"]));
  assert.equal(pairs[1].left, pairs[1].right);
  assert.deepEqual([pairs[2].left.raw, pairs[2].right.raw], ["b", "c"]);
});

test("highlightLines stops at its deadline: a line keeps its text, later lines get null", () => {
  assert.deepEqual(highlightLines("markdown", ["a *b*", "c"], undefined, 0), [null, null]);
  const now = Date.now, line = "x " + "[".repeat(300);
  let calls = 0;
  // The per-line check and two of inline()'s pass; the deadline passes at the third, mid-line.
  Date.now = () => (++calls > 3 ? 100 : 0);
  try {
    const [first, second] = highlightLines("markdown", [line, "*b*"], undefined, 50);
    assert.equal(first.map(([text]) => text).join(""), line);
    assert.equal(first.at(-1)[1], null);
    assert.equal(second, null);
  } finally { Date.now = now; }
});

test("parseNumstat sums outputs and keeps tabs in paths; parseNameStatus maps statuses", () => {
  const staged = ["1\t2\ta\tb.c", "-\t-\tlogo.png", ""].join("\0"), unstaged = ["3\t0\ta\tb.c", ""].join("\0");
  assert.deepEqual(parseNumstat([staged, unstaged]), { "a\tb.c": { add: 4, del: 2, binary: false }, "logo.png": { add: 0, del: 0, binary: true } });
  assert.deepEqual(parseNameStatus(["A", "new file", "D", "gone", "T", "typed", "U", "both", ""].join("\0")).map((f) => [f.path, f.status]),
    [["new file", "A"], ["gone", "D"], ["typed", "M"], ["both", "U"]]);
});

test("a no-newline marker is tinted as the change it follows, never after context", () => {
  const rows = diffRows(["@@ -1,2 +1,2 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file", " c", "\\ No newline at end of file"]);
  assert.deepEqual(rows.map((r) => r.tint), [undefined, undefined, "-", undefined, "+", undefined, undefined]);
  const pairs = splitRows(rows);
  assert.deepEqual(pairs.slice(1, 3).map((p) => [p.left?.text, p.right?.text]), [["a", "b"], ["\\ No newline at end of file", "\\ No newline at end of file"]]);
  assert.deepEqual([pairs[2].left.tint, pairs[2].right.tint, pairs[4].kind], ["-", "+", ""]);
});

test("Markdown HTML comments: across lines, never from inside a code span", () => {
  assert.deepEqual(marked("markdown", "a <!-- b\nc -->d\nUse `<!--` here.\nprose"), ["a [comment:<!-- b]", "[comment:c -->]d", "Use [literal:`<!--`] here.", "prose"]);
  assert.deepEqual(marked("markdown", "x <!-- y --> z\nw"), ["x [comment:<!-- y -->] z", "w"]);
  assert.deepEqual(marked("markdown", "<!-- a\n--> <!-- b\nc\n-->"), ["[comment:<!-- a]", "[comment:-->] [comment:<!-- b]", "[comment:c]", "[comment:-->]"]);
});

test("CRLF lines keep backslash continuation", () => {
  assert.deepEqual(highlightLines("c", ["// a \\\r", "int b;\r", "int c;\r"]).map((runs) => runs.map(([, c]) => c)), [["comment"], ["comment"], ["type", null]]);
  assert.deepEqual(highlightLines("python", ['x = "a\\\r', 'b"\r'])[1], [['b"', "string"], ["\r", null]]);
});

test("long lines draw plain, keep the state, and stay fast", () => {
  assert.deepEqual(highlightLines("c", ["/* open", "x".repeat(4001) + " */", "int a;"]), [[["/* open", "comment"]], null, null]);
  for (const lang of ["markdown", "rst", "c", "python"]) {
    const start = Date.now();
    highlightLines(lang, ["[".repeat(4000), "`".repeat(4000), "*".repeat(4000), '"'.repeat(3999)]);
    assert.ok(Date.now() - start < 1000, `${lang} took ${Date.now() - start} ms`);
  }
});
