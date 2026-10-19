import type { Map as LibreMap, Popup } from "maplibre-gl";

/** Native left/right anchors can overflow a narrow split-screen map even when
 * the card fits. Keep the readable card inside the map without moving its camera. */
export function keepPopupInMap(map: LibreMap, popup: Popup) {
  const update = () => {
    const element = popup.getElement();
    const bounds = map.getContainer().getBoundingClientRect();
    if (!element || bounds.width === 0) return;
    // MapLibre owns transform; translate is an independent, non-accumulating fix.
    element.style.translate = "";
    const card = element.getBoundingClientRect();
    const shift = Math.max(
      bounds.left + 12 - card.left,
      Math.min(0, bounds.right - 12 - card.right),
    );
    element.style.translate = `${shift}px 0`;
    element.toggleAttribute("data-horizontal-clamp", shift !== 0);
  };
  popup.on("open", () => {
    update();
    map.on("move", update);
    map.on("resize", update);
    map.on("idle", update);
  });
  popup.on("close", () => {
    map.off("move", update);
    map.off("resize", update);
    map.off("idle", update);
  });
}
