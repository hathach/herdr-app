// A panel part's own text size: its −/+ pill while hovered and ctrl+wheel over it. Every copy of this file is kept
// identical; the size rules are in part-math.js.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared, setShared, settings, props } from "herdr";
import { BASE, PART, baseKey, offsetKey, baseSize, offsetOf, partSize, stepOffset, wheelStep } from "./part-math.js";

export const panelSize = (panel) => baseSize(shared(baseKey(panel)));
export const partPx = (panel, part) => partSize(panelSize(panel), offsetOf(shared(offsetKey(panel, part))));
// Multiplies a px length designed at 13.
export const scaler = (px) => (n) => (n * px) / BASE.size;

// Code text uses the terminal's font, at the block's `code_font_size` prop, else the terminal's size (px at zoom 1),
// scaled with its part's `px`; row heights and character widths follow it, with ratios for a JetBrains Mono-like font.
export function codeMetrics(px) {
  const s = settings(), size = scaler(px)(Number(props()?.code_font_size) || Number(s.font_size) || 14);
  return { family: s.font_family ?? "JetBrains Mono", size, row: Math.round(size * 1.6), char: size * 0.62, numbers: Math.ceil(size * 0.62 * 4) };
}

// The pill sits in the part's top-right corner, the whole one clear of the scrollbar. A part that must keep its own
// controls clear of it leaves PILL_SLOT px free at its right: the whole pill's inset and width, plus a gap.
export const PILL_SLOT = 88;
const INSET = { full: 14, compact: 4 };
// Part widths (px) for the whole pill, then −/+ only; a narrower part keeps ctrl+wheel only.
const fitOf = (width) => (width >= 96 ? "full" : width >= 52 ? "compact" : null);

function step(panel, part, by) {
  const next = stepOffset(panelSize(panel), offsetOf(shared(offsetKey(panel, part))), by);
  if (next !== null) setShared(offsetKey(panel, part), next);
}

// `box` is the part's stationary frame (outside its scroller); it takes the part's text size. `ui` is the view's own
// { hovered, wheel, fits } state. The wheel layer sits above the content: native views (the editor) take the wheel
// before an ancestor would. code: the code text's px where it differs from the part's size; hide: while a splitter
// drag runs.
export function sizedPart(box, content, { ui, panel, part, label, t, code, hide }) {
  const id = `${panel}-${part}`, fit = (ui.fits ??= {})[id] ?? null;
  return box.id(`part-${id}`).relative().text_size(partPx(panel, part))
    .on_size_change((size, cx) => { const next = fitOf(size.width); if (ui.fits[id] !== next) { ui.fits[id] = next; cx.notify(); } })
    .on_hover((inside, cx) => {
      ui.wheel = 0;
      const next = inside ? id : ui.hovered === id ? null : ui.hovered;
      if (next !== ui.hovered) { ui.hovered = next; cx.notify(); }
    })
    .child(content)
    .child(div().id(`part-wheel-${id}`).absolute().inset_0().on_scroll_wheel((e, cx) => {
      if (!e.modifiers.control) { ui.wheel = 0; return; }
      cx.stop_propagation();
      const r = wheelStep(ui.wheel ?? 0, e);
      ui.wheel = r.acc;
      if (r.by) step(panel, part, r.by);
    }))
    .when(ui.hovered === id && !hide && Boolean(fit), (el) => el.child(pill(panel, part, label, t, code, fit)));
}

function pill(panel, part, label, t, code, fit) {
  const id = `${panel}-${part}`, px = partPx(panel, part);
  const info = `${label} ${px}px reference size${code && Math.abs(code - px) >= 0.05 ? ` · code ${Math.round(code * 10) / 10}px` : ""}`;
  const button = (key, glyph, tip, by, off) => div().id(`part-${key}-${id}`).w(22).h_full().flex().items_center().justify_center()
    .text_color(off ? t.dim : t.muted).when(!off, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .tooltip(`${info} · ${tip}`).on_click((_e, cx) => { cx.stop_propagation(); if (!off) step(panel, part, by); }).child(glyph);
  return h_flex().id(`part-pill-${id}`).absolute().top(4).right(INSET[fit]).h(22).items_center().rounded(6).overflow_hidden()
    .border_1().border_color(t.border).bg(t.popover).text_size(12)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(button("minus", "−", "Smaller (Ctrl+scroll down)", -1, px <= PART.min))
    .when(fit === "full", (el) => el.child(div().id(`part-reset-${id}`).h_full().px(4).flex().items_center().text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${info} · Reset to panel size (${panelSize(panel)}px)`)
      .on_click((_e, cx) => { cx.stop_propagation(); setShared(offsetKey(panel, part), null); })
      .child(String(px))))
    .child(button("plus", "+", "Larger (Ctrl+scroll up)", 1, px >= PART.max));
}
