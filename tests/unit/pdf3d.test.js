// 2.5 models3d (REQ-GAP-68): the PRC writer and the 3D PDF around it. Adobe Acrobat (the row's
// oracle) is not available, and no free PRC viewer or validator could be found to install, so
// the checks are structural: an independent reader written from the public ISO 14739-1 working
// draft (tests/tools/prc_ref.py; its double-code table is read from the draft's own text) parses
// every section to its last bit, and pypdf checks the PDF's 3D annotation. Poppler renders the
// page (the poster appearance a viewer without 3D shows).
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { BitWriter, writePrc, vertexNormals } from '../../app/src/formats/prc-write.js';
import { write3dPdf, cameraToWorld } from '../../app/src/formats/pdf3d-write.js';

const WD = 'E:/gwb25/data-models3d/work/prc-wd.txt';
const PYENV = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const PY = `${PYENV}/python.exe`;
const WORK = 'E:/gwb25/data-models3d/work/vitest-pdf3d';
const ok = existsSync(WD) && existsSync(PY);
const env = { ...process.env, PATH: `${PYENV};${PYENV}/Library/bin;${process.env.PATH}` };
const ref = (...a) => JSON.parse(execFileSync(PY, ['-I', resolve('tests/tools/prc_ref.py'), ...a], { env, maxBuffer: 1 << 30, encoding: 'utf8' }));
if (ok) mkdirSync(WORK, { recursive: true });
// The reader starts Python and parses the draft's text on every call; slow on a loaded machine.
vi.setConfig({ testTimeout: 120000 });

const jpeg = readFileSync(resolve('fixtures/fx25/models3d/texture.jpg'));
function scene() {
  // A 41 × 41 textured terrain (indexed) and two coloured boxes (triangle soups).
  const n = 41;
  const P = [];
  const UV = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      P.push(i * 12.5 - 250, j * 12.5 - 250, 30 * Math.sin(i / 5) * Math.cos(j / 7) + 0.123456789);
      UV.push(i / (n - 1), 1 - j / (n - 1));
    }
  const idx = [];
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
    }
  const box = (x, y, w, h) => {
    const v = [];
    const q = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
    const p = (dx, dy, dz) => [x + dx * w, y + dy * w, dz * h];
    q(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1));
    q(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1));
    q(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1));
    return Float64Array.from(v);
  };
  return {
    meshes: [
      { name: 'Terrain', positions: Float64Array.from(P), indices: Uint32Array.from(idx), uv: Float64Array.from(UV), texture: 0, colour: [1, 1, 1] },
      { name: 'Building A — Здание', positions: box(10, 20, 15, 22.5), indices: null, colour: [0.82, 0.78, 0.72] },
      { name: 'Building B', positions: box(-80, -40, 9, 40), indices: null, colour: [0.3, 0.5, 0.9] },
    ],
    textures: [{ bytes: new Uint8Array(jpeg), format: 'jpg', width: 256, height: 256 }],
  };
}

describe.skipIf(!ok)('PRC bit stream', () => {
  it('WriteDouble: 6,000 doubles decode bit-exactly with the draft’s table and ReadDouble', () => {
    const vals = [0, -0, 1, -1, 0.5, 1000, 2000, 40, 0.001, 1e-8, 6.283185307179586, 180, 360, 12345, 999999999, 1165, 1195, 0.1, 1 / 3, Math.PI, Number.MIN_VALUE, 2.2250738585072014e-308, 1.7976931348623157e308, 2 ** 52, 2 ** -1074, 256, 257, 65793, 16843009.0625, 1.0000000000000002];
    // Values whose bytes repeat (the coder's back references and trailing runs).
    const dv = new DataView(new ArrayBuffer(8));
    for (const pat of [[0x40, 0x10, 0, 0, 0, 0, 0, 0], [0x40, 0x10, 7, 7, 7, 7, 7, 7], [0x40, 0x10, 1, 2, 1, 2, 1, 9], [0x3f, 0xf3, 9, 9, 9, 9, 9, 1], [0x41, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa], [0xc0, 0x5e, 0x12, 0x34, 0x12, 0x34, 0x12, 0x34]]) {
      pat.forEach((b, i) => dv.setUint8(i, b));
      vals.push(dv.getFloat64(0));
    }
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    while (vals.length < 6000) {
      const k = vals.length % 4;
      vals.push(k === 0 ? (rnd() - 0.5) * 1e4 : k === 1 ? Math.round(rnd() * 1e6) / 1000 : k === 2 ? (rnd() - 0.5) * 2 : Math.fround((rnd() - 0.5) * 5000));
    }
    const w = new BitWriter();
    w.uint(vals.length);
    for (const v of vals) w.double(v);
    const p = `${WORK}/doubles.bin`;
    writeFileSync(p, w.bytes());
    const r = ref('--doubles', p, WD);
    expect(r.padding).toBe(true);
    // Little-endian IEEE 754 bytes as hex (JSON numbers would round 64-bit integers).
    const hex = (v) => {
      dv.setFloat64(0, v, true);
      return Array.from(new Uint8Array(dv.buffer), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    const bad = vals.filter((v, i) => r.values[i] !== hex(v === 0 ? 0 : v)); // −0 is written as the zero code (no sign), so it reads +0
    expect(bad).toEqual([]);
    expect(r.values.length).toBe(6000);
  });
});

describe.skipIf(!ok)('PRC writer against the independent reader', () => {
  it('parses every section to its padding; geometry, textures, styles and references are exact', () => {
    const sc = scene();
    const w = writePrc({ ...sc, name: 'GW scene' });
    const p = `${WORK}/scene.prc`;
    writeFileSync(p, w.bytes);
    const dump = `${WORK}/scene.json`;
    const r = ref(p, WD, dump).prc;
    expect(r.errors).toEqual([]);
    expect(r.minVersion).toBe(8137);
    expect(r.fileStructures).toBe(1);
    expect(Object.values(r.tails).every(Boolean)).toBe(true);
    expect(r.uidsUnique).toBe(true);
    expect(r.triangles).toBe(w.triangles);
    expect(r.triangles).toBe(2 * 40 * 40 + 6 + 6);
    expect(r.pictures).toEqual([{ format: 1, file: 0, width: 256, height: 256 }]);
    expect(r.uncompressedFiles).toEqual([{ bytes: jpeg.length, kind: 'jpeg' }]);
    expect(r.items.map((x) => x.name)).toEqual(['Terrain', 'Building A — Здание', 'Building B']);
    expect(r.styles[r.items[0].style].isMaterial).toBe(true);
    expect(r.colours[r.styles[r.items[2].style].index]).toEqual([0.3, 0.5, 0.9]);
    expect(r.modelFile).toMatchObject({ unitFromCad: true, unit: 1000 });
    expect(r.productOccurrences[0]).toMatchObject({ part: 0, unit: 1000, loadStatus: 3 });
    // Coordinates are doubles: exactly the input.
    const d = JSON.parse(readFileSync(dump, 'utf8'));
    sc.meshes.forEach((m, i) => {
      expect(d[i].P).toEqual(Array.from(m.positions));
      const idx = m.indices ?? Array.from({ length: m.positions.length / 3 }, (_, k) => k);
      const per = m.uv ? 3 : 2;
      expect(d[i].tri.filter((_, k) => k % per === per - 1).map((x) => x / 3)).toEqual(Array.from(idx));
      if (m.uv) expect(d[i].UV).toEqual(Array.from(m.uv));
    });
    for (const t of r.tessellations) expect(t.normalError).toBeLessThan(1e-12);
  });

  it('the 3D PDF: extension level 3, a 3D annotation with the PRC stream, a right-handed default view and the poster', () => {
    const sc = scene();
    const camera = { position: [-400, -600, 500], target: [0, 0, 0], up: [0, 0, 1], fov: 50, aspect: 1.5 };
    const r = write3dPdf({ ...sc, camera, poster: { bytes: new Uint8Array(jpeg), width: 256, height: 256 }, title: 'GIS Workbench 3D view — тест' });
    const p = `${WORK}/scene.pdf`;
    writeFileSync(p, r.bytes);
    const o = ref(p, WD);
    expect(o.prc.errors).toEqual([]);
    expect(o.pdf.extension).toEqual({ base: '/1.7', level: 3 });
    expect(o.pdf.annotations3d).toBe(1);
    expect(o.pdf.stream).toEqual({ type: '/3D', subtype: '/PRC' });
    expect(o.pdf.view.orthonormal).toBeLessThan(1e-9);
    expect(o.pdf.view.rightHanded).toBeCloseTo(1, 9);
    expect(o.pdf.view.co).toBeCloseTo(Math.hypot(400, 600, 500), 6);
    // The camera looks at the target: C2W z axis along target − position.
    const [zx, zy, zz] = o.pdf.view.c2w.slice(6, 9);
    const L = Math.hypot(400, 600, 500);
    expect([zx, zy, zz].map((v) => Number(v.toFixed(6)))).toEqual([400 / L, 600 / L, -500 / L].map((v) => Number(v.toFixed(6))));
    expect(o.pdf.activation['/A']).toBe('/PO');
    expect(Object.values(o.pdf.poster)[0]).toEqual({ w: 256, h: 256, filter: '/DCTDecode' });
    // Poppler draws the poster (what a viewer without 3D shows).
    const png = `${WORK}/scene-page`;
    execFileSync(`${PYENV}/Library/bin/pdftoppm.exe`, ['-r', '20', '-png', '-singlefile', p, png], { env });
    expect(readFileSync(`${png}.png`).length).toBeGreaterThan(500);
  });

  it('camera-to-world for the usual views; refuses an empty scene', () => {
    const { c2w } = cameraToWorld({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1] });
    expect(c2w.slice(6, 9)).toEqual([0, 0, -1]);
    expect(c2w.slice(0, 3)).toEqual([1, 0, 0]); // up parallel to the view: x falls back to east
    expect(() => writePrc({ meshes: [] })).toThrow(/nothing to write/);
    const N = vertexNormals(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]));
    expect(Array.from(N.slice(0, 3))).toEqual([0, 0, 1]);
  });
});
