// Data packs (REQ-ARC-14; `Research/15` §2.3): ZIP files with a `pack.json` manifest (name,
// version, licence, minimum tool version, SHA-256 and kind of every entry). The build writes each
// pack to dist/packs/ and returns the hashes for the HTML's build manifest: the tool executes a
// pack's JS/WASM/model entries only when their SHA-256 is listed there.
//
//   node build/packs.mjs --fetch     download the pinned inputs into .cache/packs-src (checked)
//
// Packs: geoid (EGM2008 5′ grid), hdf5 (h5wasm), proj (PROJ-WASM with proj.db), ai (onnxruntime-web
// WASM and WebGPU runtimes + SlimSAM int8) and the 2.0 model packs (2.0 plan P5, DN-56), which need
// the ai pack's runtime: ai-sam2 (SAM 2.1 tiny), ai-detect (OWLv2), ai-search (CLIP ViT-B/32) and
// ai-match (DISK + LightGlue). A pack whose inputs are missing is skipped with a warning.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(root, '.cache', 'packs-src');
const SOURCES = JSON.parse(readFileSync(join(root, 'build', 'packs-sources.json'), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const nm = (...p) => join(root, 'node_modules', ...p);
const pkgVersion = (name) => JSON.parse(readFileSync(nm(name, 'package.json'), 'utf8')).version;
const cached = (id) => {
  const s = SOURCES.downloads.find((d) => d.id === id);
  const f = join(CACHE, s.extract?.to ?? s.file);
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  const want = s.extract?.sha256 ?? s.sha256;
  if (sha256(b) !== want) throw new Error(`pack input ${f} does not match its pinned SHA-256`);
  return b;
};

async function fetchAll() {
  mkdirSync(CACHE, { recursive: true });
  for (const s of SOURCES.downloads) {
    const f = join(CACHE, s.file);
    if (!existsSync(f) || sha256(readFileSync(f)) !== s.sha256) {
      const r = await fetch(s.url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`${s.url}: HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      if (sha256(b) !== s.sha256) throw new Error(`${s.url}: SHA-256 ${sha256(b)} is not the pinned ${s.sha256}`);
      writeFileSync(f, b);
    }
    if (s.extract) {
      // tar.bz2 needs bzip2, which Node lacks: Python's tarfile (isolated mode) extracts one member.
      execFileSync('python', ['-I', '-c', 'import sys,tarfile;t=tarfile.open(sys.argv[1],"r:bz2");m=t.getmember(sys.argv[2]);open(sys.argv[3],"wb").write(t.extractfile(m).read())', f, s.extract.member, join(CACHE, s.extract.to)]);
      if (sha256(readFileSync(join(CACHE, s.extract.to))) !== s.extract.sha256) throw new Error(`${s.extract.to}: extracted file does not match its pin`);
    }
    console.log(`ok ${s.file}`);
  }
}

// onnxruntime-web's npm package carries no licence file; this is the MIT licence of the
// microsoft/onnxruntime repository (its ThirdPartyNotices.txt lists the bundled components).
const ORT_MIT = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Third-party components inside the WebAssembly build: see https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt`;

/**
 * The WebGPU glue's emval method invoker is built with `new Function` (Emscripten's dynamic
 * execution), which the app's CSP and the REQ-ARC-04 eval gate refuse. This replaces it with a
 * closure that does the same call: the converters read each argument (8 bytes apart), the call
 * kind picks function / constructor / method, and a non-void result goes back through the return
 * wire. Pinned to onnxruntime-web 1.30.0's minified names; the build fails if the text moves.
 */
function noEvalGlue(text) {
  const from = 'c=(new Function(Object.keys(k),h))(...Object.values(k));';
  const to = 'c=((K,F,B,V)=>function(handle,methodName,destructorsRef,args){var v=F.map((l,p)=>l(args+8*p)),r;switch(K){case 0:r=R(handle)(...v);break;case 2:r=new(R(handle))(...v);break;case 3:r=v[v.length-1];break;case 1:r=R(handle)[Yg(methodName)](...v)}if(!V)return Wg(B,destructorsRef,r)})(c,f,b,d.we);';
  if (text.split(from).length !== 2) throw new Error('onnxruntime-web asyncify glue: the emval invoker was not found once; update noEvalGlue for this version');
  return Buffer.from(text.replace(from, to));
}

const HDF5_NOTICE = 'h5wasm (https://github.com/usnistgov/h5wasm) is NIST-developed software. Acknowledgement: National Institute of Standards and Technology. GIS Workbench ships the h5wasm IIFE build unchanged.\n\n';

/** Pack definitions: entries [{path, kind: 'js'|'wasm'|'model'|'data', bytes}] or null when inputs are missing. */
async function definitions(esbuild) {
  const out = [];
  const egm = cached('egm2008-5');
  if (egm) {
    const s = SOURCES.downloads.find((d) => d.id === 'egm2008-5');
    out.push({ name: 'geoid', title: 'EGM2008 geoid (5′ grid)', version: '2008.5min', description: 'EGM2008 geoid heights on a 5′ grid (GeographicLib PGM), for MSL ↔ HAE where EGM96 is not enough (REQ-GEO).', licence: s.licence, entries: [{ path: 'egm2008-5.pgm', kind: 'data', bytes: egm }] });
  }
  if (existsSync(nm('h5wasm', 'dist', 'iife', 'h5wasm.js'))) {
    out.push({ name: 'hdf5', title: 'HDF5 reader (h5wasm)', version: pkgVersion('h5wasm'), description: 'Reads HDF5 / HDF-EOS5 / NetCDF-4 hyperspectral products (PRISMA, EnMAP, EMIT) in the decode worker (REQ-MSI-02).', licence: HDF5_NOTICE + readFileSync(nm('h5wasm', 'LICENSE.txt'), 'utf8'), entries: [{ path: 'h5wasm.js', kind: 'js', bytes: readFileSync(nm('h5wasm', 'dist', 'iife', 'h5wasm.js')) }] });
  }
  if (existsSync(nm('proj-wasm', 'dist', 'proj-emscripten.js'))) {
    // The Emscripten module is an ES module; rebundle it as a classic script that defines
    // globalThis.PROJModule (the app passes the wasm bytes; no fetch, no import.meta).
    const r = await esbuild.build({ entryPoints: [nm('proj-wasm', 'dist', 'proj-emscripten.js')], bundle: true, external: ['node:*'], format: 'iife', globalName: '__projmod', write: false, minify: true, platform: 'browser', target: 'es2022', define: { 'import.meta.url': '"file:///gw-pack/proj.js"' }, logLevel: 'error', footer: { js: 'globalThis.PROJModule = __projmod.default;' } });
    const licence = `proj-wasm ${pkgVersion('proj-wasm')} (MIT):\n${readFileSync(nm('proj-wasm', 'LICENSE'), 'utf8')}\n\n${readFileSync(nm('proj-wasm', 'dist', 'THIRD-PARTY-NOTICES.md'), 'utf8')}`;
    out.push({ name: 'proj', title: 'PROJ (proj-wasm with proj.db)', version: pkgVersion('proj-wasm'), description: 'Full PROJ with the EPSG database for CRSs outside the embedded table (REQ-GEO-12).', licence, entries: [{ path: 'proj.js', kind: 'js', bytes: Buffer.from(r.outputFiles[0].text) }, { path: 'proj.wasm', kind: 'wasm', bytes: readFileSync(nm('proj-wasm', 'dist', 'proj-emscripten.wasm')) }, { path: 'proj.db', kind: 'data', bytes: readFileSync(nm('proj-wasm', 'dist', 'proj.db')) }] });
  }
  const enc = cached('slimsam-encoder');
  const dec = cached('slimsam-decoder');
  const cfg = cached('slimsam-config');
  if (enc && dec && cfg && existsSync(nm('onnxruntime-web', 'dist', 'ort.wasm.min.js'))) {
    const v = pkgVersion('onnxruntime-web');
    const licence = `onnxruntime-web ${v} (MIT):\n${ORT_MIT}\n\nSlimSAM-77-uniform (Z. Chen et al., "SlimSAM: 0.1% Data Makes Segment Anything Slim"; weights nielsr/slimsam-77-uniform, ONNX export Xenova/slimsam-77-uniform): Apache-2.0. Based on Segment Anything (Meta AI, Apache-2.0).`;
    out.push({
      name: 'ai',
      title: 'Local AI runtime (WebGPU / WASM) and SlimSAM',
      spdx: ['MIT', 'Apache-2.0'],
      version: `${v}+slimsam77.webgpu`,
      description: 'The on-device AI runtime (onnxruntime-web: WebGPU, with a WASM fallback) and SlimSAM smart select; the model packs need it (REQ-EXT-18, REQ-AI-18, REQ-LAI-01). Nothing leaves the machine.',
      licence,
      entries: [
        { path: 'ort.wasm.min.js', kind: 'js', bytes: readFileSync(nm('onnxruntime-web', 'dist', 'ort.wasm.min.js')) },
        { path: 'ort-wasm-simd-threaded.mjs', kind: 'js', bytes: readFileSync(nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs')) },
        { path: 'ort-wasm-simd-threaded.wasm', kind: 'wasm', bytes: readFileSync(nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm')) },
        // The WebGPU build (REQ-LAI-01): used when the device has a WebGPU adapter; WASM otherwise.
        { path: 'ort.webgpu.min.js', kind: 'js', bytes: readFileSync(nm('onnxruntime-web', 'dist', 'ort.webgpu.min.js')) },
        { path: 'ort-wasm-simd-threaded.asyncify.mjs', kind: 'js', bytes: noEvalGlue(readFileSync(nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.asyncify.mjs'), 'utf8')) },
        { path: 'ort-wasm-simd-threaded.asyncify.wasm', kind: 'wasm', bytes: readFileSync(nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.asyncify.wasm')) },
        { path: 'slimsam/vision_encoder_quantized.onnx', kind: 'model', bytes: enc },
        { path: 'slimsam/prompt_encoder_mask_decoder_quantized.onnx', kind: 'model', bytes: dec },
        { path: 'slimsam/preprocessor_config.json', kind: 'data', bytes: cfg },
      ],
    });
  }
  // ---- 2.0 model packs (P5). Each needs the ai pack's runtime. ----
  const pack = (name, title, version, description, licence, ids, spdx) => {
    const bytes = ids.map(([id]) => cached(id));
    if (bytes.some((b) => !b)) return;
    out.push({ name, title, version, description, licence: `${licence}\n\nRuns in the onnxruntime-web runtime of the ai pack (MIT).`, spdx, requires: 'ai', entries: ids.map(([, path, kind], i) => ({ path, kind, bytes: bytes[i] })) });
  };
  pack('ai-sam2', 'Local AI: SAM 2.1 click-to-polygon', '2.1-tiny-int8', 'SAM 2.1 hiera-tiny (int8) for click and box segmentation, with outlines squared on request (REQ-LAI-02).', 'SAM 2.1 hiera-tiny: Meta AI, facebook/sam2.1-hiera-tiny, Apache-2.0 (github.com/facebookresearch/sam2). ONNX export: onnx-community/sam2.1-hiera-tiny-ONNX.', [
    ['sam2-encoder', 'sam2/vision_encoder_int8.onnx', 'model'],
    ['sam2-encoder-data', 'sam2/vision_encoder_int8.onnx_data', 'model'],
    ['sam2-decoder', 'sam2/prompt_encoder_mask_decoder_int8.onnx', 'model'],
    ['sam2-decoder-data', 'sam2/prompt_encoder_mask_decoder_int8.onnx_data', 'model'],
    ['sam2-config', 'sam2/preprocessor_config.json', 'data'],
  ], ['Apache-2.0']);
  pack('ai-detect', 'Local AI: OWLv2 open-vocabulary detection', 'owlv2-b16-q8', 'OWLv2 base (patch 16, ensemble; 8-bit) finds objects named in plain words, tiled over the view (REQ-LAI-03).', 'OWLv2: Google, google/owlv2-base-patch16-ensemble, Apache-2.0 (github.com/google-research/scenic). ONNX export: Xenova/owlv2-base-patch16-ensemble. CLIP tokenizer vocabulary and merges: OpenAI CLIP, MIT.', [
    ['owlv2-model', 'owlv2/model_quantized.onnx', 'model'],
    ['owlv2-config', 'owlv2/preprocessor_config.json', 'data'],
    ['clip-vocab', 'clip/vocab.json', 'data'],
    ['clip-merges', 'clip/merges.txt', 'data'],
  ], ['Apache-2.0', 'MIT']);
  pack('ai-search', 'Local AI: CLIP semantic search', 'clip-b32-q8', 'CLIP ViT-B/32 (8-bit) image and text embeddings: type what you are looking for and fly to the best matching places (REQ-LAI-06).', 'CLIP ViT-B/32: OpenAI, openai/clip-vit-base-patch32; code and weights MIT (github.com/openai/CLIP). ONNX export: Xenova/clip-vit-base-patch32.', [
    ['clip-vision', 'clip/vision_model_quantized.onnx', 'model'],
    ['clip-text', 'clip/text_model_quantized.onnx', 'model'],
    ['clip-config', 'clip/preprocessor_config.json', 'data'],
    ['clip-vocab', 'clip/vocab.json', 'data'],
    ['clip-merges', 'clip/merges.txt', 'data'],
  ], ['MIT']);
  pack('ai-match', 'Local AI: DISK + LightGlue co-registration', 'disk-lightglue-2.0', 'Learned keypoints (DISK) and matching (LightGlue) for Auto Align (AI) between dates or sensors (REQ-LAI-05).', 'DISK: cvlab-epfl/disk, Apache-2.0. LightGlue and its DISK-trained weights: cvg/LightGlue, Apache-2.0 (the SuperPoint weights, which are not licensed for commercial use, are not used). End-to-end ONNX pipeline: fabio-sim/LightGlue-ONNX v2.0, Apache-2.0.', [['disk-lightglue', 'lightglue/disk_lightglue_pipeline.onnx', 'model']], ['Apache-2.0']);
  return out;
}

/**
 * Build every pack into `outDir`/packs; returns {manifest: {name: {...}}, files, warnings, code}
 * where `code` lists the JS entries for the eval gate.
 */
export async function buildPacks({ outDir, esbuild, toolVersion }) {
  const dir = join(outDir, 'packs');
  mkdirSync(dir, { recursive: true });
  const manifest = {};
  const files = [];
  const code = [];
  const models = []; // REQ-LAI-08: {pack, spdx, licence} of every pack that carries a model
  const warnings = [];
  const defs = await definitions(esbuild);
  for (const want of ['geoid', 'hdf5', 'proj', 'ai', 'ai-sam2', 'ai-detect', 'ai-search', 'ai-match']) if (!defs.some((d) => d.name === want)) warnings.push(`pack "${want}" skipped: its inputs are missing (run node build/packs.mjs --fetch)`);
  for (const p of defs) {
    const entries = p.entries.map((e) => ({ path: e.path, kind: e.kind, size: e.bytes.length, sha256: sha256(e.bytes) }));
    const pj = { format: 'gw-pack/1', name: p.name, title: p.title, version: p.version, minTool: toolVersion, description: p.description, licence: p.licence, ...(p.requires ? { requires: p.requires } : {}), created: new Date().toISOString().slice(0, 10), entries };
    const pjBytes = strToU8(JSON.stringify(pj, null, 1));
    const zip = zipSync({ 'pack.json': pjBytes, 'LICENCE.txt': strToU8(p.licence), ...Object.fromEntries(p.entries.map((e) => [e.path, [new Uint8Array(e.bytes), { level: e.kind === 'model' ? 0 : 6 }]])) });
    const file = `${p.name}-${p.version}.gwpack`;
    writeFileSync(join(dir, file), zip);
    manifest[p.name] = { title: p.title, version: p.version, ...(p.requires ? { requires: p.requires } : {}), file, sha256: sha256(zip), size: zip.length, packJson: sha256(pjBytes), entries: Object.fromEntries(entries.map((e) => [e.path, { kind: e.kind, sha256: e.sha256, size: e.size }])) };
    files.push(`packs/${file}`);
    for (const e of p.entries) if (e.kind === 'js') code.push({ name: `pack:${p.name}/${e.path}`, text: e.bytes.toString('utf8') });
    if (p.entries.some((e) => e.kind === 'model')) models.push({ pack: p.name, spdx: p.spdx ?? [], licence: p.licence });
  }
  return { manifest, files, warnings, code, models };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--fetch')) await fetchAll();
