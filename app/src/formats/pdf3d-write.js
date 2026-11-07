// 3D PDF (REQ-GAP-68): the 3D view's meshes (terrain, models, I3S layers) as a PRC stream in a
// 3D annotation (ISO 32000-1 §13.6; PRC needs PDF 1.7 with Adobe extension level 3), with a
// default view from the 3D view's camera and its rendered image as the poster (the annotation's
// appearance, which viewers without 3D show). Point clouds and points are left out (PRC point
// sets are not written) and counted.

import { writePrc } from './prc-write.js';
import { gwError } from '../i18n/index.js';

const MAX_TRIANGLES = 3e6;
const MAX_TEXTURE = 2048;

/** Bytes of an image (ImageBitmap, image, canvas, or {data, width, height} RGBA) as JPEG, at most MAX_TEXTURE px. */
async function jpegOf(img) {
  const w0 = img.width;
  const h0 = img.height;
  if (!w0 || !h0) return null;
  const s = Math.min(1, MAX_TEXTURE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  if (img.data && !(img instanceof ImageData) && !img.getContext) {
    const src = new OffscreenCanvas(w0, h0);
    const sg = src.getContext('2d');
    const id = sg.createImageData(w0, h0);
    id.data.set(img.data.subarray(0, w0 * h0 * 4));
    sg.putImageData(id, 0, 0);
    g.drawImage(src, 0, 0, w, h);
  } else g.drawImage(img, 0, 0, w, h);
  const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return { bytes: new Uint8Array(await b.arrayBuffer()), format: 'jpg', width: w, height: h };
}

/**
 * The meshes of a View3D in scene coordinates → {meshes, textures, camera, skipped, background}.
 * Textures are JPEG-encoded once per three.js texture.
 */
export async function sceneObjects(v) {
  const T = v.T;
  v.scene.updateMatrixWorld(true);
  const meshes = [];
  const textures = [];
  const texIndex = new Map();
  let skipped = 0;
  let tris = 0;
  const p = new T.Vector3();
  const visit = async (o) => {
    if (!o.visible || o === v.overlay) return;
    if (o.isPoints) skipped += o.geometry?.attributes?.position?.count ?? 0;
    if (o.isMesh && !o.isInstancedMesh && o.geometry?.attributes?.position) {
      const g = o.geometry;
      const a = g.attributes.position;
      const n = a.count;
      const pos = new Float64Array(3 * n);
      for (let i = 0; i < n; i++) {
        p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
        pos[3 * i] = p.x;
        pos[3 * i + 1] = p.y;
        pos[3 * i + 2] = p.z;
      }
      const idx = g.index ? Uint32Array.from(g.index.array) : null;
      const nt = (idx ? idx.length : n) / 3;
      tris += nt;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      let texture = null;
      let uv = null;
      const map = mat?.map;
      if (map?.image && g.attributes.uv) {
        if (!texIndex.has(map)) {
          let t = null;
          try {
            t = await jpegOf(map.image);
          } catch {
            t = null;
          }
          texIndex.set(map, t ? textures.push(t) - 1 : null);
        }
        texture = texIndex.get(map);
        if (texture != null) {
          const u = g.attributes.uv;
          uv = new Float64Array(2 * n);
          // PRC texture coordinates have v up from the bottom of the image (as OpenGL); a
          // three.js texture with flipY false has its first row at v = 0.
          for (let i = 0; i < n; i++) {
            uv[2 * i] = u.getX(i);
            uv[2 * i + 1] = map.flipY === false ? 1 - u.getY(i) : u.getY(i);
          }
        }
      }
      const c = mat?.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.8, 0.8, 0.8];
      meshes.push({ name: o.name || `mesh ${meshes.length + 1}`, positions: pos, indices: idx, uv, texture, colour: c });
    }
    for (const ch of o.children) await visit(ch);
  };
  await visit(v.world);
  if (tris > MAX_TRIANGLES) throw gwError('the 3D view has {n} triangles, more than the 3D PDF writer takes ({max})', { n: String(tris), max: String(MAX_TRIANGLES) }, 'E_PDF3D_TOO_BIG');
  const cam = v.camera;
  const target = v.controls?.target ?? new T.Vector3();
  return {
    meshes,
    textures,
    skipped,
    camera: { position: cam.position.toArray(), target: target.toArray(), up: cam.up.toArray(), fov: cam.fov, aspect: cam.aspect },
    background: v.settings?.background ?? [0.08, 0.09, 0.11],
  };
}

/**
 * The camera-to-world matrix of a 3D view (ISO 32000-1 §13.6.4: the camera at the origin of its
 * frame looking along +z, x to the right and y down) → 12 numbers [x, y, z axes, position] and
 * the distance to the centre of orbit.
 */
export function cameraToWorld({ position, target, up }) {
  const d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const dist = Math.hypot(...d) || 1;
  const z = d.map((x) => x / dist);
  let x = [z[1] * up[2] - z[2] * up[1], z[2] * up[0] - z[0] * up[2], z[0] * up[1] - z[1] * up[0]];
  let lx = Math.hypot(...x);
  if (lx < 1e-9) {
    x = [1, 0, 0];
    lx = 1;
  }
  x = x.map((v) => v / lx);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { c2w: [...x, ...y, ...z, ...position], co: dist };
}

const num = (v) => (Math.abs(v) < 1e-12 ? '0' : Number(v.toPrecision(12)).toString());
/** A PDF text string: literal when printable ASCII, else UTF-16BE hex. */
function pdfString(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const u = cp - 0x10000;
      hex += ((0xd800 | (u >> 10)) >>> 0).toString(16).padStart(4, '0') + ((0xdc00 | (u & 0x3ff)) >>> 0).toString(16).padStart(4, '0');
    } else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

/**
 * Write the 3D PDF. scene = sceneObjects(); poster = {bytes (JPEG), width, height} | null.
 * → {bytes, prc (writePrc result), triangles, meshes, textures, view {c2w, co, fov}}.
 */
export function write3dPdf({ meshes, textures, camera, background = [0.08, 0.09, 0.11], poster = null, title = 'GIS Workbench', skipped = 0, date = new Date() }) {
  const prc = writePrc({ meshes, textures, name: title });
  const { c2w, co } = cameraToWorld(camera);
  const W = 720;
  const H = Math.round(W / Math.max(0.3, Math.min(3, poster ? poster.width / poster.height : (camera.aspect ?? 1.5))));
  const te = new TextEncoder();
  const objs = [];
  const add = (body) => objs.push(body) && objs.length; // object number
  const stream = (dict, bytes) => ({ dict, bytes });
  const catalog = add(null);
  const pages = add(null);
  const page = add(null);
  const annot = add(null);
  const view = add(`<< /Type /3DView /XN (Default) /IN (Default) /MS /M /C2W [${c2w.map(num).join(' ')}] /CO ${num(co)} /P << /Subtype /P /FOV ${num(camera.fov ?? 30)} /PS /Min >> /BG << /Type /3DBG /Subtype /SC /C [${background.map(num).join(' ')}] >> /LS << /Type /3DLightingScheme /Subtype /Headlamp >> /RM << /Type /3DRenderMode /Subtype /Solid >> >>`);
  const d3 = add(stream(`<< /Type /3D /Subtype /PRC /VA [${view} 0 R] /DV 0 /Length ${prc.bytes.length} >>`, prc.bytes));
  let img = null;
  if (poster) img = add(stream(`<< /Type /XObject /Subtype /Image /Width ${poster.width} /Height ${poster.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${poster.bytes.length} >>`, poster.bytes));
  const apContent = te.encode(img ? `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n` : `q ${background.map(num).join(' ')} rg 0 0 ${W} ${H} re f Q\n`);
  const ap = add(stream(`<< /Type /XObject /Subtype /Form /BBox [0 0 ${W} ${H}] ${img ? `/Resources << /XObject << /Im0 ${img} 0 R >> >> ` : ''}/Length ${apContent.length} >>`, apContent));
  const contents = add(stream('<< /Length 0 >>', new Uint8Array(0)));
  const pad = (n) => String(n).padStart(2, '0');
  const pdfDate = `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const info = add(`<< /Title ${pdfString(title)} /Producer (GIS Workbench) /CreationDate (${pdfDate}) >>`);
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /Extensions << /ADBE << /BaseVersion /1.7 /ExtensionLevel 3 >> >> /PageMode /UseNone >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  objs[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Annots [${annot} 0 R] /Contents ${contents} 0 R /Resources << >> >>`;
  objs[annot - 1] = `<< /Type /Annot /Subtype /3D /Rect [0 0 ${W} ${H}] /F 4 /P ${page} 0 R /Contents ${pdfString(title)} /NM (gw-3d) /3DD ${d3} 0 R /3DV ${view} 0 R /3DA << /A /PO /D /PC /TB true /NP true >> /3DI true /AP << /N ${ap} 0 R >> >>`;
  // Serialise.
  const chunks = [te.encode('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let size = chunks[0].length;
  const xref = [];
  objs.forEach((o, i) => {
    xref.push(size);
    const head = te.encode(`${i + 1} 0 obj\n${typeof o === 'string' ? o : o.dict}\n`);
    const parts = typeof o === 'string' ? [head, te.encode('endobj\n')] : [head, te.encode('stream\n'), o.bytes, te.encode('\nendstream\nendobj\n')];
    for (const p of parts) {
      chunks.push(p);
      size += p.length;
    }
  });
  const xrefAt = size;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const at of xref) x += `${String(at).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(te.encode(x));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { bytes: out, prc, triangles: prc.triangles, meshes: prc.meshes, textures: prc.textures, skipped, view: { c2w, co, fov: camera.fov } };
}
