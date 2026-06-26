export function contourSvg(f0: (number | null | undefined)[] | null | undefined): string {
  const W = 100;
  const SVG_OPEN = `<svg class="contour" viewBox="0 0 ${W} 14" preserveAspectRatio="none">`;
  if (!f0) return SVG_OPEN + `<path class="line missing" d="M0,8 L${W},8" vector-effect="non-scaling-stroke"/><line class="scrub" x1="${W/2}" x2="${W/2}" y1="0" y2="14" vector-effect="non-scaling-stroke"/></svg>`;
  const yOf = (z: number) => Math.max(1, Math.min(13, 8 - z * 3));
  const n = f0.length;
  const voiced = f0
    .map((v, i) => ({ v, i }))
    .filter(p => p.v !== null && p.v !== undefined) as { v: number; i: number }[];
  let d = '';
  if (voiced.length === 1) {
    const y = yOf(voiced[0].v).toFixed(2);
    d = `M35.00,${y} L65.00,${y}`;
  } else if (voiced.length > 1) {
    for (let i = 0; i < n; i++) {
      let v = f0[i];
      if (v === null || v === undefined) {
        let left: { v: number; i: number } | null = null;
        let right: { v: number; i: number } | null = null;
        for (let j = voiced.length - 1; j >= 0; j--) {
          if (voiced[j].i < i) { left = voiced[j]; break; }
        }
        for (let j = 0; j < voiced.length; j++) {
          if (voiced[j].i > i) { right = voiced[j]; break; }
        }
        if (left && right) {
          const t = (i - left.i) / (right.i - left.i);
          v = left.v + (right.v - left.v) * t;
        } else {
          v = (left || right)!.v;
        }
      }
      const x = (i / (n - 1)) * W;
      d += (i === 0 ? 'M' : ' L') + x.toFixed(2) + ',' + yOf(v as number).toFixed(2);
    }
  }
  if (!d) d = `M0,8 L${W},8`;
  return SVG_OPEN + `<path class="line" d="${d}" vector-effect="non-scaling-stroke"/><line class="scrub" x1="${W/2}" x2="${W/2}" y1="0" y2="14" vector-effect="non-scaling-stroke"/></svg>`;
}
