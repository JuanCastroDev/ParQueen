// ParQueen brand mark + map-pin silhouette shared by every street-parking ping marker.
//
// PARQUEEN_MARK_PATH is a potrace trace of the alpha mask of assets/Parqueen_Pin.png
// (302x363 px, the brand source of truth). Coordinates are in that PNG's pixel space;
// render it with PARQUEEN_MARK_TRANSFORM to place it inside the pin head. Two subpaths:
// the "P + pin" ring/stem and the inner teardrop dot (fill-rule evenodd).
export const PARQUEEN_MARK_PATH =
  'M92.7 305.6C31.8 243.2 25.8 236.2 16.1 216.5C4.9 193.8 1.6 179.0 1.5 151.0C1.5 117.5 7.9 94.3 24.0 69.5C55.2 21.6 106.8 -3.8 163.4 0.9C201.8 4.1 231.9 18.5 259.0 46.7C280.0 68.4 292.0 90.6 298.2 119.4C301.4 134.2 301.4 166.9 298.2 181.7C292.7 207.2 282.2 228.2 265.0 248.5C258.6 256.0 235.8 277.9 230.2 281.9L227.4 283.9 203.5 260.0L179.7 236.2 184.6 233.7C199.6 226.0 219.2 208.3 226.8 195.4C241.2 171.2 242.6 138.7 230.5 113.1C221.4 93.9 203.8 76.9 185.2 69.4C164.2 61.0 138.3 60.8 118.3 69.1C92.2 80.0 73.2 101.5 65.8 128.6C62.5 140.9 62.7 162.3 66.3 174.3C69.4 184.2 74.1 194.1 79.4 201.5C81.4 204.2 107.8 231.9 138.1 262.8L193.3 319.2 183.4 329.2C178.0 334.7 167.9 344.4 161.0 350.9L148.5 362.7 92.7 305.6ZM133.4 202.5C124.7 193.5 116.1 183.7 114.3 180.8C101.0 159.1 110.0 131.0 133.7 119.7C140.0 116.7 141.3 116.5 151.1 116.5C161.2 116.5 161.9 116.6 169.1 120.2C191.1 131.1 199.7 155.3 189.6 177.7C187.4 182.5 183.9 186.4 168.7 201.2C158.7 211.0 150.2 219.0 149.8 219.0C149.5 219.0 142.0 211.6 133.4 202.5Z';

/** Pin viewBox: 40 wide x 46 tall. The tip touches the bottom edge (y = 46) for anchor: 'bottom'. */
export const PIN_VIEWBOX_WIDTH = 40;
export const PIN_VIEWBOX_HEIGHT = 46;
export const PIN_VIEWBOX = `0 0 ${PIN_VIEWBOX_WIDTH} ${PIN_VIEWBOX_HEIGHT}`;
/** Round head (r = 18, centre 20,19) tapering to a point at (20, 46). */
export const PIN_PATH = 'M20 46C14.6 39.2 2 30.2 2 19A18 18 0 0 1 38 19C38 30.2 25.4 39.2 20 46Z';
export const PIN_TIP = { x: 20, y: 46 } as const;

const MARK_SCALE = 0.0805;
/**
 * Translate (pin viewBox units) for the scaled mark, shared by single and stack markers.
 * Places the mark's alpha-weighted centroid at (20, 19.5): horizontally on the head circle centre
 * (20, 19) and 0.5 below it, matching the reference pin (centroid ~0.04 R below its head centre).
 * Scale 0.0805 (+15% over the original 0.07, approved); the offset keeps the same centroid target.
 * The original (9.43, 5.895) at 0.07 centred the bounding box, which left the visual mass ~2.2 units high.
 */
export const PARQUEEN_MARK_OFFSET = { x: 8.03, y: 6.91 } as const;
export const PARQUEEN_MARK_TRANSFORM = `translate(${PARQUEEN_MARK_OFFSET.x} ${PARQUEEN_MARK_OFFSET.y}) scale(${MARK_SCALE})`;

/** White ParQueen mark, already positioned for the pin viewBox. */
export const parqueenMarkSvg = (fill = '#ffffff'): string =>
  `<g data-parqueen-mark="true" transform="${PARQUEEN_MARK_TRANSFORM}"><path d="${PARQUEEN_MARK_PATH}" fill="${fill}" fill-rule="evenodd"/></g>`;

/** Pixel height for a pin of the given pixel width, preserving the viewBox aspect so the tip sits on the bottom edge. */
export const pinHeightForWidth = (width: number): number => (width * PIN_VIEWBOX_HEIGHT) / PIN_VIEWBOX_WIDTH;
