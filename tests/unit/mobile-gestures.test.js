// OD-2.23 Lite gestures (mobile/gestures.js): the two-finger pinch keeps the image point under the
// fingers, zooms by the finger distance and rotates only past the threshold; double-tap timing.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pinchView, pairOf, wrapAngle, gestureRotation, isDoubleTap, ROT_THRESHOLD, DOUBLE_MS, DOUBLE_PX } from '../../app/src/mobile/gestures.js';
import { invertView, forwardView } from '../../app/src/render/renderer.js';

const W = 390;
const H = 700;

describe('pinch, rotate and pan with two fingers', () => {
  it('zooms ×2 about the fingers when they move twice as far apart', () => {
    const v0 = { cx: 500, cy: 400, zoom: 0.5, rot: 0, mode: 'native' };
    const p0 = pairOf({ x: 150, y: 300 }, { x: 250, y: 300 });
    const p1 = pairOf({ x: 100, y: 300 }, { x: 300, y: 300 });
    const v = pinchView(v0, p0, p1, W, H);
    expect(v.zoom).toBeCloseTo(1, 12);
    expect(v.rot).toBe(0);
    const before = invertView(v0, W, H, p0.cx, p0.cy);
    const after = invertView(v, W, H, p1.cx, p1.cy);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('pans with the fingers: the image point under them follows the centroid', () => {
    const v0 = { cx: 1000, cy: 800, zoom: 2, rot: 0.3 };
    const p0 = pairOf({ x: 100, y: 200 }, { x: 200, y: 260 });
    const p1 = pairOf({ x: 140, y: 330 }, { x: 240, y: 390 });
    const v = pinchView(v0, p0, p1, W, H);
    const P = invertView(v0, W, H, p0.cx, p0.cy);
    const s = forwardView(v, W, H, P.x, P.y);
    expect(s.x).toBeCloseTo(p1.cx, 9);
    expect(s.y).toBeCloseTo(p1.cy, 9);
    expect(v.zoom).toBeCloseTo(2, 12);
  });

  it('does not rotate below the threshold, then follows the turn less the threshold', () => {
    const v0 = { cx: 0, cy: 0, zoom: 1, rot: 0, mode: 'north' };
    const p0 = pairOf({ x: 100, y: 300 }, { x: 300, y: 300 });
    const turn = (deg) => {
      const a = (deg * Math.PI) / 180;
      return pairOf({ x: 200 - 100 * Math.cos(a), y: 300 - 100 * Math.sin(a) }, { x: 200 + 100 * Math.cos(a), y: 300 + 100 * Math.sin(a) });
    };
    expect(pinchView(v0, p0, turn(8), W, H, { engaged: false }).rot).toBe(0);
    expect(pinchView(v0, p0, turn(8), W, H, { engaged: false }).mode).toBe('north');
    const v = pinchView(v0, p0, turn(40), W, H, { engaged: true });
    expect(v.rot).toBeCloseTo(((40 - 12) * Math.PI) / 180, 9);
    expect(v.mode).toBe('free');
    expect(pinchView(v0, p0, turn(-40), W, H, { engaged: true }).rot).toBeCloseTo((-(40 - 12) * Math.PI) / 180, 9);
    expect(gestureRotation(0.5, false)).toBe(0);
    expect(gestureRotation(ROT_THRESHOLD, true)).toBeCloseTo(0, 12);
  });

  it('keeps the point under the fingers for any pinch (property)', () => {
    const pt = fc.record({ x: fc.double({ min: 0, max: W, noNaN: true }), y: fc.double({ min: 0, max: H, noNaN: true }) });
    fc.assert(
      fc.property(pt, pt, pt, pt, fc.double({ min: 0.01, max: 8, noNaN: true }), fc.double({ min: -3, max: 3, noNaN: true }), fc.boolean(), (a, b, c, d, zoom, rot, engaged) => {
        const p0 = pairOf(a, b);
        const p1 = pairOf(c, d);
        if (p0.d < 20 || p1.d < 20) return;
        const v0 = { cx: 1234, cy: 567, zoom, rot };
        const v = pinchView(v0, p0, p1, W, H, { engaged });
        if (v.zoom !== zoom * (p1.d / p0.d)) return; // clamped at the zoom limits
        const P = invertView(v0, W, H, p0.cx, p0.cy);
        const s = forwardView(v, W, H, P.x, P.y);
        expect(Math.hypot(s.x - p1.cx, s.y - p1.cy)).toBeLessThan(1e-6);
      }),
      { numRuns: 300 },
    );
  });

  it('wraps angles to (−π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(2 * Math.PI + 0.1)).toBeCloseTo(0.1, 12);
    expect(wrapAngle(-0.1)).toBeCloseTo(-0.1, 12);
  });
});

describe('double tap', () => {
  it('needs the second tap close in time and place', () => {
    const first = { x: 100, y: 100, t: 1000 };
    expect(isDoubleTap(first, 110, 105, 1000 + DOUBLE_MS - 1)).toBe(true);
    expect(isDoubleTap(first, 110, 105, 1000 + DOUBLE_MS + 1)).toBe(false);
    expect(isDoubleTap(first, 100 + DOUBLE_PX + 1, 100, 1100)).toBe(false);
    expect(isDoubleTap(null, 100, 100, 1100)).toBe(false);
  });
});
