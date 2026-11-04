// Where a panel's list sits beside its other part, and the splitter's share between them. Every copy of this file is
// kept identical.

// far: the list sits at the end of the body, so its share counts back from that edge.
export const SIDES = { left: { direction: "flex_row", axis: "across", cursor: "cursor_col_resize" },
  top: { direction: "flex_col", axis: "down", cursor: "cursor_row_resize" },
  right: { direction: "flex_row_reverse", axis: "across", cursor: "cursor_col_resize", far: true },
  bottom: { direction: "flex_col_reverse", axis: "down", cursor: "cursor_row_resize", far: true } };
const ORDER = Object.keys(SIDES);

export const nextSide = (side) => ORDER[(ORDER.indexOf(side) + 1) % ORDER.length];
export const sideOf = (stored) => (ORDER.includes(stored) ? stored : "top");
// The height share keeps the key it had before the list could move.
export const shareKey = (listKey, axis) => (axis === "down" ? listKey : `${listKey}:${axis}`);

// A splitter's share lands on the nearest twelfth when its drag ends, like the side panel's, and stays within
// 1/12..11/12.
export const twelfth = (share) => Math.min(11, Math.max(1, Math.round(share * 12))) / 12;
export const shareOf = (stored, fallback) => {
  const share = Number(stored);
  return share >= 1 / 12 && share <= 11 / 12 ? twelfth(share) : fallback;
};

// The list's share for a pointer at `local` in a body of `bounds`; null while the body has no size yet.
export function shareAt(side, local, bounds) {
  const { axis, far } = SIDES[side], size = axis === "across" ? bounds?.width : bounds?.height;
  if (!local || !size) return null;
  const at = (axis === "across" ? local.x : local.y) / size;
  return Math.min(11 / 12, Math.max(1 / 12, far ? 1 - at : at));
}
