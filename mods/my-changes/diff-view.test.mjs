// node --no-warnings --test mods/my-changes/diff-view.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, splitRows, diffView, revealFor, paint, wholeSides, colourSides, fullRows, hunkEnd, STEP, CUT } from "./diff.js";

const keep = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => ` l${a + i}`);
// A whole-file diff's rows, its @@ row left out, as fullRows gives them.
const rowsOf = (lines) => diffRows(lines).slice(1);
// Headers and control rows by text, other rows as kind + old/new numbers.
const shape = (rows) => rows.map((r) => (r.kind === "@" || r.kind === "more" ? r.text : `${r.kind || "\\"}${r.old ?? "_"}/${r.new ?? "_"}`));
const at = (rows, key) => rows.find((r) => r.key === key);

// 40 lines, line 10 and 30 changed.
const twoChanges = rowsOf(["@@ -1,40 +1,40 @@", ...keep(1, 9), "-o10", "+n10", ...keep(11, 29), "-o30", "+n30", ...keep(31, 40)]);

test("each change shows three lines either side, with controls into every gap", () => {
  const { rows, gaps } = diffView(twoChanges, new Map());
  assert.deepEqual([...gaps.keys()], ["1:1-6:6", "14:14-26:26", "34:34-40:40"]);
  assert.deepEqual(shape(rows), ["@@ -7,7 +7,7 @@  ↑ Show 6 preceding lines", " 7/7", " 8/8", " 9/9", "-10/_", "+_/10", " 11/11", " 12/12", " 13/13",
    "↓ Show 13 following lines", "@@ -27,7 +27,7 @@  ↑ Show 13 preceding lines", " 27/27", " 28/28", " 29/29", "-30/_", "+_/30", " 31/31", " 32/32", " 33/33",
    "↓ Show 7 following lines"]);
  assert.deepEqual(rows.filter((r) => r.dir).map((r) => [r.key, r.gap, r.step]),
    [["up:1:1-6:6", "1:1-6:6", 6], ["down:14:14-26:26", "14:14-26:26", 13], ["up:14:14-26:26", "14:14-26:26", 13], ["down:34:34-40:40", "34:34-40:40", 7]]);
});

test("reveals open a gap from either edge and merge the windows once it is shown", () => {
  const reveal = new Map();
  let view = diffView(twoChanges, reveal);
  const down = revealFor(at(view.rows, "down:14:14-26:26"), reveal);
  assert.deepEqual(down, { top: 13, bottom: 0 });
  reveal.set("14:14-26:26", down);
  view = diffView(twoChanges, reveal);
  assert.equal(view.gaps.has("14:14-26:26"), false);
  assert.deepEqual(shape(view.rows).filter((s) => s.startsWith("@@")), ["@@ -7,27 +7,27 @@  ↑ Show 6 preceding lines"]);
  // The top gap opens upwards from its end.
  assert.deepEqual(revealFor(at(view.rows, "up:1:1-6:6"), reveal), { top: 0, bottom: 6 });
});

test("a long gap opens STEP lines a click, from each side", () => {
  const rows = rowsOf(["@@ -1,60 +1,60 @@", "-o1", "+n1", ...keep(2, 59), "-o60", "+n60"]);
  const reveal = new Map(), id = "5:5-56:56";
  let view = diffView(rows, reveal);
  assert.equal(view.gaps.get(id), 52);
  for (const [dir, want] of [["down", { top: STEP, bottom: 0 }], ["up", { top: STEP, bottom: STEP }]]) {
    const next = revealFor(at(view.rows, `${dir}:${id}`), reveal);
    assert.deepEqual(next, want);
    reveal.set(id, next); view = diffView(rows, reveal);
  }
  assert.equal(view.gaps.get(id), 12);
  assert.ok(shape(view.rows).includes("↓ Show 12 following lines"));
  // The last click takes only what is left, and the windows merge.
  reveal.set(id, revealFor(at(view.rows, `down:${id}`), reveal));
  view = diffView(rows, reveal);
  assert.equal(view.gaps.size, 0);
  assert.equal(shape(view.rows).filter((s) => s.startsWith("@@")).length, 1);
});

test("rows other than the controls reveal nothing", () => {
  const view = diffView(twoChanges, new Map());
  assert.equal(revealFor(view.rows.find((r) => r.kind === " "), new Map()), null);
  assert.equal(revealFor(view.rows.find((r) => r.kind === "@" && !r.dir), new Map()), null);
  assert.equal(revealFor(undefined, new Map()), null);
});

test("a moved gap drops its reveal: its id is both its edges", () => {
  const reveal = new Map([["14:14-26:26", { top: 13, bottom: 0 }]]);
  const moved = rowsOf(["@@ -1,40 +1,41 @@", ...keep(1, 9), "-o10", "+n10", "+n10b", ...keep(11, 29), "-o30", "+n30", ...keep(31, 40)]);
  assert.ok(diffView(moved, reveal).gaps.has("14:15-26:27"));
});

test("headers count real lines; an insertion at the top or the end of a file", () => {
  const top = rowsOf(["@@ -1,8 +1,9 @@", "+n0", ...keep(1, 8)]);
  assert.deepEqual(shape(diffView(top, new Map()).rows).slice(0, 2), ["@@ -1,3 +1,4 @@", "+_/1"]);
  assert.ok(shape(diffView(top, new Map()).rows).includes("↓ Show 5 following lines"));
  const end = rowsOf(["@@ -1,8 +1,9 @@", ...keep(1, 8), "+n9"]);
  assert.deepEqual(shape(diffView(end, new Map()).rows), ["@@ -6,3 +6,4 @@  ↑ Show 5 preceding lines", " 6/6", " 7/7", " 8/8", "+_/9"]);
  // An emptied file: one side has no lines at all.
  const gone = rowsOf(["@@ -1,2 +0,0 @@", "-a", "-b"]);
  assert.deepEqual(shape(diffView(gone, new Map()).rows), ["@@ -1,2 +0,0 @@", "-1/_", "-2/_"]);
});

test("a no-newline marker stays with its line and counts as none", () => {
  const rows = rowsOf(["@@ -1,9 +1,9 @@", ...keep(1, 8), "-o9", "\\ No newline at end of file", "+n9", "\\ No newline at end of file"]);
  const view = diffView(rows, new Map());
  assert.deepEqual(shape(view.rows), ["@@ -6,4 +6,4 @@  ↑ Show 5 preceding lines", " 6/6", " 7/7", " 8/8", "-9/_", "\\_/_", "+_/9", "\\_/_"]);
  // A marker after an unchanged last line hides and shows with it.
  const tail = rowsOf(["@@ -1,9 +1,9 @@", "-o1", "+n1", ...keep(2, 9), "\\ No newline at end of file"]);
  assert.deepEqual(shape(diffView(tail, new Map()).rows).slice(-1), ["↓ Show 5 following lines"]);
  assert.deepEqual(shape(diffView(tail, new Map([["5:5-9:9", { top: 5, bottom: 0 }]])).rows).slice(-2), [" 9/9", "\\_/_"]);
});

test("revealed lines keep their colours, and split rows keep their keys", () => {
  const body = ["@@ -1,8 +1,8 @@", "-int a;", "+int b;", ...Array.from({ length: 7 }, (_, i) => ` int c${i};`)];
  const rows = rowsOf(body), sides = wholeSides(`diff\n${body.join("\n")}\n`);
  paint(rows, colourSides(sides, "c"));
  const view = diffView(rows, new Map([["5:5-8:8", { top: 4, bottom: 0 }]]));
  assert.ok(view.rows.filter((r) => r.kind === " ").every((r) => r.newRuns?.some(([, c]) => c)));
  const keys = splitRows(view.rows).map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.slice(0, 2), ["h0", "r1"]);
});

const patch = (body) => `diff --git a/f b/f\n--- a/f\n+++ b/f\n${body.join("\n")}\n`;
const forty = ["@@ -1,40 +1,40 @@", ...keep(1, 9), "-o10", "+n10", ...keep(11, 29), "-o30", "+n30", ...keep(31, 40)];

test("fullRows takes only a whole diff within its limits", () => {
  assert.deepEqual(shape(fullRows(patch(forty))), shape(twoChanges));
  assert.equal(fullRows(patch(["@@ -5,2 +5,2 @@", " a", "-b", "+c"])), null);
  assert.equal(fullRows("not a diff"), null);
  // The header's counts turn a long file away before it is split.
  assert.equal(fullRows(patch(["@@ -1,20001 +1,20001 @@", " a"])), null);
  assert.equal(fullRows(patch(forty), 39), null);
  assert.ok(fullRows(patch(forty), 40));
  // Its view before any reveal is 20 rows: too long for 19, so the plain diff shows instead.
  assert.equal(fullRows(patch(forty), 20000, 19), null);
  assert.ok(fullRows(patch(forty), 20000, 20));
  const long = fullRows(patch(["@@ -1 +1 @@", "-a", `+${"x".repeat(5000)}`]));
  assert.ok(long[1].raw.endsWith(CUT));
});

test("a refresh to the same diff keeps what was revealed; colours arriving later keep it too", () => {
  const reveal = new Map([["14:14-26:26", { top: 13, bottom: 0 }]]);
  const before = shape(diffView(fullRows(patch(forty)), reveal).rows);
  const again = fullRows(patch(forty));
  assert.deepEqual(shape(diffView(again, reveal).rows), before);
  paint(again, colourSides(wholeSides(patch(forty)), "c"));
  assert.deepEqual(shape(diffView(again, reveal).rows), before);
});

test("hunkEnd is the furthest line the compact diff reaches", () => {
  assert.equal(hunkEnd(["@@ -1,3 +1,4 @@", " a", "@@ -40,2 +41,5 @@ fn", " b"]), 45);
  assert.equal(hunkEnd(["@@ -7 +7 @@", "-a", "+b"]), 7);
  assert.equal(hunkEnd(["@@ -0,0 +1,2 @@", "+a", "+b"]), 2);
  assert.equal(hunkEnd([]), 0);
});

test("a control's key names its file's view, not just its lines", () => {
  const a = diffView(twoChanges, new Map(), "1:"), b = diffView(twoChanges, new Map(), "2:");
  const queued = a.rows.find((r) => r.dir).key;
  assert.equal(queued, "1:up:1:1-6:6");
  assert.equal(b.rows.find((r) => r.key === queued), undefined);
});
