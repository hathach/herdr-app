// Markdown helpers for the rendered preview. Pure (no herdr imports) so `node --test` loads it.

// Whether `s` is over `limit` UTF-8 bytes. A UTF-16 unit is 1 to 3 bytes, so length decides most strings; indexed, not
// for…of: Herdr interrupts a script task after 500 ms, and iterating 100k characters takes longer.
export function overBytes(s, limit) {
  if (s.length > limit) return true;
  if (s.length * 3 <= limit) return false;
  let n = s.length;
  for (let i = 0; i < s.length && n <= limit; i++) { const c = s.charCodeAt(i); if (c >= 0x80) n += c < 0x800 || (c >= 0xd800 && c < 0xe000) ? 1 : 2; }
  return n > limit;
}

// TextView lays a document out for seconds past this size, and a table past this many cells again on every redraw.
export const RENDER = { bytes: 128 * 1024, cells: 2000 };

// { md } to render, or { note }: why the source shows instead.
export function markdownDoc(md) {
  const note = overBytes(md, RENDER.bytes) ? `Over ${RENDER.bytes / 1024} KiB` : tableCells(md) > RENDER.cells ? `Tables over ${RENDER.cells} cells` : null;
  return note ? { note } : { md: alerts(md) };
}

const QUOTE = /^( {0,3}>)+ ?/;
const quoteDepth = (line) => (line.match(QUOTE)?.[0].match(/>/g) ?? []).length;

// Table cells, from each delimiter row (`|---|:-:|`, outer pipes optional): its columns times the rows that follow
// it while they hold a pipe, plus the header; quoted tables too. Delimiter-like lines in code count too, erring toward
// the source.
export function tableCells(md) {
  const lines = md.split("\n").map((line) => line.replace(QUOTE, ""));
  let cells = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^[\s|:-]+$/.test(line) || !line.includes("|") || !line.includes("-")) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].includes("|")) end++;
    cells += (end - i) * line.split("|").filter((c) => c.trim()).length;
    i = end - 1;
  }
  return cells;
}

// TextView has no GitHub alerts (`> [!NOTE]`, also pandoc's reST admonitions): their kind heads the quote instead,
// outside fenced code.
// A fence closes on a bare closer at its own quote depth, or when its quote ends.
export function alerts(md) {
  let fence = null;
  return md.split("\n").map((line) => {
    const depth = quoteDepth(line), body = line.replace(QUOTE, "");
    const open = body.match(/^ {0,3}(`{3,}|~{3,})/)?.[1], close = body.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
    if (fence && depth < fence.depth) fence = null;
    if (fence) {
      if (depth === fence.depth && close && close[0] === fence.mark[0] && close.length >= fence.mark.length) fence = null;
      return line;
    }
    if (open) { fence = { mark: open, depth }; return line; }
    const alert = line.match(/^(> *)\[!(\w)(\w*)\] *$/);
    return alert ? `${alert[1]}**${alert[2]}${alert[3].toLowerCase()}**  ` : line;
  }).join("\n");
}
