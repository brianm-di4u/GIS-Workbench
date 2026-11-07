// 3D model exchange formats (REQ-GAP-34, REQ-EXT-29): COLLADA 1.4.1 read and write, STL and PLY
// write, and KMZ with a COLLADA model placed by a KML <Model>. The models are those of mesh.js
// (buildings) and hub/terrain3d.js (terrain): `[{id, name, model: {vertices [[x, y, z]], faces
// [{idx}]}, attrs}]` in local east-north-up metres about `origin` {lat, lon, h (HAE)}, z up.
//
// - COLLADA: Z_UP, metres; one geometry and one node per model, triangles with per-face normals and
//   (textured) per-corner texture coordinates; the origin travels in a root <extra> (profile
//   "GISWorkbench") so the app places a model it wrote on re-import. The reader takes triangles,
//   polylist and polygons (fan-triangulated, as other readers do), the node hierarchy (matrix,
//   translate, rotate, scale, instance_node), <unit> and <up_axis>.
// - STL: binary (default) or ASCII; local ENU metres (STL has no units or georeference).
// - PLY 1.0: binary little-endian (default) or ASCII; shared vertices per model, triangle faces,
//   texture_u / texture_v when textured (the TextureFile comment names the image).
// - KMZ: doc.kml with one Placemark/Model at the origin (altitude above mean sea level, absolute),
//   models/model.dae and its texture beside it (Google Earth, three.js KMZLoader).
// Writers return strings (COLLADA, ASCII STL/PLY) or Uint8Array (binary, KMZ).

import { zipSync, strToU8 } from 'fflate';
import { faceTriangles, writeGltf as gltfWriter } from './mesh.js';

const fx = (v) => {
  const s = (Math.round(v * 1e4) / 1e4).toString();
  return s === '-0' ? '0' : s;
};
const fuv = (v) => String(Math.round(v * 1e6) / 1e6);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const ncName = (s, k) => `${String(s ?? 'm').replace(/[^\w.-]+/g, '_').replace(/^[^A-Za-z_]/, '_$&')}-${k}`;

function triNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

/** Triangles of a model as vertex index triples (faces triangulated on their plane). */
export function modelTriangles(model) {
  const out = [];
  for (const f of model.faces) {
    if (f.idx.length === 3) out.push(f.idx.slice());
    else out.push(...faceTriangles(model.vertices, f.idx));
  }
  return out;
}

/**
 * COLLADA 1.4.1 text. `texture` = {name (file name, e.g. "texture.png"), uv(x, y, z) → [u, v]
 * (v down, as glTF)} textures every face from one image; `imagePath` is the <init_from> path.
 */
export function writeCollada(models, origin, { texture = null, imagePath = null, generator = 'GIS Workbench', title = '', created = new Date().toISOString() } = {}) {
  const L = [];
  L.push('<?xml version="1.0" encoding="utf-8"?>');
  L.push('<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">');
  L.push(`  <asset><contributor><authoring_tool>${esc(generator)}</authoring_tool></contributor><created>${created}</created><modified>${created}</modified>${title ? `<title>${esc(title)}</title>` : ''}<unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>`);
  if (texture) L.push(`  <library_images><image id="tex0" name="tex0"><init_from>${esc(imagePath ?? texture.name ?? 'texture.png')}</init_from></image></library_images>`);
  const diffuse = texture ? '<texture texture="tex0-sampler" texcoord="UVSET0"/>' : '<color>0.82 0.78 0.72 1</color>';
  const params = texture ? '<newparam sid="tex0-surface"><surface type="2D"><init_from>tex0</init_from></surface></newparam><newparam sid="tex0-sampler"><sampler2D><source>tex0-surface</source></sampler2D></newparam>' : '';
  L.push(`  <library_effects><effect id="mat0-fx"><profile_COMMON>${params}<technique sid="common"><lambert><diffuse>${diffuse}</diffuse></lambert></technique></profile_COMMON><extra><technique profile="GOOGLEEARTH"><double_sided>${texture ? 1 : 0}</double_sided></technique></extra></effect></library_effects>`);
  L.push(`  <library_materials><material id="mat0" name="${texture ? 'textured' : 'building'}"><instance_effect url="#mat0-fx"/></material></library_materials>`);
  L.push('  <library_geometries>');
  const nodes = [];
  models.forEach((m, k) => {
    const id = ncName(m.id ?? m.name, k);
    const V = m.model.vertices;
    const tris = modelTriangles(m.model);
    const nrm = tris.map(([a, b, c]) => triNormal(V[a], V[b], V[c]));
    const pos = V.map((v) => v.map(fx).join(' ')).join(' ');
    L.push(`    <geometry id="${id}-mesh" name="${esc(m.name ?? m.id)}"><mesh>`);
    L.push(`      <source id="${id}-pos"><float_array id="${id}-pos-array" count="${V.length * 3}">${pos}</float_array><technique_common><accessor source="#${id}-pos-array" count="${V.length}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`);
    L.push(`      <source id="${id}-nrm"><float_array id="${id}-nrm-array" count="${nrm.length * 3}">${nrm.map((n) => n.map((x) => fx(x)).join(' ')).join(' ')}</float_array><technique_common><accessor source="#${id}-nrm-array" count="${nrm.length}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`);
    let uvIdx = null;
    if (texture) {
      // One texture coordinate per vertex (t = 1 − v: COLLADA's origin is the image's bottom left).
      const uv = V.map(([x, y, z]) => texture.uv(x, y, z));
      L.push(`      <source id="${id}-uv"><float_array id="${id}-uv-array" count="${uv.length * 2}">${uv.map(([u, v]) => `${fuv(u)} ${fuv(1 - v)}`).join(' ')}</float_array><technique_common><accessor source="#${id}-uv-array" count="${uv.length}" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>`);
      uvIdx = true;
    }
    L.push(`      <vertices id="${id}-vtx"><input semantic="POSITION" source="#${id}-pos"/></vertices>`);
    const p = tris.map((t, f) => t.map((v) => (uvIdx ? `${v} ${f} ${v}` : `${v} ${f}`)).join(' ')).join(' ');
    L.push(`      <triangles material="m0" count="${tris.length}"><input semantic="VERTEX" source="#${id}-vtx" offset="0"/><input semantic="NORMAL" source="#${id}-nrm" offset="1"/>${uvIdx ? `<input semantic="TEXCOORD" source="#${id}-uv" offset="2" set="0"/>` : ''}<p>${p}</p></triangles>`);
    L.push('    </mesh></geometry>');
    const attrs = Object.entries(m.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
    const extra = attrs.length ? `<extra><technique profile="GISWorkbench">${attrs.map(([key, v]) => `<attr name="${esc(key)}">${esc(v)}</attr>`).join('')}</technique></extra>` : '';
    nodes.push(`      <node id="${id}" name="${esc(m.name ?? m.id)}"><instance_geometry url="#${id}-mesh"><bind_material><technique_common><instance_material symbol="m0" target="#mat0">${texture ? '<bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/>' : ''}</instance_material></technique_common></bind_material></instance_geometry>${extra}</node>`);
  });
  L.push('  </library_geometries>');
  L.push('  <library_visual_scenes><visual_scene id="scene" name="scene">');
  L.push(...nodes);
  L.push('  </visual_scene></library_visual_scenes>');
  L.push('  <scene><instance_visual_scene url="#scene"/></scene>');
  if (origin) L.push(`  <extra><technique profile="GISWorkbench"><origin lat="${origin.lat}" lon="${origin.lon}" h="${origin.h}" frame="local ENU metres (x east, y north, z up); h above the WGS 84 ellipsoid"/></technique></extra>`);
  L.push('</COLLADA>');
  return `${L.join('\n')}\n`;
}

// ---- a small XML reader (COLLADA in the main thread, workers and Node tests alike) ----
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));

/** Parse XML into {name, attrs, children, text} elements (namespace prefixes dropped). */
export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = m[2].replace(/^.*:/, '');
      if (stack.length > 1 && top.name === name) stack.pop();
      else throw new Error(`malformed XML: </${m[2]}> does not close <${top.name}>`);
    } else if (m[3]) {
      const el = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[4] ?? ''))) el.attrs[a[1].replace(/^.*:/, '')] = unesc(a[2] ?? a[3] ?? '');
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined && stack.length > 1) top.text += unesc(m[6]);
  }
  if (stack.length > 1) throw new Error(`malformed XML: <${stack.at(-1).name}> is not closed`);
  return root;
}
const kids = (el, name) => (el?.children ?? []).filter((c) => c.name === name);
const kid = (el, name) => (el?.children ?? []).find((c) => c.name === name) ?? null;
function walk(el, fn) {
  fn(el);
  for (const c of el.children) walk(c, fn);
}
const nums = (s) => (s.trim() ? s.trim().split(/\s+/).map(Number) : []);

// 4 × 4 row-major matrices.
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
function rotation(x, y, z, deg) {
  const l = Math.hypot(x, y, z) || 1;
  [x, y, z] = [x / l, y / l, z / l];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1];
}
function nodeMatrix(node) {
  let M = I4();
  for (const c of node.children) {
    const v = nums(c.text);
    if (c.name === 'matrix' && v.length === 16) M = mul(M, v);
    else if (c.name === 'translate' && v.length === 3) M = mul(M, [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1]);
    else if (c.name === 'scale' && v.length === 3) M = mul(M, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]);
    else if (c.name === 'rotate' && v.length === 4) M = mul(M, rotation(...v));
  }
  return M;
}
const apply = (M, [x, y, z]) => [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]];

/**
 * Read COLLADA (1.4.x / 1.5) text → {models, origin, unit, upAxis, images [{id, path}], warnings}.
 * Geometry is flattened through the node hierarchy into metres, z up; faces are triangles; a
 * textured model carries `uvs` (per vertex, v down as glTF) and `image` (the image's path).
 */
export function readCollada(text) {
  const doc = parseXml(text);
  const root = kid(doc, 'COLLADA');
  if (!root) throw new Error('not a COLLADA document (no <COLLADA> root)');
  const warnings = [];
  const asset = kid(root, 'asset');
  const unit = Number(kid(asset, 'unit')?.attrs.meter ?? 1) || 1;
  const upAxis = (kid(asset, 'up_axis')?.text ?? 'Y_UP').trim().toUpperCase();
  const ids = new Map();
  walk(root, (e) => e.attrs.id && ids.set(e.attrs.id, e));
  const ref = (u) => (u ? ids.get(String(u).replace(/^#/, '')) : null);
  const images = [];
  for (const lib of kids(root, 'library_images')) for (const im of kids(lib, 'image')) images.push({ id: im.attrs.id, path: (kid(im, 'init_from')?.text ?? kid(kid(im, 'init_from'), 'ref')?.text ?? '').trim() });
  /** Float data of a <source>: {data, stride, offset}. */
  const source = (el) => {
    const arr = kid(el, 'float_array');
    const acc = kid(kid(el, 'technique_common'), 'accessor');
    return { data: arr ? nums(arr.text) : [], stride: Number(acc?.attrs.stride ?? 1), offset: Number(acc?.attrs.offset ?? 0), count: Number(acc?.attrs.count ?? 0) };
  };
  /** A material symbol's image (through effect → sampler → surface → image), or null. */
  const imageOfMaterial = (matId) => {
    const mat = ref(matId);
    const fxEl = ref(kid(mat, 'instance_effect')?.attrs.url);
    if (!fxEl) return null;
    let tex = null;
    walk(fxEl, (e) => {
      if (!tex && e.name === 'texture' && e.attrs.texture) tex = e.attrs.texture;
    });
    if (!tex) return null;
    const params = new Map();
    walk(fxEl, (e) => e.name === 'newparam' && params.set(e.attrs.sid, e));
    let id = tex;
    for (let k = 0; k < 3 && params.has(id); k++) {
      const p = params.get(id);
      const s = kid(kid(p, 'sampler2D'), 'source')?.text ?? kid(kid(p, 'surface'), 'init_from')?.text;
      if (!s) break;
      id = s.trim();
    }
    return images.find((im) => im.id === id)?.path ?? null;
  };
  /** Triangles of a <mesh>, in its own coordinates: {pos [[x,y,z]], tris [[a,b,c]], uv [[u,v]] | null}. */
  const meshOf = (geom, binds) => {
    const mesh = kid(geom, 'mesh');
    if (!mesh) {
      warnings.push(`geometry ${geom.attrs.id}: not a <mesh> (splines and convex meshes are skipped)`);
      return null;
    }
    const verts = kid(mesh, 'vertices');
    const posSrcId = kids(verts, 'input').find((i) => i.attrs.semantic === 'POSITION')?.attrs.source;
    const P = source(ref(posSrcId));
    const pos = [];
    const nPos = Math.min(P.count || Infinity, Math.floor((P.data.length - P.offset) / P.stride + 1e-9));
    for (let k = 0; k < nPos; k++) pos.push([P.data[k * P.stride + P.offset], P.data[k * P.stride + P.offset + 1], P.data[k * P.stride + P.offset + 2]]);
    const out = { pos: [], tris: [], uv: null, image: null };
    const key = new Map();
    for (const prim of mesh.children) {
      if (!['triangles', 'polylist', 'polygons', 'trifans', 'tristrips', 'lines', 'linestrips'].includes(prim.name)) continue;
      if (prim.name === 'lines' || prim.name === 'linestrips') continue;
      const inputs = kids(prim, 'input').map((i) => ({ sem: i.attrs.semantic, off: Number(i.attrs.offset ?? 0), src: i.attrs.source, set: Number(i.attrs.set ?? 0) }));
      const stride = Math.max(...inputs.map((i) => i.off)) + 1;
      const vIn = inputs.find((i) => i.sem === 'VERTEX');
      if (!vIn) continue;
      const tIn = inputs.filter((i) => i.sem === 'TEXCOORD').sort((a, b) => a.set - b.set)[0];
      const T = tIn ? source(ref(tIn.src)) : null;
      const img = binds?.get(prim.attrs.material) ?? null;
      if (T && img) {
        out.uv ??= [];
        out.image ??= img;
      }
      /** Output vertex for one corner (position + texture coordinate pair, shared when equal). */
      const corner = (p, c) => {
        const vi = p[c * stride + vIn.off];
        const ti = T ? p[c * stride + tIn.off] : -1;
        const k = `${vi}/${ti}`;
        if (!key.has(k)) {
          key.set(k, out.pos.length);
          out.pos.push(pos[vi]);
          if (out.uv) out.uv.push(T && ti >= 0 ? [T.data[ti * T.stride + T.offset], 1 - T.data[ti * T.stride + T.offset + 1]] : [0, 0]);
        }
        return key.get(k);
      };
      const polys = [];
      if (prim.name === 'triangles') {
        const p = nums(kid(prim, 'p')?.text ?? '');
        for (let c = 0; c + 2 < p.length / stride; c += 3) polys.push([corner(p, c), corner(p, c + 1), corner(p, c + 2)]);
      } else if (prim.name === 'polylist') {
        const p = nums(kid(prim, 'p')?.text ?? '');
        let c = 0;
        for (const n of nums(kid(prim, 'vcount')?.text ?? '')) {
          polys.push(Array.from({ length: n }, (_, k) => corner(p, c + k)));
          c += n;
        }
      } else if (prim.name === 'polygons') {
        for (const pe of kids(prim, 'p')) {
          const p = nums(pe.text);
          polys.push(Array.from({ length: p.length / stride }, (_, k) => corner(p, k)));
        }
        if (kids(prim, 'ph').length) warnings.push('polygons with holes (<ph>) are read without their holes');
      } else {
        for (const pe of kids(prim, 'p')) {
          const p = nums(pe.text);
          const n = p.length / stride;
          const idx = Array.from({ length: n }, (_, k) => corner(p, k));
          for (let k = 2; k < n; k++) out.tris.push(prim.name === 'trifans' ? [idx[0], idx[k - 1], idx[k]] : k % 2 ? [idx[k - 1], idx[k - 2], idx[k]] : [idx[k - 2], idx[k - 1], idx[k]]);
        }
      }
      for (const poly of polys) for (let k = 2; k < poly.length; k++) out.tris.push([poly[0], poly[k - 1], poly[k]]);
    }
    return out;
  };
  // Up axis and unit to metres, z up.
  const up = upAxis === 'Z_UP' ? (v) => v : upAxis === 'X_UP' ? ([x, y, z]) => [-y, z, x] : ([x, y, z]) => [x, -z, y];
  const models = [];
  const visit = (node, M, depth) => {
    if (depth > 64) return;
    const Mn = mul(M, nodeMatrix(node));
    for (const ig of kids(node, 'instance_geometry')) {
      const g = ref(ig.attrs.url);
      if (!g) continue;
      const binds = new Map();
      walk(ig, (e) => e.name === 'instance_material' && binds.set(e.attrs.symbol, imageOfMaterial(e.attrs.target)));
      const mesh = meshOf(g, binds);
      if (!mesh || !mesh.tris.length) continue;
      const attrs = {};
      for (const a of kids(kid(kid(node, 'extra'), 'technique'), 'attr')) attrs[a.attrs.name] = a.text;
      models.push({ id: node.attrs.id ?? g.attrs.id ?? `m${models.length}`, name: node.attrs.name ?? g.attrs.name ?? node.attrs.id ?? '', attrs, image: mesh.image, uvs: mesh.uv, model: { vertices: mesh.pos.map((p) => up(apply(Mn, p).map((x) => x * unit))), faces: mesh.tris.map((idx) => ({ idx })) } });
    }
    for (const inst of kids(node, 'instance_node')) {
      const n = ref(inst.attrs.url);
      if (n) visit(n, Mn, depth + 1);
    }
    for (const c of kids(node, 'node')) visit(c, Mn, depth + 1);
  };
  const sceneUrl = kid(kid(root, 'scene'), 'instance_visual_scene')?.attrs.url;
  const vs = ref(sceneUrl) ?? kid(kid(root, 'library_visual_scenes'), 'visual_scene');
  if (vs) for (const n of kids(vs, 'node')) visit(n, I4(), 0);
  if (!models.length) throw new Error('the COLLADA document has no triangle geometry in its scene');
  const o = kid(kids(kid(root, 'extra') ?? { children: [] }, 'technique').find((t) => t.attrs.profile === 'GISWorkbench'), 'origin');
  const origin = o && Number.isFinite(Number(o.attrs.lat)) ? { lat: Number(o.attrs.lat), lon: Number(o.attrs.lon), h: Number(o.attrs.h) || 0 } : null;
  return { models, origin, unit, upAxis, images, warnings };
}

// ---- STL ----
/** STL of the models (local ENU metres): binary by default, ASCII with `binary: false`. */
export function writeStl(models, origin, { binary = true, name = 'GIS Workbench' } = {}) {
  const tris = [];
  for (const m of models) for (const [a, b, c] of modelTriangles(m.model)) tris.push([m.model.vertices[a], m.model.vertices[b], m.model.vertices[c]]);
  const note = origin ? `${name}; local ENU metres about lat ${origin.lat.toFixed(7)} lon ${origin.lon.toFixed(7)} h ${origin.h.toFixed(2)} HAE` : name;
  if (!binary) {
    const solid = String(name).replace(/\s+/g, '_');
    const L = [`solid ${solid}`];
    for (const [a, b, c] of tris) {
      const n = triNormal(a, b, c);
      L.push(`  facet normal ${n.map((x) => x.toExponential(6)).join(' ')}`, '    outer loop', ...[a, b, c].map((v) => `      vertex ${v.map((x) => x.toExponential(7)).join(' ')}`), '    endloop', '  endfacet');
    }
    L.push(`endsolid ${solid}`);
    return `${L.join('\n')}\n`;
  }
  const out = new Uint8Array(84 + 50 * tris.length);
  // The 80-byte header must not start with "solid" (readers would take the file for ASCII).
  out.set(strToU8(note.replace(/^solid/i, 'STL')).subarray(0, 80));
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  tris.forEach(([a, b, c], i) => {
    const o = 84 + 50 * i;
    [...triNormal(a, b, c), ...a, ...b, ...c].forEach((x, k) => dv.setFloat32(o + 4 * k, x, true));
  });
  return out;
}

// ---- PLY ----
/** PLY 1.0 of the models: binary little-endian by default; texture_u/v (t up) when `texture` is given. */
export function writePly(models, origin, { binary = true, texture = null } = {}) {
  const V = [];
  const F = [];
  for (const m of models) {
    const base = V.length;
    V.push(...m.model.vertices);
    for (const t of modelTriangles(m.model)) F.push(t.map((i) => i + base));
  }
  const uv = texture ? V.map(([x, y, z]) => texture.uv(x, y, z)) : null;
  const head = ['ply', `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0`, 'comment GIS Workbench'];
  if (origin) head.push(`comment local ENU metres (x east, y north, z up) about lat ${origin.lat} lon ${origin.lon} h ${origin.h} HAE`);
  if (texture) head.push(`comment TextureFile ${texture.name ?? 'texture.png'}`);
  head.push(`element vertex ${V.length}`, 'property float x', 'property float y', 'property float z');
  if (uv) head.push('property float texture_u', 'property float texture_v');
  head.push(`element face ${F.length}`, 'property list uchar int vertex_indices', 'end_header');
  const header = `${head.join('\n')}\n`;
  if (!binary) {
    const lines = V.map((v, i) => [...v.map((x) => x.toFixed(4)), ...(uv ? [uv[i][0].toFixed(6), (1 - uv[i][1]).toFixed(6)] : [])].join(' '));
    for (const f of F) lines.push(`3 ${f.join(' ')}`);
    return `${header}${lines.join('\n')}\n`;
  }
  const h = strToU8(header);
  const per = uv ? 20 : 12;
  const out = new Uint8Array(h.length + V.length * per + F.length * 13);
  out.set(h);
  const dv = new DataView(out.buffer);
  let o = h.length;
  V.forEach((v, i) => {
    for (const x of v) (dv.setFloat32(o, x, true), (o += 4));
    if (uv) {
      dv.setFloat32(o, uv[i][0], true);
      dv.setFloat32(o + 4, 1 - uv[i][1], true);
      o += 8;
    }
  });
  for (const f of F) {
    dv.setUint8(o++, 3);
    for (const i of f) (dv.setInt32(o, i, true), (o += 4));
  }
  return out;
}

// ---- KMZ with a COLLADA model ----
/**
 * KMZ: doc.kml (one Placemark/Model at the origin, absolute altitude `altitude` metres above mean
 * sea level), models/model.dae and, when textured, models/<texture.name> (the texture.png bytes).
 */
export function writeKmz(models, origin, { altitude = origin.h, texture = null, name = 'GIS Workbench model', description = '', created } = {}) {
  const texName = texture ? (texture.name ?? 'texture.png').replace(/[^\w.-]+/g, '_') : null;
  const dae = writeCollada(models, origin, { texture: texture && { ...texture, name: texName }, imagePath: texName, title: name, created });
  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    `<Document><name>${esc(name)}</name>`,
    `<Placemark><name>${esc(name)}</name>${description ? `<description>${esc(description)}</description>` : ''}`,
    '<Model id="model0"><altitudeMode>absolute</altitudeMode>',
    `<Location><longitude>${origin.lon.toFixed(9)}</longitude><latitude>${origin.lat.toFixed(9)}</latitude><altitude>${altitude.toFixed(3)}</altitude></Location>`,
    '<Orientation><heading>0</heading><tilt>0</tilt><roll>0</roll></Orientation>',
    '<Scale><x>1</x><y>1</y><z>1</z></Scale>',
    '<Link><href>models/model.dae</href></Link>',
    texName ? `<ResourceMap><Alias><targetHref>models/${texName}</targetHref><sourceHref>${texName}</sourceHref></Alias></ResourceMap>` : '',
    '</Model></Placemark></Document></kml>',
  ].join('\n');
  const files = { 'doc.kml': strToU8(kml), 'models/model.dae': strToU8(dae) };
  if (texture) files[`models/${texName}`] = texture.png;
  return zipSync(files, { level: 6 });
}

/** The <Model> of a KML document: {href, lat, lon, altitude, altitudeMode, heading} or null. */
export function kmlModel(kmlText) {
  const doc = parseXml(kmlText);
  let model = null;
  walk(doc, (e) => {
    if (!model && e.name === 'Model') model = e;
  });
  if (!model) return null;
  const loc = kid(model, 'Location');
  const num = (el, n) => Number(kid(el, n)?.text ?? NaN);
  return { href: (kid(kid(model, 'Link'), 'href')?.text ?? '').trim(), lat: num(loc, 'latitude'), lon: num(loc, 'longitude'), altitude: num(loc, 'altitude') || 0, altitudeMode: (kid(model, 'altitudeMode')?.text ?? 'relativeToGround').trim(), heading: num(kid(model, 'Orientation'), 'heading') || 0 };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const base = (p) => decodeURIComponent(String(p ?? '').split(/[\/]/).pop()).toLowerCase();

/**
 * A read COLLADA document ({models, origin} of readCollada) as GLB bytes for the 3D view, placed by
 * `origin` (the document's own, or a KML Model location) when there is one. `images` = Map of
 * lower-case file name → bytes: a model textured from one image keeps it (glTF holds one here).
 * → {glb, textured, warnings}.
 */
export function colladaToGlb(doc, { origin = doc.origin, images = new Map(), writeGltf = gltfWriter } = {}) {
  const warnings = [...(doc.warnings ?? [])];
  const used = [...new Set(doc.models.filter((m) => m.image && m.uvs).map((m) => base(m.image)))];
  let texture = null;
  if (used.length === 1 && images.has(used[0])) {
    const uv = new Map();
    for (const m of doc.models) if (m.uvs && base(m.image) === used[0]) m.model.vertices.forEach((v, i) => uv.set(v.map((x) => x.toFixed(5)).join(','), m.uvs[i]));
    texture = { png: images.get(used[0]), mime: MIME[used[0].split('.').pop()] ?? 'image/png', name: used[0], uv: (x, y, z) => uv.get([x, y, z].map((q) => q.toFixed(5)).join(',')) ?? [0, 0] };
  } else if (used.length) warnings.push(used.length > 1 ? `${used.length} textures: shown untextured (one texture per model is carried)` : `texture ${used[0]} was not found beside the model`);
  const models = doc.models.map((m) => ({ id: m.id, name: m.name, model: m.model, attrs: m.attrs }));
  const glb = writeGltf(models, origin ?? undefined, { glb: true, generator: 'GIS Workbench (from COLLADA)', texture });
  return { glb, textured: !!texture, warnings };
}
