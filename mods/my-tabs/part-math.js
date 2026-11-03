// Per-part text size: the panel's base (`panel.text_size.<panel>`, set by my-tabs' A−/A+) plus a part's own offset
// (`panel.text_offset.<panel>.<part>`). Sizes are px at zoom 1; every copy of this file is kept identical.
export const BASE = { size: 13, min: 10, max: 20 };
export const PART = { min: 8, max: 24 };
// Offsets that can reach every part size from every base.
export const OFFSET = { min: PART.min - BASE.max, max: PART.max - BASE.min };
// Trackpad pixels per step.
export const WHEEL_PX = 40;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const whole = (v, lo, hi, none) => (Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : none);

export const baseKey = (panel) => `panel.text_size.${panel}`;
export const offsetKey = (panel, part) => `panel.text_offset.${panel}.${part}`;
export const baseSize = (stored) => whole(stored, BASE.min, BASE.max, BASE.size);
export const offsetOf = (stored) => whole(stored, OFFSET.min, OFFSET.max, 0);
export const partSize = (base, offset) => clamp(base + offset, PART.min, PART.max);

// The offset to store for one step of `by` px, or null at a limit (nothing to store).
export function stepOffset(base, offset, by) {
  const now = partSize(base, offset), next = clamp(now + by, PART.min, PART.max);
  return next === now ? null : next - base;
}

// Folds one ctrl+wheel event into the running amount; `by` is the steps it completes. A wheel (line deltas) steps once
// per event, whatever its lines per notch; trackpad pixels step every WHEEL_PX, however the events are batched, and
// keep their remainder. Positive y is scrolling up, which grows the text; turning back drops what the other way had
// gathered.
export function wheelStep(acc, event) {
  const lines = event.delta_lines?.y;
  if (lines !== undefined) return { acc: 0, by: Math.sign(lines) || 0 };
  const amount = event.delta.y / WHEEL_PX;
  let total = acc * amount < 0 ? amount : acc + amount;
  const by = Math.trunc(total) || 0;
  total -= by;
  if (event.touch_phase === "ended" || event.touch_phase === "cancelled") total = 0;
  return { acc: total, by };
}
