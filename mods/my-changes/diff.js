// Diff rows for the Changes panel and their syntax colours. Pure (no herdr imports) so `node --test` loads it.
import { highlightLines } from "./syntax.js";

export const CUT = "… (line truncated)";

// `--numstat -z` outputs -> { path: { add, del, binary } }, summed across them (staged plus unstaged).
export function parseNumstat(texts) {
  const stats = {};
  for (const text of texts) {
    for (const entry of text.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

// `--name-status -z --no-renames` -> files { path, status: A | D | U | M, fresh: false }.
export function parseNameStatus(text) {
  const parts = text.split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ path: parts[i + 1], status: "ADU".includes(parts[i][0]) ? parts[i][0] : "M", fresh: false });
  return files;
}

// Numbers each diff line once, so a frame only draws the rows on screen. `raw` keeps the line's own text; `text` is
// what is drawn (an empty line draws as one space).
export function diffRows(lines) {
  let old = 0, next = 0, before = null;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line), kind = match ? "@" : line[0], raw = line.slice(1), last = before;
    before = kind;
    if (match) { old = +match[1]; next = +match[2]; return { kind, text: line }; }
    if (kind === "-") return { kind, old: old++, raw, text: raw || " " };
    if (kind === "+") return { kind, new: next++, raw, text: raw || " " };
    if (kind === " ") return { kind, old: old++, new: next++, raw, text: raw || " " };
    // A "\ No newline at end of file" marker belongs to the change it follows: same side, same tint.
    return line.startsWith("\\") && (last === "+" || last === "-") ? { kind: "", text: line, tint: last } : { kind: "", text: line };
  });
}

// Pairs each run of removed lines with the added lines after it: old on the left, new on the right.
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind !== "-" && row.kind !== "+") {
      out.push(row.kind === " " ? { left: row, right: row } : row);
      i++; continue;
    }
    const take = (kind, list) => { while (rows[i]?.kind === kind || rows[i]?.tint === kind) list.push(rows[i++]); };
    const del = [], add = [];
    take("-", del); take("+", add);
    for (let j = 0; j < Math.max(del.length, add.length); j++) out.push({ left: del[j], right: add[j] });
  }
  return out;
}

// A whole-file diff (`--unified=<more lines than the file>`) -> both sides' lines, each null unless it is complete:
// one hunk from line 1 whose line count matches its header (git may still split a huge file, or output may be cut).
export function wholeSides(text) {
  const lines = text.split("\n"), at = lines.findIndex((l) => l.startsWith("@@"));
  const header = at >= 0 && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]);
  if (!header || lines.slice(at + 1).some((l) => l.startsWith("@@"))) return { old: null, new: null };
  const old = [], next = [];
  for (const line of lines.slice(at + 1)) {
    if (line[0] === " ") { old.push(line.slice(1)); next.push(line.slice(1)); }
    else if (line[0] === "-") old.push(line.slice(1));
    else if (line[0] === "+") next.push(line.slice(1));
  }
  const whole = (start, count = "1", list) => (+start === 1 || +count === 0) && list.length === +count ? list : null;
  return { old: whole(header[1], header[2], old), new: whole(header[3], header[4], next) };
}

// Runs for each side's whole lines, once per load: { old, new }, each { lines, runs } or null. Both sides are lexed in
// one script task, so they share one deadline.
export function colourSides(sides, lang) {
  const deadline = Date.now() + 250, side = (lines) => lines && { lines, runs: highlightLines(lang, lines, undefined, deadline) };
  return { old: side(sides.old), new: side(sides.new) };
}

function clip(runs, length) {
  const out = [];
  for (const [text, category] of runs) {
    if (length <= 0) break;
    out.push([text.slice(0, length), category]); length -= text.length;
  }
  return out;
}

// A shown line's runs: its side's line must be the same text, or begin with it where the display cut the line.
function runsFor(raw, side, number) {
  const line = side?.lines[number - 1], runs = side?.runs[number - 1];
  if (line === undefined || !runs) return null;
  if (raw === line) return runs;
  const shown = raw.endsWith(CUT) ? raw.slice(0, -CUT.length) : null;
  return shown !== null && line.startsWith(shown) ? [...clip(runs, shown.length), [CUT, null]] : null;
}

// Gives each row the runs of its line on each side it shows: `-` old, `+` new, context both (its text is the same,
// but a change above it can leave the two sides in different states, an open comment say).
export function paint(rows, coloured) {
  for (const row of rows) {
    if (row.old !== undefined) row.oldRuns = runsFor(row.raw, coloured.old, row.old);
    if (row.new !== undefined) row.newRuns = runsFor(row.raw, coloured.new, row.new);
  }
  return rows;
}
