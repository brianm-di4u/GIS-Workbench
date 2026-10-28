// REQ-HUB-01..05: the bridge writers — CoT and ATAK data packages, PSD levels/curves from the
// image chain, layered PDF (optional content) and SVG, the terrain grid, the relay signature.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { cotEvent, cotType, dataPackage } from '../../app/src/hub/tak.js';
import { levelsFor, curvesFor } from '../../app/src/hub/psd.js';
import { layeredPdf, layeredSvg, rgba } from '../../app/src/hub/layers.js';
import { terrainGrid, enu, uvLookup } from '../../app/src/hub/terrain3d.js';

describe('TAK', () => {
  it('types classes as 2525 CoT codes', () => {
    expect(cotType('aircraft')).toBe('a-u-G-E-V-A');
    expect(cotType('cargo vessel')).toBe('a-u-S');
    expect(cotType('car')).toBe('a-u-G-E-V');
    expect(cotType('building')).toBe('a-u-G-I');
    expect(cotType('rock')).toBe('a-u-G');
  });
  it('writes a CoT point and a freehand outline', () => {
    const p = cotEvent({ uid: 'GW-1', type: 'a-u-G', lat: 35.5, lon: -117.25, hae: 700, callsign: 'Tgt <1>', remarks: 'seen & noted', time: Date.UTC(2026, 9, 28) });
    expect(p).toContain('uid="GW-1" type="a-u-G" time="2026-10-28T00:00:00.000Z"');
    expect(p).toContain('<point lat="35.5000000" lon="-117.2500000" hae="700.0"');
    expect(p).toContain('callsign="Tgt &lt;1&gt;"');
    expect(p).toContain('<remarks>seen &amp; noted</remarks>');
    const s = cotEvent({ uid: 'GW-2', lat: 1, lon: 2, ring: [[2, 1], [2.1, 1], [2.1, 1.1]] });
    expect(s).toContain('type="u-d-f"');
    expect(s.match(/<link point=/g)).toHaveLength(3);
    expect(s).toContain('<link point="1.1000000,2.1000000"/>');
  });
  it('packs events and files with a version-2 manifest', () => {
    const z = unzipSync(dataPackage({ name: 'Test', uid: 'u-1', events: [{ uid: 'GW-1', xml: '<event/>' }], files: [{ path: 'images/a.jpg', bytes: new Uint8Array([1, 2]) }] }));
    const m = strFromU8(z['MANIFEST/manifest.xml']);
    expect(m).toContain('<MissionPackageManifest version="2">');
    expect(m).toContain('zipEntry="cot/GW-1.cot"');
    expect(m).toContain('zipEntry="images/a.jpg"');
    expect(strFromU8(z['cot/GW-1.cot'])).toBe('<event/>');
  });
});

describe('Photoshop adjustments', () => {
  it('turns the display range and gamma into a Levels channel', () => {
    expect(levelsFor({ lo: 0, hi: 2047 }, { lo: 204.7, hi: 1023.5 }, 50)).toEqual({ shadowInput: 26, highlightInput: 128, shadowOutput: 0, highlightOutput: 255, midtoneInput: 2 });
    expect(levelsFor({ lo: 0, hi: 255 }, { lo: 0, hi: 255 }).midtoneInput).toBe(1);
  });
  it('turns the tonal curve into Curves points with both ends', () => {
    expect(curvesFor([[0.25, 0.1], [0.75, 0.9]])).toEqual([{ input: 0, output: 0 }, { input: 64, output: 26 }, { input: 191, output: 230 }, { input: 255, output: 255 }]);
    expect(curvesFor(null)).toBe(null);
  });
});

describe('layered documents', () => {
  const layers = [{ name: 'Graphics', items: [{ kind: 'poly', pts: [[10, 10], [50, 10], [50, 40]], stroke: '#ff0000', fill: '#ff000040', label: 'AOI' }, { kind: 'point', pts: [[20, 20]], stroke: '#00ff00' }] }, { name: 'Scale bar', items: [{ kind: 'text', pts: [[5, 90]], stroke: '#ffffff', label: '100 m' }] }];
  it('writes one optional-content group per layer, imagery first', () => {
    const pdf = new TextDecoder('latin1').decode(layeredPdf({ width: 100, height: 100, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), imgW: 100, imgH: 100, layers, geo: [[1, 2], [1, 3], [0, 3], [0, 2]] }));
    expect(pdf.startsWith('%PDF-1.5')).toBe(true);
    expect([...pdf.matchAll(/\/Type \/OCG \/Name \(([^)]*)\)/g)].map((m) => m[1])).toEqual(['Imagery', 'Graphics', 'Scale bar']);
    expect(pdf).toContain('/OC /oc0 BDC');
    expect(pdf).toContain('/OC /oc2 BDC');
    expect(pdf).toContain('/Subtype /GEO');
    expect(pdf).toMatch(/\/Font << \/F0 10 0 R >>/);
    expect(pdf).toContain('(100 m) Tj');
    // Valid xref: every offset points at "n 0 obj".
    const xref = pdf.slice(pdf.lastIndexOf('xref'));
    const offs = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(pdf.slice(o, o + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
  it('writes SVG layers Illustrator and Inkscape recognise', () => {
    const svg = layeredSvg({ width: 100, height: 100, imageHref: 'data:image/jpeg;base64,AA', layers });
    expect([...svg.matchAll(/inkscape:label="([^"]*)" inkscape:groupmode="layer"/g)].map((m) => m[1])).toEqual(['Imagery', 'Graphics', 'Scale bar']);
    expect(svg).toContain('<polygon points="10.00,10.00 50.00,10.00 50.00,40.00" fill="rgb(255,0,0)" fill-opacity="0.25"');
    expect(rgba('#00ff0080')).toEqual([0, 1, 0, 128 / 255]);
  });
});

describe('terrain grid', () => {
  it('builds an up-facing textured grid in local metres', () => {
    const g = terrainGrid(3, (i, j) => ({ lat: 40 - j * 0.001, lon: -105 + i * 0.001, h: 1600 + i * 10, u: i / 2, v: j / 2 }));
    expect(g.vertices).toHaveLength(9);
    expect(g.faces).toHaveLength(8);
    expect(g.origin).toEqual({ lat: 39.999, lon: -104.999, h: 1600 });
    const [p, q, r] = g.faces[0].idx.map((k) => g.vertices[k]);
    expect((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])).toBeGreaterThan(0);
    expect(g.metres[0]).toBeCloseTo(2 * 0.001 * (Math.PI / 180) * 6378137 * Math.cos((39.999 * Math.PI) / 180), 3);
    const v = g.vertices[8];
    expect(uvLookup(g)(...v)).toEqual([1, 1]);
    expect(enu(g.origin, 39.999, -104.999, 1610)).toEqual([0, 0, 10]);
  });
});

describe('Sheets relay signature', async () => {
  const { hmacHex } = await import('../../app/src/features/hub.js');
  it('is HMAC-SHA256 hex (RFC 4231 case 2)', async () => {
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('Curves preset (.acv)', async () => {
  const { acvPreset } = await import('../../app/src/hub/psd.js');
  it('writes version 1 with five curves; each channel starts at its black point', () => {
    const L = { shadowInput: 26, highlightInput: 128, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 };
    const b = acvPreset([L, L, L]);
    const w = (i) => (b[2 * i] << 8) | b[2 * i + 1];
    expect([w(0), w(1), w(2)]).toEqual([1, 5, 2]); // composite identity: 2 points
    // Red: (0 → 0), then 26 → 0 … 128 → 255, then 255 → 255; stored output first.
    const red = 2 + 1 + 4;
    expect(w(red)).toBe(16);
    expect([w(red + 1), w(red + 2)]).toEqual([0, 0]);
    expect([w(red + 3), w(red + 4)]).toEqual([0, 26]);
    const last = red + 2 * w(red) - 1;
    expect([w(last), w(last + 1)]).toEqual([255, 255]);
  });
});
