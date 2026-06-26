import { describe, it, expect } from 'vitest';
import { contourSvg } from '../contour';

describe('contourSvg', () => {
  it('renders missing-data baseline with scrub line when f0 is null/undefined', () => {
    const html = contourSvg(null);
    expect(html).toContain('<svg class="contour"');
    expect(html).toContain('class="scrub"');
    expect(html).toContain('class="line missing"');
    expect(html).toContain('d="M0,8 L100,8"');
  });

  it('renders flat baseline path when all values are null', () => {
    const html = contourSvg([null, null, null]);
    expect(html).toContain('<svg class="contour"');
    expect(html).toContain('class="scrub"');
    expect(html).toContain('d="M0,8 L100,8"');
  });

  it('renders path with line when f0 has values', () => {
    const html = contourSvg([-1, 0, 1]);
    expect(html).toContain('<path class="line"');
    expect(html).toMatch(/d="M0\.00,\d/);
    expect(html).toContain('class="scrub"');
  });

  it('interpolates null gaps to fill the word width', () => {
    const html = contourSvg([0, null, 0]);
    const match = html.match(/d="([^"]+)"/);
    expect(match).toBeTruthy();
    const d = match[1];
    expect(d).toBe('M0.00,8.00 L50.00,8.00 L100.00,8.00');
  });

  it('clamps y output to 1..13', () => {
    const html = contourSvg([-10, 10]);
    const match = html.match(/d="([^"]+)"/);
    const d = match[1];
    const ys = [...d.matchAll(/,(\d+\.\d+)/g)].map(m => parseFloat(m[1]));
    ys.forEach(y => {
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(13);
    });
  });

  it('preserveAspectRatio is none for full-width stretch', () => {
    expect(contourSvg([0])).toContain('preserveAspectRatio="none"');
  });

  it('renders one voiced bin as a short visible segment', () => {
    const html = contourSvg([null, 0, null, null, null, null]);
    expect(html).toContain('d="M35.00,8.00 L65.00,8.00"');
  });
});
