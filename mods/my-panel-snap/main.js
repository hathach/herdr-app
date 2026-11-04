// Snaps the side panel to the nearest twelfth of the work area (1/12..11/12) when a drag ends.
import { View, div } from "gpui-kit";
import { appHome, layout, run, watchFolder } from "herdr";

const twelfth = (share) => Math.min(11, Math.max(1, Math.round(share * 12))) / 12;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function snap() {
  const root = layout(), panel = find(root, "panel"), main = find(root, "main");
  const wp = panel?.size?.weight, wm = main?.size ? main.size.weight : 1;
  if (!panel || panel.hidden || !wp || !wm) return;
  const share = wp / (wp + wm), target = twelfth(share);
  if (Math.abs(share - target) > 1e-3) run("layout.resize", { id: "panel", weight: wm * target / (1 - target) });
}

export default class PanelSnap extends View {
  init(_props, cx) {
    // Herdr saves layout clicks when a drag ends, not while it runs; rendering follows every live change, mid-drag too.
    cx.spawn(async () => { for (;;) { await watchFolder(`${appHome()}/layouts/.state`); snap(); } });
  }

  render() {
    return div();
  }
}
