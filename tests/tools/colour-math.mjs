// Colour metrics shared by the theme contrast test and the visual audit (GUI3 campaign):
// WCAG 2.2 relative luminance and contrast ratio, and CIELAB ΔE76 for how far apart two
// surfaces look (hue counts, so an amber hover on near-white is distinct even at 1.1:1).

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** '#rgb', '#rrggbb', '#rrggbbaa' or 'rgb(a)(…)' → [r, g, b, a] with r, g, b in 0..1. */
export function parse(c) {
  c = String(c).trim();
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
  }
  let h = c.replace('#', '');
  if (h.length <= 4) h = [...h].map((x) => x + x).join('');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return [...v, h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}

/** Composite `fg` (possibly translucent) over an opaque `bg`; returns [r, g, b] in 0..1. */
export function over(fg, bg) {
  const f = Array.isArray(fg) ? fg : parse(fg);
  const b = Array.isArray(bg) ? bg : parse(bg);
  const a = f[3] ?? 1;
  return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)).concat(1);
}

export function luminance(c) {
  const [r, g, b] = (Array.isArray(c) ? c : parse(c)).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function lab(c) {
  const [r, g, b] = (Array.isArray(c) ? c : parse(c)).slice(0, 3).map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export function deltaE(a, b) {
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export const hex = (c) => '#' + (Array.isArray(c) ? c : parse(c)).slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

/**
 * Thresholds (DN-60). TEXT and UI are WCAG 2.2 SC 1.4.3 and 1.4.11. STATE (hover, selected,
 * active tab against the unselected look) and TIER (adjacent surfaces that must read as separate
 * regions) are ΔE76 floors chosen in the GUI3 campaign: below ~5 two surfaces merge on a typical
 * monitor, which is the "too close in shade" complaint.
 */
export const MIN = { text: 4.5, ui: 3, state: 12, tier: 6 };
