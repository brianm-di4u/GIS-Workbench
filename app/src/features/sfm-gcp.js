// Ground control for UAV structure from motion (REG-075, decision 0018): what the marking dialog
// computes, kept apart from the DOM for the unit tests. The control file is read as gwb-sfm reads
// it (sidecar/gwb-sfm/src/gcp.rs): a CSV `id,x,y,z,crs,sigma,role,image,px,py`, one row per mark,
// or an ODM gcp_list.txt. The first stage's model file starts with `GWB-SFM-MODEL 1` and a line of
// JSON that gives each photograph's pose in the map frame less the offset (gwb-sfm/src/model.rs).

export const MAGIC = 'GWB-SFM-MODEL';
export const VERSION = 1;
const ODM_SIGMA = 0.02;

function utmEpsg(zone, south) {
  if (!(zone >= 1 && zone <= 60)) throw new Error(`UTM zone ${zone} does not exist`);
  return (south ? 32700 : 32600) + zone;
}

/** The EPSG code of a control file's CRS (WGS 84 / UTM only, as gwb-sfm). */
export function parseCrs(s) {
  const t = String(s).trim();
  const up = t.toUpperCase();
  if (up.startsWith('EPSG:')) {
    const n = Number(up.slice(5).trim());
    if (!Number.isInteger(n)) throw new Error(`the CRS ${t} is not an EPSG code`);
    return n;
  }
  const m = /^(?:WGS84 UTM |WGS 84 \/ UTM ZONE )\s*(\d+)\s*([NS])$/.exec(up);
  if (m) return utmEpsg(Number(m[1]), m[2] === 'S');
  if (up.includes('+PROJ=UTM') && (up.includes('WGS84') || up.includes('WGS 84'))) {
    const z = /\+ZONE=(\d+)/.exec(up);
    if (!z) throw new Error(`the CRS ${t} names no UTM zone`);
    return utmEpsg(Number(z[1]), up.includes('+SOUTH'));
  }
  throw new Error(`the CRS ${t} is not supported: give EPSG:326xx or EPSG:327xx (WGS 84 / UTM)`);
}

function num(v, what, n) {
  const x = Number(v);
  if (v === '' || !Number.isFinite(x)) throw new Error(`line ${n}: ${what} ${JSON.stringify(v)} is not a number`);
  return x;
}

function addPoint(points, p, n) {
  const have = points.get(p.id);
  if (!have) return void points.set(p.id, p);
  if (have.xyz.some((v, i) => Math.abs(v - p.xyz[i]) > 1e-6) || have.check !== p.check) throw new Error(`line ${n}: point ${p.id} is given twice with different coordinates or roles`);
  have.marks.push(...p.marks);
}

/** {epsg, crs, points: [{id, xyz, sigma, check, marks: [{image, px, py}]}]} */
export function parseControl(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('the control file is empty');
  const [, first] = lines.shift();
  const header = first.split(',').map((h) => h.trim().toLowerCase());
  const points = new Map();
  let epsg = null;
  let crs = null;
  if (header.length > 1 && header[0] === 'id') {
    const col = (name) => {
      const i = header.indexOf(name);
      if (i < 0) throw new Error(`the control file has no ${name} column`);
      return i;
    };
    const c = Object.fromEntries(['id', 'x', 'y', 'z', 'crs', 'sigma', 'role', 'image', 'px', 'py'].map((k) => [k, col(k)]));
    for (const [n, l] of lines) {
      const f = l.split(',').map((s) => s.trim());
      if (f.length < header.length) throw new Error(`line ${n}: ${f.length} fields, the header has ${header.length}`);
      const e = parseCrs(f[c.crs]);
      if (epsg != null && e !== epsg) throw new Error(`line ${n}: every point must be in the same CRS`);
      epsg = e;
      crs ??= f[c.crs];
      const sigma = num(f[c.sigma], 'sigma', n);
      if (sigma <= 0) throw new Error(`line ${n}: sigma must be more than 0`);
      const role = f[c.role].toLowerCase();
      if (role !== 'gcp' && role !== 'check') throw new Error(`line ${n}: role ${JSON.stringify(f[c.role])} is neither gcp nor check`);
      if (!f[c.id]) throw new Error(`line ${n}: the point has no id`);
      const marks = f[c.image]
        ? [
            {
              image: f[c.image],
              px: num(f[c.px], 'px', n),
              py: num(f[c.py], 'py', n),
            },
          ]
        : [];
      addPoint(
        points,
        {
          id: f[c.id],
          xyz: [num(f[c.x], 'x', n), num(f[c.y], 'y', n), num(f[c.z], 'z', n)],
          sigma,
          check: role === 'check',
          marks,
        },
        n,
      );
    }
  } else {
    epsg = parseCrs(first);
    for (const [n, l] of lines) {
      const f = l.split(/\s+/);
      if (f.length < 6) throw new Error(`line ${n}: a gcp_list row needs x y z px py image`);
      const xyz = [num(f[0], 'x', n), num(f[1], 'y', n), num(f[2], 'z', n)];
      // Without an id column, a point is its coordinates (joined by '_', as gwb-sfm does: the CSV can carry it).
      const id = f[6] ?? xyz.map((v) => v.toFixed(3)).join('_');
      addPoint(
        points,
        {
          id,
          xyz,
          sigma: ODM_SIGMA,
          check: false,
          marks: [{ image: f[5], px: num(f[3], 'px', n), py: num(f[4], 'py', n) }],
        },
        n,
      );
    }
  }
  if (epsg == null) throw new Error('the control file has no points');
  return {
    epsg,
    crs: crs ?? `EPSG:${epsg}`,
    points: [...points.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** The control as the CSV gwb-sfm reads: one row per mark, and one with no mark for a point not marked. */
export function controlCsv(control) {
  const crs = `EPSG:${control.epsg}`;
  const rows = ['id,x,y,z,crs,sigma,role,image,px,py'];
  const f = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));
  for (const p of control.points) {
    if (/[,\n]/.test(p.id)) throw new Error(`point id ${JSON.stringify(p.id)} holds a comma`);
    for (const m of p.marks) if (/[,\n]/.test(m.image)) throw new Error(`photograph name ${JSON.stringify(m.image)} holds a comma`);
    const head = [p.id, f(p.xyz[0]), f(p.xyz[1]), f(p.xyz[2]), crs, f(p.sigma), p.check ? 'check' : 'gcp'].join(',');
    if (!p.marks.length) rows.push(`${head},,,`);
    for (const m of p.marks) rows.push(`${head},${m.image},${m.px.toFixed(2)},${m.py.toFixed(2)}`);
  }
  return `${rows.join('\n')}\n`;
}

/** The header of a model file, read from a Blob or a fetch Response without reading its binaries. */
export async function readModelHeader(src) {
  const stream = src.body ?? src.stream();
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) text += dec.decode(value, { stream: true });
      const nl = text.indexOf('\n');
      if (nl >= 0) {
        const first = text.slice(0, nl);
        if (!first.startsWith(MAGIC)) throw new Error('this is not a model file from the first stage');
        const v = Number(first.slice(MAGIC.length).trim());
        if (v !== VERSION) throw new Error(`the model file is version ${v}; this release reads version ${VERSION}`);
        const end = text.indexOf('\n', nl + 1);
        if (end >= 0) return JSON.parse(text.slice(nl + 1, end));
      }
      if (done) throw new Error('the model file is cut short in its header');
      if (text.length > 256 << 20) throw new Error('the model file header is too large');
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Normalised image plane to pixels for COLMAP camera models 0 to 4 (gcp.rs `undistort` inverted). */
export function distort(cam, u, v) {
  const p = cam.params;
  const [fx, fy, cx, cy, k1, k2, p1, p2] = (
    {
      0: () => [p[0], p[0], p[1], p[2], 0, 0, 0, 0],
      1: () => [p[0], p[1], p[2], p[3], 0, 0, 0, 0],
      2: () => [p[0], p[0], p[1], p[2], p[3], 0, 0, 0],
      3: () => [p[0], p[0], p[1], p[2], p[3], p[4], 0, 0],
      4: () => [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]],
    }[cam.model] ??
    (() => {
      throw new Error(`camera model ${cam.model} is not supported for ground control`);
    })
  )();
  const r2 = u * u + v * v;
  const radial = 1 + k1 * r2 + k2 * r2 * r2;
  const ud = u * radial + 2 * p1 * u * v + p2 * (r2 + 2 * u * u);
  const vd = v * radial + p1 * (r2 + 2 * v * v) + 2 * p2 * u * v;
  return [fx * ud + cx, fy * vd + cy];
}

/** Where a point of the map frame less the offset falls in an image of the header, or null. */
export function project(header, image, x) {
  const cam = header.cameras.find((c) => c.id === image.camera);
  const d = [x[0] - image.c[0], x[1] - image.c[1], x[2] - image.c[2]];
  const p = image.r.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
  if (!cam || p[2] <= 0) return null;
  const [px, py] = distort(cam, p[0] / p[2], p[1] / p[2]);
  if (!(px >= 0 && py >= 0 && px < cam.width && py < cam.height)) return null;
  return [px, py];
}

/**
 * The height the model has at a place: the median of its 8 nearest ground points (`header.ground`,
 * map frame less the offset), or null when the header carries none.
 */
export function groundHeight(header, x, y) {
  const g = header.ground;
  if (!g?.length) return null;
  const near = g
    .map((p) => [(p[0] - x) ** 2 + (p[1] - y) ** 2, p[2]])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 8)
    .map((p) => p[1])
    .sort((a, b) => a - b);
  return near[near.length >> 1];
}

/**
 * The photographs a control point should show in, nearest the image centre first. The point is
 * projected at the height the model has there, not at its surveyed height: the first stage is placed
 * by the photographs' GPS, whose heights can be tens of metres from the survey's, and that would
 * push every prediction away from the image centre. `toModel` turns the control's map coordinates
 * into the model's CRS (the identity when they are the same).
 */
export function candidates(header, point, { toModel = (x) => x, max = 8 } = {}) {
  const off = header.georef?.offset ?? [0, 0, 0];
  const m = toModel(point.xyz);
  const x = [m[0] - off[0], m[1] - off[1], m[2] - (off[2] ?? 0)];
  x[2] = groundHeight(header, x[0], x[1]) ?? x[2];
  const out = [];
  for (const im of header.images) {
    const at = project(header, im, x);
    if (!at) continue;
    const cam = header.cameras.find((c) => c.id === im.camera);
    out.push({ image: im.name, px: at[0], py: at[1], centre: Math.hypot(at[0] - cam.width / 2, at[1] - cam.height / 2) });
  }
  return out.sort((a, b) => a.centre - b.centre).slice(0, max);
}

/** Can the run go ahead: at least 3 control points marked in 2 or more photographs (georef's rule). */
export function readiness(control) {
  const marked = control.points.filter((p) => !p.check && new Set(p.marks.map((m) => m.image)).size >= 2).length;
  const checks = control.points.filter((p) => p.check && new Set(p.marks.map((m) => m.image)).size >= 2).length;
  return { marked, checks, ready: marked >= 3 };
}
