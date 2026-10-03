/**
 * Раскладка альбома фото — перенесена из ChatTimelineV3 без изменений логики:
 * ячейки подбираются по ориентации снимков и заполняют ширину без пустот.
 */

export interface AlbumBox { x: number; y: number; w: number; h: number }
export function computeAlbumLayout(
  ratiosIn: number[], W: number, gap: number, maxH: number,
): { width: number; height: number; boxes: AlbumBox[] } {
  const n = ratiosIn.length;
  // Barely clamp — cells are sized from these ratios and the photos are object-cover'd
  // into them, so a tight clamp would crop wide banners / tall shots. Only guard extremes.
  const R = ratiosIn.map(r => Math.max(0.35, Math.min(3.2, r > 0 ? r : 1))); // w/h
  const wide = (r: number) => r >= 1.2;
  let boxes: AlbumBox[] = [];
  let H = 0;

  if (n === 2) {
    if (wide(R[0]) && wide(R[1])) {
      // two wide → stacked (each full width)
      const h0 = W / R[0], h1 = W / R[1];
      boxes = [{ x: 0, y: 0, w: W, h: h0 }, { x: 0, y: h0 + gap, w: W, h: h1 }];
      H = h0 + gap + h1;
    } else {
      // else → side by side sharing a common height (fills width exactly)
      const h = (W - gap) / (R[0] + R[1]);
      const w0 = h * R[0];
      boxes = [{ x: 0, y: 0, w: w0, h }, { x: w0 + gap, y: 0, w: W - gap - w0, h }];
      H = h;
    }
  } else if (n === 3) {
    if (wide(R[0])) {
      // first wide → it on top full-width, the other two share a row below
      const h0 = W / R[0];
      const h2 = (W - gap) / (R[1] + R[2]);
      const w1 = h2 * R[1];
      boxes = [
        { x: 0, y: 0, w: W, h: h0 },
        { x: 0, y: h0 + gap, w: w1, h: h2 },
        { x: w1 + gap, y: h0 + gap, w: W - gap - w1, h: h2 },
      ];
      H = h0 + gap + h2;
    } else {
      // first tall → it on the left full-height, the other two stacked on the right
      const inv = 1 / R[1] + 1 / R[2];
      const wR = (W - gap - gap * R[0]) / (R[0] * inv + 1);
      const h1 = wR / R[1], h2 = wR / R[2];
      const hh = h1 + gap + h2;
      const wL = hh * R[0];
      boxes = [
        { x: 0, y: 0, w: wL, h: hh },
        { x: wL + gap, y: 0, w: wR, h: h1 },
        { x: wL + gap, y: h1 + gap, w: wR, h: h2 },
      ];
      H = hh;
    }
  } else {
    // 4+ → two justified rows of two (first four); a "+N" overlay goes on the 4th cell
    const hT = (W - gap) / (R[0] + R[1]);
    const hB = (W - gap) / (R[2] + R[3]);
    const wT0 = hT * R[0], wB0 = hB * R[2];
    boxes = [
      { x: 0, y: 0, w: wT0, h: hT },
      { x: wT0 + gap, y: 0, w: W - gap - wT0, h: hT },
      { x: 0, y: hT + gap, w: wB0, h: hB },
      { x: wB0 + gap, y: hT + gap, w: W - gap - wB0, h: hB },
    ];
    H = hT + gap + hB;
  }

  // Cap total height by scaling the whole album down (keeps proportions, no gaps).
  if (H > maxH) {
    const s = maxH / H;
    boxes = boxes.map(b => ({ x: b.x * s, y: b.y * s, w: b.w * s, h: b.h * s }));
    W = W * s; H = maxH;
  }
  return { width: Math.round(W), height: Math.round(H), boxes };
}
