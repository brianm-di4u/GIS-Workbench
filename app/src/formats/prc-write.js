// PRC writer (REQ-GAP-68; ISO 14739-1 PRC, from its working draft ISO/TC 171/SC 2 N 570,
// "PRC format specification", version 8137): tessellated meshes for a 3D PDF annotation.
// One file structure; its tree is one root product occurrence → one part definition → one
// PRC_TYPE_RI_PolyBrepModel per mesh, each with a PRC_TYPE_TESS_3D of triangles (normal, point;
// or normal, texture, point when textured) and a line style that gives its colour, or a
// texture application over a JPEG / PNG picture kept as an uncompressed file of the file
// structure. Units: metres (1000 mm). Sections are bit streams (WriteBits, MSB first), padded to
// a byte and flate-compressed; doubles use the specification's frequent-value code table
// (acofdoe, 2,077 entries, kept here as runs) and its byte-repetition coding (WriteDouble).
// What could not be checked: no PRC reader or viewer was available (Acrobat is not here), so
// the file is checked only by an independent structural parser (tests/tools/prc_ref.py).

import { zlibSync } from 'fflate';

// ---- acofdoe (ISO 14739-1 WD §11.17.2) ----
// Exponent entries as runs [first exponent, count, number of bits, first code]; codes are
// consecutive within a run. Then the 29 frequent doubles: [number of bits, code, upper, lower].
const RUNS = [[0,2,22,859442],[2,40,22,1013976],[42,810,22,3834624],[852,1,18,63367],[853,1,18,53716],[854,1,19,491423],[855,1,18,243963],[856,1,19,126746],[857,1,21,1917717],[858,1,16,15842],[859,13,22,3835436],[872,1,21,1917725],[873,1,22,3835449],[874,1,22,3835452],[875,1,16,15840],[876,1,18,239966],[877,1,21,1917727],[878,1,22,3835453],[879,1,22,3835456],[880,1,20,214857],[881,1,20,214861],[882,29,22,3835457],[911,1,21,1917743],[912,3,22,3835488],[915,1,21,1917746],[916,1,18,53717],[917,1,18,245722],[918,2,15,29992],[920,1,18,239967],[921,1,17,119860],[922,1,19,479437],[923,1,18,239719],[924,1,19,487933],[925,1,18,239718],[926,1,19,479436],[927,1,18,245723],[928,1,18,243962],[929,1,18,239708],[930,1,19,479439],[931,1,17,119855],[932,1,19,487929],[933,1,18,243967],[934,1,18,239712],[935,1,17,121980],[936,1,17,121965],[937,1,17,119808],[938,1,17,119809],[939,1,17,121966],[940,1,16,59903],[941,1,16,60982],[942,1,16,60986],[943,1,16,60983],[944,1,16,59924],[945,1,15,30495],[946,1,15,29935],[947,1,15,29934],[948,1,15,30491],[949,1,15,29993],[950,1,15,30028],[951,1,14,15248],[952,1,14,14998],[953,1,13,7496],[954,1,14,15012],[955,1,14,15249],[956,1,14,14999],[957,1,13,7501],[958,1,12,3814],[959,1,13,7623],[960,1,13,7506],[961,1,13,7621],[962,1,13,7624],[963,1,13,3367],[964,1,12,1683],[965,1,12,3817],[966,1,12,3748],[967,1,12,3749],[968,1,12,3813],[969,1,13,7495],[970,1,12,1670],[971,1,12,1671],[972,1,12,3757],[973,1,12,3751],[974,1,12,3756],[975,1,11,1872],[976,1,11,1905],[977,1,12,3816],[978,1,11,1902],[979,1,12,3815],[980,1,12,3750],[981,1,11,1876],[982,1,11,1878],[983,1,11,1879],[984,1,11,1903],[985,1,11,1874],[986,1,11,1913],[987,1,10,936],[988,1,11,1877],[989,1,10,952],[990,1,10,834],[991,1,10,937],[992,1,10,953],[993,1,10,835],[994,1,10,948],[995,1,10,957],[996,1,10,958],[997,1,10,941],[998,1,10,939],[999,1,10,940],[1000,1,10,938],[1001,1,13,3364],[1002,1,13,3365],[1003,1,14,6732],[1004,1,13,3366],[1005,1,13,1971],[1006,1,10,93],[1007,1,12,3819],[1008,1,11,494],[1009,1,10,95],[1010,1,10,694],[1011,1,9,478],[1012,1,8,232],[1013,1,8,174],[1014,1,7,27],[1015,1,7,118],[1016,1,7,10],[1017,1,6,8],[1018,1,6,14],[1019,1,6,4],[1020,1,6,12],[1021,1,5,3],[1022,1,4,8],[1023,1,5,19],[1024,1,5,27],[1025,1,5,23],[1026,1,5,18],[1027,2,5,25],[1029,1,5,24],[1030,1,5,28],[1031,1,5,20],[1032,1,5,5],[1033,1,8,22],[1034,1,12,3810],[1035,1,12,3812],[1036,1,8,172],[1037,1,13,5563],[1038,1,22,3835495],[1039,3,22,3835608],[1042,1,17,121982],[1043,5,22,3835611],[1048,16,22,3835632],[1064,25,22,3835712],[1089,1,15,6715],[1090,167,22,3835737],[1257,768,22,3837952],[2025,16,22,3839392],[2041,4,22,3903456],[2045,2,21,429712],[2047,1,21,429720]];
const DOUBLES = [[2,1,0,0],[10,244,1043691918,3794832442],[11,1916,1044740494,3794832442],[8,175,1049286642,2596056906],[9,466,1052821239,2696277390],[10,208,1061506200,1594291860],[6,9,1061828322,3944497965],[4,15,1062232653,3539053052],[5,22,1063281229,3539053052],[11,1873,1069443501,1120127470],[11,1911,1071644672,0],[9,470,1072693247,4160749570],[4,0,1072693248,0],[9,346,1075388923,1413754136],[11,1908,1077276180,2147483648],[9,467,1078765020,442745336],[11,1918,1079751471,3758096384],[10,94,1079784239,3758096384],[9,471,1080459264,0],[9,469,1081507840,0],[11,1917,1083129856,0],[10,210,1083323391,4294967295],[8,60,1083323392,0],[11,1875,1083323392,1],[10,211,1083354111,4294967295],[8,53,1083354112,0],[11,1904,1083354112,1],[7,31,1086856320,0],[6,42,1104006500,4286578688]];

const EXP = new Array(2048); // exponent → [bits, code]
for (const [e0, n, nb, c0] of RUNS) for (let i = 0; i < n; i++) EXP[e0 + i] = [nb, c0 + i];
const FREQ = new Map(); // exponent → [{value, bits, code}]
{
  const dv = new DataView(new ArrayBuffer(8));
  for (const [nb, code, hi, lo] of DOUBLES) {
    dv.setUint32(0, hi);
    dv.setUint32(4, lo);
    const e = (hi >>> 20) & 0x7ff;
    if (!FREQ.has(e)) FREQ.set(e, []);
    FREQ.get(e).push({ value: dv.getFloat64(0), bits: nb, code });
  }
}

/** A PRC bit stream (WriteBits: left to right, MSB first; the last byte padded with zeros). */
export class BitWriter {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.n = 0; // bytes complete
    this.cur = 0;
    this.used = 0; // bits in cur
    this.currentName = null;
    this.currentGraphics = null;
  }
  _byte(b) {
    if (this.n >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = b;
  }
  bits(value, count) {
    for (let i = count - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(value / 2 ** i) & 1);
      if (++this.used === 8) {
        this._byte(this.cur);
        this.cur = 0;
        this.used = 0;
      }
    }
  }
  bool(b) {
    this.bits(b ? 1 : 0, 1);
  }
  char(c) {
    this.bits(c & 0xff, 8);
  }
  /** WriteUnsignedInteger: 1 + 8 bits per byte, low byte first, then 0. */
  uint(v) {
    if (!(Number.isInteger(v) && v >= 0 && v <= 0xffffffff)) throw new Error(`PRC: unsigned integer ${v} out of range`);
    for (;;) {
      if (v === 0) {
        this.bits(0, 1);
        return;
      }
      this.bits(1, 1);
      this.bits(v & 0xff, 8);
      v = Math.floor(v / 256);
    }
  }
  /** WriteInteger (two's complement bytes, sign-terminated). */
  int(v) {
    if (v === 0) {
      this.bits(0, 1);
      return;
    }
    for (;;) {
      const loc = v & 0xff;
      this.bits(1, 1);
      this.bits(loc, 8);
      v >>= 8;
      if ((v === 0 && (loc & 0x80) === 0) || (v === -1 && (loc & 0x80) !== 0)) {
        this.bits(0, 1);
        return;
      }
    }
  }
  /** WriteString: a TRUE bit, the UTF-8 byte count, the bytes (FALSE for null). */
  string(s) {
    if (s == null) {
      this.bits(0, 1);
      return;
    }
    const b = new TextEncoder().encode(s);
    this.bits(1, 1);
    this.uint(b.length);
    for (const c of b) this.char(c);
  }
  /** WriteDouble (ISO 14739-1 WD §11.18), on the IEEE 754 bytes in little-endian order. */
  double(value) {
    if (!Number.isFinite(value)) throw new Error('PRC: a coordinate is not a finite number');
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, value, true);
    const B = new Uint8Array(dv.buffer); // B[7] holds the sign and high exponent bits
    const e = ((B[7] & 0x7f) << 4) | (B[6] >> 4);
    const abs = Math.abs(value);
    const f = FREQ.get(e)?.find((x) => x.value === abs);
    const [nb, code] = f ? [f.bits, f.code] : EXP[e];
    this.bits(code, nb);
    if (abs === 0) return; // +0 and −0
    this.bits(B[7] >> 7, 1);
    if (f) return;
    const mant0 = ((B[6] & 0x0f) << 16) | (B[5] << 8) | B[4];
    const mant1 = (B[3] << 24) | (B[2] << 16) | (B[1] << 8) | B[0];
    if (mant0 === 0 && mant1 === 0) {
      this.bits(0, 1);
      return;
    }
    this.bits(1, 1);
    this.bits(B[6] & 0x0f, 4);
    // Bytes 5 down to 0; repeated trailing bytes (from byte 0 up) are coded once at the end.
    const start = 5;
    const save = B[0] !== B[1];
    let stop = 1;
    while (stop < 7 && B[stop] === B[stop + 1]) stop++;
    const back = (p) => {
      // memchr(p + 1, B[p], start − p): the nearest byte already written with this value.
      for (let q = p + 1; q <= start; q++) if (B[q] === B[p]) return q;
      return -1;
    };
    let p = start;
    for (; p >= stop; p--) {
      const q = p !== start ? back(p) : -1;
      if (q >= 0) {
        this.bits(0, 1);
        this.bits(q - p, 3);
      } else {
        this.bits(1, 1);
        this.bits(B[p], 8);
      }
    }
    if (!(1 >= stop)) {
      this.bits(0, 1);
      if (save) {
        this.bits(6, 3);
        this.bits(B[0], 8);
      } else this.bits(0, 3);
    } else {
      const q = back(p);
      if (q >= 0) {
        this.bits(0, 1);
        this.bits(q - p, 3);
      } else {
        this.bits(1, 1);
        this.bits(B[p], 8);
      }
    }
  }
  /** Name with the current-name rule (§7.2.3.4). */
  name(s) {
    if (s === this.currentName) {
      this.bool(true);
      return;
    }
    this.bool(false);
    this.string(s);
    this.currentName = s;
  }
  /** The section's bytes, padded to a byte (current name and graphics reset for the next section). */
  bytes() {
    const out = this.buf.slice(0, this.n + (this.used ? 1 : 0));
    if (this.used) out[this.n] = this.cur << (8 - this.used);
    return out;
  }
}

// Entity types (§7.x.1).
export const T = {
  ModelFile: 301,
  FileStructure: 302,
  Globals: 303,
  Tree: 304,
  Tessellation: 305,
  Geometry: 306,
  ExtraGeometry: 307,
  ProductOccurrence: 308,
  PartDefinition: 309,
  PolyBrepModel: 237,
  Tess3D: 172,
  TessFace: 174,
  Style: 701,
  Material: 702,
  Picture: 703,
  TextureApplication: 711,
  TextureDefinition: 712,
};
const TRIANGLE = 0x0002;
const TRIANGLE_TEXTURED = 0x0200;
const SHOW = 0x0001;
export const PRC_VERSION = 8137;

/**
 * Write a PRC file. `meshes` = [{name, positions (Float32/64Array, triangle soup or with
 * `indices`), indices (Uint32Array) | null, normals (per vertex) | null, uv (per vertex, PRC
 * convention: v up) | null, colour [r, g, b] 0..1, texture (index into `textures`) | null}];
 * `textures` = [{bytes (JPEG or PNG), format 'jpg' | 'png', width, height}].
 * → {bytes, triangles, meshes, textures, offsets}.
 */
export function writePrc({ meshes, textures = [], name = 'GIS Workbench', time = Math.floor(Date.now() / 1000) }) {
  if (!meshes.length) throw new Error('PRC: nothing to write');
  const uid = (k) => [0x47574b42, 0x50524331 + k, (time ^ 0x5a5a5a5a) >>> 0, Math.max(1149770869, time) + k]; // last word: creation time (§5.3.2)
  const fileUid = uid(0);
  const fsUid = uid(1);
  const appUid = [0, 0, 0, 0];
  let nextId = 1; // PRC unique identifiers of referenceable entities, from 1 (§5.3.1)
  const base = (w, nm, referenceable) => {
    w.uint(0); // no attributes
    w.name(nm);
    if (referenceable) {
      w.uint(0); // CAD identifier
      w.uint(0); // CAD persistent identifier
      w.uint(nextId++);
    }
  };
  const graphics = (w, layer, style, behaviour) => {
    const g = `${layer},${style},${behaviour}`;
    if (w.currentGraphics === g) {
      w.bool(true);
      return;
    }
    w.bool(false);
    w.uint(layer + 1);
    w.uint(style + 1);
    w.char(behaviour & 0xff);
    w.char((behaviour >> 8) & 0xff);
    w.currentGraphics = g;
  };
  const userData = (w) => w.uint(0);
  // ---- globals: colours, pictures, texture definitions, materials, styles ----
  const colours = [];
  const colourIndex = (c) => {
    const k = c.map((v) => Math.round(v * 1e6)).join(',');
    let i = colours.findIndex((x) => x.k === k);
    if (i < 0) {
      colours.push({ k, c });
      i = colours.length - 1;
    }
    return i;
  };
  const white = colourIndex([1, 1, 1]);
  const black = colourIndex([0, 0, 0]);
  const grey = colourIndex([0.12, 0.12, 0.12]);
  // Materials array: one generic material, then one texture application per texture.
  const materials = [{ kind: 'generic' }];
  const texApp = textures.map((_, i) => {
    materials.push({ kind: 'texture', def: i });
    return materials.length - 1;
  });
  // Styles: per mesh colour, or the texture application for textured meshes.
  const styles = [];
  const styleOf = (m) => {
    const key = m.texture != null && textures[m.texture] ? `t${m.texture}` : `c${colourIndex(m.colour ?? [0.8, 0.8, 0.8])}`;
    let i = styles.findIndex((s) => s.key === key);
    if (i < 0) {
      styles.push(key[0] === 't' ? { key, material: texApp[m.texture] } : { key, colour: Number(key.slice(1)) });
      i = styles.length - 1;
    }
    return i;
  };
  const meshStyle = meshes.map(styleOf);

  const sections = {};
  {
    const w = new BitWriter();
    w.uint(0); // schema: no changed entity types (§6.3)
    w.uint(T.Globals);
    base(w, '', false);
    w.uint(0); // referenced file structures
    w.double(2000); // tessellation chord height ratio
    w.double(40); // tessellation angle (degrees)
    w.string(''); // MarkupSerializationHelper: default font family
    w.uint(0); // fonts
    w.uint(colours.length);
    for (const { c } of colours) for (const v of c) w.double(v);
    w.uint(textures.length);
    textures.forEach((tx, i) => {
      w.uint(T.Picture);
      base(w, `picture ${i}`, false);
      w.int(tx.format === 'png' ? 0 : 1); // KEPRCPicture_PNG / _JPG
      w.uint(i + 1); // uncompressed file index + 1
      w.uint(tx.width);
      w.uint(tx.height);
    });
    w.uint(textures.length);
    textures.forEach((tx, i) => {
      w.uint(T.TextureDefinition);
      base(w, `texture ${i}`, true);
      w.uint(i + 1); // picture index + 1
      w.char(2); // texture dimension
      w.int(2); // mapping type: coordinates stored on the 3D tessellation
      w.uint(1); // mapping attributes: diffuse
      w.uint(0); // intensities
      w.uint(0); // components
      w.int(2); // texture function: modulate
      w.int(1); // blend source RGB: unknown (reserved)
      w.int(1); // blend source alpha: unknown (reserved)
      w.char(0x01); // applying mode: lighting
      w.int(4); // wrapping S: clamp
      w.int(4); // wrapping T: clamp
      w.bool(false); // no texture transformation
    });
    w.uint(materials.length);
    for (const m of materials) {
      if (m.kind === 'generic') {
        w.uint(T.Material);
        base(w, 'material', true);
        w.uint(white + 1); // ambient
        w.uint(white + 1); // diffuse
        w.uint(black + 1); // emissive
        w.uint(grey + 1); // specular
        w.double(0.1); // shininess
        for (let k = 0; k < 4; k++) w.double(1); // alphas
      } else {
        w.uint(T.TextureApplication);
        base(w, `texture application ${m.def}`, true);
        w.uint(1); // material generic index + 1 (materials[0])
        w.uint(m.def + 1); // texture definition index + 1
        w.uint(0); // next texture: none
        w.uint(1); // UV coordinates index + 1
      }
    }
    w.uint(0); // line patterns
    w.uint(styles.length);
    for (const s of styles) {
      w.uint(T.Style);
      base(w, '', true);
      w.double(0.1); // line width (mm)
      w.bool(false); // not a vpicture
      w.uint(0); // line pattern index + 1: none
      w.bool(s.material != null); // a material (texture application) rather than a colour
      w.uint((s.material ?? s.colour) + 1);
      w.bool(false); // transparency not defined
      w.bool(false); // rendering parameters not defined
      w.bool(false);
      w.bool(false);
    }
    w.uint(0); // fill patterns
    w.uint(0); // reference coordinate systems
    userData(w);
    sections.globals = w.bytes();
  }
  // ---- tree: one part definition with one poly-brep model per mesh, one product occurrence ----
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes)
    for (let i = 0; i < m.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], m.positions[i + k]);
        hi[k] = Math.max(hi[k], m.positions[i + k]);
      }
  {
    const w = new BitWriter();
    w.uint(T.Tree);
    base(w, '', false);
    w.uint(1); // part definitions
    w.uint(T.PartDefinition);
    base(w, name, true);
    graphics(w, -1, -1, SHOW);
    for (const v of [...lo, ...hi]) w.double(v); // bounding box (not used by readers)
    w.uint(meshes.length);
    meshes.forEach((m, i) => {
      w.uint(T.PolyBrepModel);
      base(w, m.name ?? `mesh ${i}`, true);
      graphics(w, -1, meshStyle[i], SHOW);
      w.uint(0); // local coordinate system index + 1: none
      w.uint(i + 1); // tessellation index + 1
      w.bool(false); // not known to be closed
      userData(w);
    });
    for (let k = 0; k < 4; k++) w.uint(0); // markup data: linked items, leaders, markups, annotations
    w.uint(0); // views
    userData(w);
    w.uint(1); // product occurrences
    w.uint(T.ProductOccurrence);
    base(w, name, true);
    graphics(w, -1, -1, SHOW);
    w.uint(1); // part index + 1
    w.uint(0); // prototype: none
    w.uint(0); // external data: none
    w.uint(0); // son occurrences
    w.char(0); // behaviour
    w.bool(true); // unit from the CAD file (so that the optional unit is present in every reading)
    w.double(1000); // unit: metres
    w.char(0); // product information flags: regular
    w.int(3); // load status: loaded
    w.bool(false); // no location
    w.uint(0); // entity references
    for (let k = 0; k < 4; k++) w.uint(0); // markup data
    w.uint(0); // views
    w.bool(false); // no entity filter
    w.uint(0); // display filters
    w.uint(0); // scene display parameters
    userData(w);
    // FileStructure internal data.
    w.uint(T.FileStructure);
    base(w, '', false);
    w.uint(nextId); // next available index
    w.uint(0); // root product occurrence index
    userData(w); // the internal data's own (§8.6: every ASM subtype)
    userData(w); // the tree's
    sections.tree = w.bytes();
  }
  // ---- tessellation ----
  let triangles = 0;
  {
    const w = new BitWriter();
    w.uint(T.Tessellation);
    base(w, '', false);
    w.uint(meshes.length);
    for (const m of meshes) {
      const nv = m.positions.length / 3;
      const idx = m.indices ?? Uint32Array.from({ length: nv }, (_, i) => i);
      const nt = idx.length / 3;
      triangles += nt;
      const textured = m.texture != null && textures[m.texture] && m.uv;
      // Normals per vertex (computed from the faces when not given).
      const N = m.normals ?? vertexNormals(m.positions, idx);
      w.uint(T.Tess3D);
      w.bool(false); // is_calculated
      w.uint(3 * nv);
      for (let i = 0; i < 3 * nv; i++) w.double(m.positions[i]);
      w.bool(false); // has_faces
      w.bool(false); // has_loops
      w.bool(false); // normals are stored
      w.uint(3 * nv);
      for (let i = 0; i < 3 * nv; i++) w.double(N[i]);
      w.uint(0); // wire indices
      w.uint(idx.length * (textured ? 3 : 2));
      for (let i = 0; i < idx.length; i++) {
        const v = idx[i];
        w.uint(3 * v); // normal
        if (textured) w.uint(2 * v); // texture coordinate
        w.uint(3 * v); // point
      }
      w.uint(1); // face tessellations
      w.uint(T.TessFace);
      w.uint(0); // line attributes: the representation item's style applies
      w.uint(0); // start of wire data
      w.uint(0); // sizes of wires
      w.uint(textured ? TRIANGLE_TEXTURED : TRIANGLE);
      w.uint(0); // start in the triangulated index array
      w.uint(1);
      w.uint(nt); // number of triangles
      w.uint(textured ? 1 : 0); // texture coordinate indices per vertex
      w.bool(false); // no vertex colours
      w.uint(textured ? 2 * nv : 0);
      if (textured) for (let i = 0; i < 2 * nv; i++) w.double(m.uv[i]);
    }
    userData(w);
    sections.tessellation = w.bytes();
  }
  for (const [k, type] of [
    ['geometry', T.Geometry],
    ['extra', T.ExtraGeometry],
  ]) {
    const w = new BitWriter();
    w.uint(type);
    base(w, '', false);
    w.uint(0); // topological contexts / extra geometry contexts
    userData(w);
    sections[k] = w.bytes();
  }
  {
    const w = new BitWriter();
    w.uint(0); // schema
    w.uint(T.ModelFile);
    base(w, name, false);
    w.bool(true); // unit from the CAD file
    w.double(1000);
    w.uint(1); // root product occurrences
    for (const v of fsUid) w.uint(v >>> 0);
    w.uint(0); // index of the root product occurrence in the file structure
    w.bool(true); // active
    w.uint(0); // file structure index in the model file
    userData(w);
    sections.model = w.bytes();
  }
  // ---- the physical file ----
  const z = (b) => zlibSync(b, { level: 9 });
  const comp = { globals: z(sections.globals), tree: z(sections.tree), tessellation: z(sections.tessellation), geometry: z(sections.geometry), extra: z(sections.extra), model: z(sections.model) };
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const start = (id) => [0x50, 0x52, 0x43, ...u32(PRC_VERSION), ...u32(PRC_VERSION), ...id.flatMap(u32), ...appUid.flatMap(u32)];
  const fsHeader = Uint8Array.from([...start(fsUid), ...u32(textures.length)]);
  const fsFiles = textures.map((tx) => Uint8Array.from([...u32(tx.bytes.length), ...tx.bytes]));
  const fsHeaderLen = fsHeader.length + fsFiles.reduce((s, b) => s + b.length, 0);
  // File header: its size is fixed, so the offsets can be computed first.
  const headerLen = start(fileUid).length + 4 + (16 + 4 + 4 + 6 * 4) + 4 + 4 + 4;
  const off = { header: headerLen };
  off.globals = off.header + fsHeaderLen;
  off.tree = off.globals + comp.globals.length;
  off.tessellation = off.tree + comp.tree.length;
  off.geometry = off.tessellation + comp.tessellation.length;
  off.extra = off.geometry + comp.geometry.length;
  off.model = off.extra + comp.extra.length;
  off.end = off.model + comp.model.length;
  const header = Uint8Array.from([...start(fileUid), ...u32(1), ...fsUid.flatMap(u32), ...u32(0), ...u32(6), ...[off.header, off.globals, off.tree, off.tessellation, off.geometry, off.extra].flatMap(u32), ...u32(off.model), ...u32(off.end), ...u32(0)]);
  if (header.length !== headerLen) throw new Error('PRC: header size');
  const parts = [header, fsHeader, ...fsFiles, comp.globals, comp.tree, comp.tessellation, comp.geometry, comp.extra, comp.model];
  const out = new Uint8Array(off.end);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out, triangles, meshes: meshes.length, textures: textures.length, offsets: off, bbox: [lo, hi], uncompressed: sections };
}

/** Area-weighted vertex normals of an indexed triangle list. */
export function vertexNormals(P, idx) {
  const N = new Float64Array(P.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const ux = P[3 * b] - P[3 * a];
    const uy = P[3 * b + 1] - P[3 * a + 1];
    const uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a];
    const vy = P[3 * c + 1] - P[3 * a + 1];
    const vz = P[3 * c + 2] - P[3 * a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) N[3 * v + k] += n[k];
  }
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]);
    if (l > 0) for (let k = 0; k < 3; k++) N[v + k] /= l;
    else N[v + 2] = 1;
  }
  return N;
}
