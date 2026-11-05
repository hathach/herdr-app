// A line range picked in the diff, to copy as a reference or as text. Pure (no herdr imports) so `node --test` loads
// it. A selection is { side: "old" | "new", anchor, head }: line numbers on that side, anchor where it started.
import { isCut } from "./diff.js";

export const lineOn = (row, side) => (side === "old" ? row?.old : row?.new);

export const span = (sel) => [Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)];

export function selects(sel, side, line) {
  if (!sel || sel.side !== side || line === undefined) return false;
  const [from, to] = span(sel);
  return line >= from && line <= to;
}

// The line a press picks: in side-by-side the column pressed (`half`), else the row's own side, a context row going
// with an old-side selection being extended. null for headers, reveal rows, markers and an empty half.
export function pickLine(item, { split, half, extendOld }) {
  if (split && item && "left" in item) {
    const side = half === "left" ? "old" : "new", line = lineOn(half === "left" ? item.left : item.right, side);
    return line === undefined ? null : { side, line };
  }
  if (item?.kind === "+") return { side: "new", line: item.new };
  if (item?.kind === "-") return { side: "old", line: item.old };
  if (item?.kind === " ") return extendOld ? { side: "old", line: item.old } : { side: "new", line: item.new };
  return null;
}

// Shift extends a selection on the same side; any other pick starts one.
export function nextSelection(sel, picked, shift) {
  if (!picked) return sel;
  if (shift && sel?.side === picked.side) return { ...sel, head: picked.line };
  return { side: picked.side, anchor: picked.line, head: picked.line };
}

// How many of the selection's lines no shown row holds: lines inside a collapsed gap.
export function hiddenCount(rows, sel) {
  const [from, to] = span(sel), shown = new Set();
  for (const row of rows) {
    const line = lineOn(row, sel.side);
    if (line >= from && line <= to) shown.add(line);
  }
  return to - from + 1 - shown.size;
}

// `path`, `path:L6` or `path:L6-L8`, with `@rev` when the lines come from a commit. rev: a short sha, null for the
// working tree, false when the lines are in no commit (an unborn repo's index): then there is no reference.
export function reference(path, sel, rev) {
  if (!sel) return path;
  if (rev === false) return null;
  const [from, to] = span(sel);
  return `${path}${rev ? `@${rev}` : ""}:L${from}${to > from ? `-L${to}` : ""}`;
}

// Whether every row's line, uncut, is its side's line: two reads of a diff can see different files.
export function sidesMatch(rows, sides) {
  for (const row of rows) {
    for (const side of ["old", "new"]) {
      const line = lineOn(row, side);
      if (line === undefined) continue;
      if (sides[side]?.[line - 1] !== row.raw) return false;
    }
  }
  return true;
}

export function lineCount(sel) {
  const [from, to] = span(sel);
  return `${to - from + 1} line${to > from ? "s" : ""}`;
}

const CHANGED = "The file changed; select again";

// The selected lines from the shown rows, which must hold every line uncut. -> { lines } or { reason }.
function rowLines(rows, sel) {
  const [from, to] = span(sel), raws = new Map();
  for (const row of rows) if (lineOn(row, sel.side) !== undefined) raws.set(lineOn(row, sel.side), row.raw);
  const out = [];
  for (let line = from; line <= to; line++) {
    const raw = raws.get(line);
    if (raw === undefined) return { reason: "Some of these lines are not loaded" };
    if (isCut(raw)) return { reason: "A line here is too long to copy from this view" };
    out.push(raw);
  }
  return { lines: out };
}

// Why the selection's text can't be copied, or null. `lines`: the side's whole original lines, or null.
export function textReason(lines, rows, sel) {
  if (lines) return span(sel)[1] <= lines.length ? null : CHANGED;
  return rowLines(rows, sel).reason ?? null;
}

// The selected lines' text, joined by "\n", from `lines` when given, else from the shown rows. -> { text } or { reason }.
export function selectedText(lines, rows, sel) {
  const [from, to] = span(sel);
  if (lines) return to <= lines.length ? { text: lines.slice(from - 1, to).join("\n") } : { reason: CHANGED };
  const out = rowLines(rows, sel);
  return out.reason ? out : { text: out.lines.join("\n") };
}
