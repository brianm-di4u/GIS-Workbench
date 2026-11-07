// The 3D codec pack (REQ-FMT-35, REQ-ARC-14): Draco and Basis Universal encoders for glTF and
// 3D Tiles export, from the hash-checked `codec-3d` data pack (File ▸ Open ▸ Open Data Pack). The
// pack's script runs from a blob: URL (script-src blob:) and its WASM is passed as bytes; nothing
// is fetched. Encoders: {draco: Draco encoder module, ktx2: async (imageBytes, mime) → KTX2}.

import { entryUrl } from '../storage/packs.js';

let ready = null;

export const hasCodecPack = (app) => !!app.packs && (app.packs.loaded?.has('codec-3d') || app.packs.stored?.has('codec-3d'));

async function runClassic(url) {
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = res;
    s.onerror = () => rej(new Error('the codec pack script failed to run'));
    document.head.appendChild(s);
  });
}

/** Decode a PNG/JPEG to RGBA {width, height, data}. */
async function rgbaOf(bytes, mime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime || 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close?.();
  return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) };
}

export function codecEncoders(app) {
  ready ??= (async () => {
    const p = await app.packs.require('codec-3d', 'Draco / KTX2 export');
    if (!globalThis.GWCodec3D) {
      const url = entryUrl(p, 'codec-3d.js');
      try {
        await runClassic(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const G = globalThis.GWCodec3D;
    if (!G) throw new Error('the codec pack did not load');
    const quiet = { print: () => {}, printErr: () => {} };
    const draco = await G.DracoEncoderModule({ wasmBinary: p.entries.get('draco_encoder.wasm'), ...quiet });
    const basis = await G.BASIS({ wasmBinary: p.entries.get('basis_encoder.wasm'), locateFile: (f) => f, ...quiet });
    basis.initializeBasis();
    const ktx2 = async (bytes, mime) => {
      const img = await rgbaOf(bytes, mime);
      return G.encodeWithModule(basis, bytes, { isUASTC: false, qualityLevel: 128, generateMipmap: true, isInputSRGB: true, imageDecoder: async () => img });
    };
    return { draco, ktx2 };
  })();
  ready.catch(() => (ready = null));
  return ready;
}
