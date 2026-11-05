// node --no-warnings --test mods/my-changes/selection.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, splitRows, diffView, fullRows, cutLine, CUT } from "./diff.js";
import { pickLine, nextSelection, selects, span, hiddenCount, reference, selectedText, textReason, sidesMatch } from "./selection.js";

// Old lines 1-5, new lines 1-6: line 3 replaced by two lines, so the sides' numbers differ below it.
const rows = diffRows(["@@ -1,5 +1,6 @@", " a", " b", "-c", "+C1", "+C2", " d", " e"]);
const row = (kind, n) => rows.find((r) => r.kind === kind && (kind === "-" ? r.old : r.new) === n);
const unified = { split: false };

test("a unified row picks its own side; context goes new unless an old-side selection extends", () => {
  assert.deepEqual(pickLine(row("+", 4), unified), { side: "new", line: 4 });
  assert.deepEqual(pickLine(row("-", 3), unified), { side: "old", line: 3 });
  const d = row(" ", 5);
  assert.deepEqual(pickLine(d, unified), { side: "new", line: 5 });
  assert.deepEqual(pickLine(d, { ...unified, extendOld: true }), { side: "old", line: 4 });
  assert.equal(pickLine(rows[0], unified), null);
  assert.equal(pickLine({ kind: "", text: "\\ No newline at end of file" }, unified), null);
  assert.equal(pickLine({ kind: "more", text: "↓ Show 20 following lines" }, unified), null);
});

test("a side-by-side pair picks the column pressed; an empty half picks nothing", () => {
  const pairs = splitRows(rows), changed = pairs.find((p) => p.left?.kind === "-"), extra = pairs.find((p) => p.right?.new === 4 && !p.left);
  assert.deepEqual(pickLine(changed, { split: true, half: "left" }), { side: "old", line: 3 });
  assert.deepEqual(pickLine(changed, { split: true, half: "right" }), { side: "new", line: 3 });
  assert.equal(pickLine(extra, { split: true, half: "left" }), null);
  const context = pairs.find((p) => p.left?.old === 4);
  assert.deepEqual(pickLine(context, { split: true, half: "left" }), { side: "old", line: 4 });
  assert.deepEqual(pickLine(context, { split: true, half: "right" }), { side: "new", line: 5 });
  assert.equal(pickLine(pairs[0], { split: true, half: "left" }), null);
});

test("shift extends from the anchor on the same side; the other side starts over", () => {
  let sel = nextSelection(null, { side: "new", line: 10 }, false);
  sel = nextSelection(sel, { side: "new", line: 6 }, true);
  assert.deepEqual(span(sel), [6, 10]);
  sel = nextSelection(sel, { side: "new", line: 12 }, true);
  assert.deepEqual(span(sel), [10, 12]);
  assert.deepEqual(nextSelection(sel, { side: "old", line: 3 }, true), { side: "old", anchor: 3, head: 3 });
  assert.deepEqual(nextSelection(sel, { side: "new", line: 2 }, false), { side: "new", anchor: 2, head: 2 });
  assert.equal(nextSelection(sel, null, true), sel);
  assert.ok(selects(sel, "new", 11));
  assert.ok(!selects(sel, "old", 11));
  assert.ok(!selects(sel, "new", 9));
});

test("references: working tree plain, commit lines with @sha, none for index-only lines", () => {
  const one = { side: "new", anchor: 6, head: 6 }, range = { side: "old", anchor: 8, head: 6 };
  assert.equal(reference("my dir/settings.json", null, null), "my dir/settings.json");
  assert.equal(reference("settings.json", one, null), "settings.json:L6");
  assert.equal(reference("settings.json", range, "69557f2"), "settings.json@69557f2:L6-L8");
  assert.equal(reference("settings.json", range, false), null);
});

test("text comes whole from the side's lines, without numbers, prefixes or a trailing newline", () => {
  const lines = ["a", "", "\tc  ", "ü " + "x".repeat(5000), "e"];
  assert.deepEqual(selectedText(lines, [], { side: "new", anchor: 4, head: 2 }), { text: ["", "\tc  ", lines[3]].join("\n") });
  assert.ok(selectedText(lines, [], { side: "new", anchor: 5, head: 6 }).reason);
});

test("without whole lines, text comes from shown rows only when every line is there and uncut", () => {
  assert.deepEqual(selectedText(null, rows, { side: "old", anchor: 2, head: 4 }), { text: "b\nc\nd" });
  assert.deepEqual(selectedText(null, rows, { side: "new", anchor: 3, head: 4 }), { text: "C1\nC2" });
  const gap = diffRows(["@@ -1,2 +1,2 @@", " a", " b", "@@ -9,1 +9,1 @@", " i"]);
  assert.ok(selectedText(null, gap, { side: "new", anchor: 2, head: 9 }).reason);
  const long = diffRows(["@@ -1 +1 @@", cutLine(`+${"x".repeat(5000)}`)]);
  assert.ok(long[1].raw.endsWith(CUT));
  assert.ok(selectedText(null, long, { side: "new", anchor: 1, head: 1 }).reason);
  // A short line that only looks like a cut one copies as it is.
  const looks = diffRows(["@@ -1 +1 @@", `+see ${CUT}`]);
  assert.deepEqual(selectedText(null, looks, { side: "new", anchor: 1, head: 1 }), { text: `see ${CUT}` });
});

test("a selection over a collapsed gap counts its hidden lines, and copies them from the whole side", () => {
  const keep = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => ` l${a + i}`);
  const text = `diff --git a/f b/f\n--- a/f\n+++ b/f\n${["@@ -1,40 +1,40 @@", ...keep(1, 9), "-o10", "+n10", ...keep(11, 29), "-o30", "+n30", ...keep(31, 40)].join("\n")}\n`;
  const full = fullRows(text), view = diffView(full.rows, new Map()).rows, sel = { side: "new", anchor: 12, head: 28 };
  assert.equal(hiddenCount(view, sel), 13);
  assert.equal(selectedText(full.sides.new, view, sel).text.split("\n").length, 17);
  assert.equal(hiddenCount(view, { side: "new", anchor: 9, head: 11 }), 0);
});

test("rows match whole sides only when every line is the same", () => {
  const sides = { old: ["a", "b", "c", "d", "e"], new: ["a", "b", "C1", "C2", "d", "e"] };
  assert.ok(sidesMatch(rows, sides));
  assert.ok(!sidesMatch(rows, { ...sides, new: ["a", "b", "C1", "changed", "d", "e"] }));
  assert.ok(!sidesMatch(rows, { ...sides, old: ["a", "b"] }));
  // Uncut rows: two long lines alike for their first 4,000 characters still differ.
  const long = "x".repeat(5000), longRows = diffRows(["@@ -1 +1 @@", `+${long}A`]);
  assert.ok(sidesMatch(longRows, { old: [], new: [`${long}A`] }));
  assert.ok(!sidesMatch(longRows, { old: [], new: [`${long}B`] }));
});

test("textReason says why text can't be copied, or null", () => {
  assert.equal(textReason(null, rows, { side: "new", anchor: 1, head: 3 }), null);
  const gap = diffRows(["@@ -1,2 +1,2 @@", " a", " b", "@@ -9,1 +9,1 @@", " i"]);
  assert.match(textReason(null, gap, { side: "new", anchor: 2, head: 9 }), /not loaded/);
  assert.equal(textReason(["a", "b"], [], { side: "new", anchor: 1, head: 2 }), null);
});
