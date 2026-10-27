// The FX-01 / FX-04 / FX-05 site: its origin and analytic terrain (HAE), shared by the generators.

export const SITE = [34.5, -116.5, 0];

/** Analytic terrain (HAE): a tilt, a ridge, a valley and a flat pad. Metres from the site. */
export function terrain(lat, lon) {
  const x = (lon - SITE[1]) * 111320 * Math.cos((SITE[0] * Math.PI) / 180);
  const y = (lat - SITE[0]) * 110940;
  const a = (25 * Math.PI) / 180;
  const u = x * Math.cos(a) + y * Math.sin(a);
  const v = -x * Math.sin(a) + y * Math.cos(a);
  let h = 650 + 0.01 * x + 60 * Math.exp(-(((u - 300) / 150) ** 2)) - 30 * Math.exp(-(((v + 400) / 120) ** 2));
  // Flat pad: exactly 640 m within 150 m of (-300, 300), blended out to 250 m.
  const r = Math.hypot(x + 300, y - 300);
  if (r <= 150) h = 640;
  else if (r < 250) {
    const t = (r - 150) / 100;
    const s = t * t * (3 - 2 * t);
    h = 640 * (1 - s) + h * s;
  }
  return h;
}
