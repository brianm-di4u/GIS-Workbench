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
// ai-match (DISK + LightGlue), and the 2.4 grid packs (REQ-GAP-16): grids-na, grids-eu,
// grids-oceania and geoid-egm2008-25. A pack whose inputs are missing is skipped with a warning.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { embindNoEval } from './d3-decoders.mjs';
import { convertModel } from './onnx-fp16.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.GW_PACKS_CACHE ?? join(root, '.cache', 'packs-src'); // GW_PACKS_CACHE: a clean folder for the downloaded inputs (tests the fetch route)
const SOURCES = JSON.parse(readFileSync(join(root, 'build', 'packs-sources.json'), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const nm = (...p) => join(root, 'node_modules', ...p);
const pkgVersion = (name) => JSON.parse(readFileSync(nm(name, 'package.json'), 'utf8')).version;
// Further folders that hold pinned inputs at the same relative paths (2.4: the large model inputs
// stay on a data drive), separated by ';': GW_PACKS_SRC=D:/gwb24/data-extai
const EXTRA = (process.env.GW_PACKS_SRC ?? '').split(';').filter(Boolean);
const cached = (id) => {
  const s = SOURCES.downloads.find((d) => d.id === id);
  const rel = s.extract?.to ?? s.file;
  const f = [join(CACHE, rel), ...EXTRA.map((d) => join(d, rel))].find((x) => existsSync(x));
  if (!f) return null;
  const b = readFileSync(f);
  const want = s.extract?.sha256 ?? s.sha256;
  if (sha256(b) !== want) throw new Error(`pack input ${f} does not match its pinned SHA-256`);
  return b;
};

async function fetchAll() {
  mkdirSync(CACHE, { recursive: true });
  for (const s of SOURCES.downloads) {
    const f = join(CACHE, s.file);
    mkdirSync(dirname(f), { recursive: true }); // grids/ (REQ-GAP-16)
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

/** A hand-placed pack input (packs-sources.json `local`), checked against its pin; null when absent. */
const local = (file) => {
  const s = SOURCES.local?.files?.find((d) => d.file === file);
  const f = join(CACHE, file);
  if (!s || !existsSync(f)) return null;
  const b = readFileSync(f);
  if (sha256(b) !== s.sha256) throw new Error(`pack input ${f} does not match its pinned SHA-256`);
  return b;
};

/** The fonts pack's font files (entry paths; inputs in .cache/packs-src/fonts). */
export const FONT_FILES = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSansSC-Regular.otf', 'NotoSansTC-Regular.otf', 'NotoSansJP-Regular.otf', 'NotoSansKR-Regular.otf'];

// @pdf-lib/fontkit's npm package carries no licence file; its package.json says MIT. This is the
// MIT licence of fontkit (Devon Govett) and the pdf-lib fork (Andrew Dillon). Its prebuilt ES
// bundle also carries restructure, unicode-properties, unicode-trie, brotli.js, tiny-inflate, dfa,
// clone, deep-equal and base64-arraybuffer, all MIT.
const FONTKIT_MIT = `MIT License

Copyright (c) 2014 Devon Govett; Copyright (c) 2020 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/**
 * fontkit as a classic script that sets globalThis.__lib.fontkit (the pack's fontkit.js). Two
 * patches at bundle time, each required to apply exactly once (the build fails if the text moves):
 * - eval gate (REQ-ARC-04): the bundled function-bind polyfill builds its bound function with
 *   `Function('binder', …)`. It is used only where Function.prototype.bind is missing, which no
 *   supported browser lacks; the branch becomes an error, so the pack carries no dynamic code.
 * - CID-keyed CFF subsets (Noto Sans CJK): subsetFontdict gave each glyph the FD index of the
 *   last *new* font dict and marked its local subrs on that dict, so a glyph whose FD had been
 *   seen before got another FD's Private dict and lost its subrs: wrong or broken outlines in the
 *   PDF. Upstream fontkit 2 keeps a map from the old FD to the new one; this does the same.
 * - CFF subsets: the header's offSize was written from `this.cff.length` (not a CFF field; the
 *   byte came out as 24), and FreeType (MuPDF, poppler, Chromium) refuses a CFF whose offSize is not 1–4,
 *   so CJK text did not show. It is 4, as in upstream fontkit.
 */
export async function fontkitBundle(esbuild) {
  const once = (text, from, to, what) => {
    if (text.split(from).length !== 2) throw new Error(`@pdf-lib/fontkit: ${what} was not found once; update fontkitBundle for this version`);
    return text.replace(from, to);
  };
  const patch = {
    name: 'gw-fontkit',
    setup(b) {
      b.onLoad({ filter: /fontkit[\\/]dist[\\/]fontkit\.es\.js$/ }, (a) => {
        let s = readFileSync(a.path, 'utf8');
        s = once(s, "bound = Function('binder', 'return function (' + boundArgs.join(',') + '){ return binder.apply(this,arguments); }')(binder);", "throw new TypeError('Function.prototype.bind is required');", 'the function-bind polyfill');
        s = once(s, '    var used_fds = {};\n    var used_subrs = [];\n', '    var used_fds = {};\n    var used_subrs = [];\n    var fd_select = {};\n', 'subsetFontdict (declarations)');
        s = once(s, '        used_subrs.push({});\n      }\n\n      used_fds[fd] = true;\n      topDict.FDSelect.fds.push(topDict.FDArray.length - 1);', '        used_subrs.push({});\n        fd_select[fd] = topDict.FDArray.length - 1;\n      }\n\n      used_fds[fd] = true;\n      topDict.FDSelect.fds.push(fd_select[fd]);', 'subsetFontdict (FDSelect)');
        s = once(s, '        used_subrs[used_subrs.length - 1][subr] = true;', '        used_subrs[fd_select[fd]][subr] = true;', 'subsetFontdict (local subrs)');
        s = once(s, '      offSize: this.cff.length,', '      offSize: 4,', 'the CFF header offSize');
        return { contents: s, loader: 'js' };
      });
    },
  };
  const r = await esbuild.build({ stdin: { contents: "import fontkit from '@pdf-lib/fontkit';\n(globalThis.__lib ??= {}).fontkit = fontkit;", resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', write: false, minify: true, legalComments: 'none', platform: 'browser', mainFields: ['module', 'main'], target: 'es2022', plugins: [patch], logLevel: 'error' });
  return r.outputFiles[0].text;
}

const HDF5_NOTICE ='h5wasm (https://github.com/usnistgov/h5wasm) is NIST-developed software. Acknowledgement: National Institute of Standards and Technology. GIS Workbench ships the h5wasm IIFE build unchanged.\n\n';

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
  // ---- 2.1 codec pack (REQ-FMT-35, SDP-2.1 §3.1): Draco and Basis Universal encoders for glTF
  // export. Never inlined in the HTML; the app runs it only when its hashes are in the manifest.
  if (existsSync(nm('draco3d', 'draco_encoder.wasm')) && existsSync(nm('ktx2-encoder', 'dist', 'basis', 'basis_encoder.wasm'))) {
    const glue = embindNoEval(readFileSync(nm('ktx2-encoder', 'dist', 'basis', 'basis_encoder.js'), 'utf8'), 'basis_encoder.js');
    const patch = { name: 'gw-basis-no-eval', setup(b) { b.onLoad({ filter: /basis_encoder\.js$/ }, () => ({ contents: glue, loader: 'js' })); } };
    const entry = [
      `import DracoEncoderModule from ${JSON.stringify(nm('draco3d', 'draco_encoder_nodejs.js'))};`,
      `import BASIS from ${JSON.stringify(nm('ktx2-encoder', 'dist', 'basis', 'basis_encoder.js'))};`,
      `import { encodeWithModule } from ${JSON.stringify(nm('ktx2-encoder', 'dist', 'encodeCore.js'))};`,
      'globalThis.GWCodec3D = { DracoEncoderModule, BASIS, encodeWithModule };',
    ].join('\n');
    const r = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, external: ['node:*', 'module', 'fs', 'path', 'url', 'crypto', 'worker_threads'], format: 'iife', write: false, minify: true, platform: 'browser', target: 'es2022', define: { 'import.meta.url': '"file:///gw-pack/codec-3d.js"' }, plugins: [patch], logLevel: 'error' });
    const licence = [
      `Draco 3D encoder (draco3d ${pkgVersion('draco3d')}): Apache-2.0, Copyright Google LLC — https://github.com/google/draco`,
      '',
      `ktx2-encoder ${pkgVersion('ktx2-encoder')} (MIT):`,
      readFileSync(nm('ktx2-encoder', 'LICENSE'), 'utf8'),
      readFileSync(nm('ktx2-encoder', 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      `ktx-parse ${pkgVersion('ktx-parse')} (MIT):`,
      readFileSync(nm('ktx-parse', 'LICENSE'), 'utf8'),
      'Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0',
    ].join('\n');
    out.push({
      name: 'codec-3d',
      title: '3D codecs: Draco and Basis Universal encoders',
      spdx: ['Apache-2.0', 'MIT'],
      version: `draco${pkgVersion('draco3d')}+basis${pkgVersion('ktx2-encoder')}`,
      description: 'Draco mesh compression (KHR_draco_mesh_compression) and KTX2 / Basis Universal textures (KHR_texture_basisu) for glTF and 3D Tiles export (REQ-FMT-35).',
      licence,
      entries: [
        { path: 'codec-3d.js', kind: 'js', bytes: Buffer.from(r.outputFiles[0].text) },
        { path: 'draco_encoder.wasm', kind: 'wasm', bytes: readFileSync(nm('draco3d', 'draco_encoder.wasm')) },
        { path: 'basis_encoder.wasm', kind: 'wasm', bytes: readFileSync(nm('ktx2-encoder', 'dist', 'basis', 'basis_encoder.wasm')) },
      ],
    });
  }
  // ---- 2.3 fonts pack (SDP-2.3 §4.8, S-56, REQ-L10N-11): Noto Sans (Latin, Greek, Cyrillic) and
  // Noto Sans CJK SC/TC/JP/KR (OFL-1.1, allowed in packs by OD-2.16, never in the HTML), with
  // fontkit (MIT) to lay out and subset them for Unicode text in PDF and GeoPDF exports.
  const fonts = FONT_FILES.map((f) => local(`fonts/${f}`));
  const ofl = ['OFL-noto-sans.txt', 'OFL-noto-cjk.txt'].map((f) => local(`fonts/${f}`));
  if (fonts.every(Boolean) && ofl.every(Boolean) && existsSync(nm('@pdf-lib', 'fontkit', 'package.json'))) {
    const fk = await fontkitBundle(esbuild);
    const licence = [
      'Noto Sans 2.015 (NotoSans-Regular.ttf, NotoSans-Bold.ttf): SIL Open Font License 1.1.',
      ofl[0].toString('utf8'),
      '',
      'Noto Sans CJK 2.004 (NotoSansSC/TC/JP/KR-Regular.otf): SIL Open Font License 1.1.',
      ofl[1].toString('utf8'),
      '',
      `@pdf-lib/fontkit ${pkgVersion('@pdf-lib/fontkit')} (MIT):`,
      FONTKIT_MIT,
      '',
      `pako ${pkgVersion('@pdf-lib/fontkit/node_modules/pako')} (MIT):`,
      readFileSync(nm('@pdf-lib', 'fontkit', 'node_modules', 'pako', 'LICENSE'), 'utf8'),
    ].join('\n');
    out.push({
      name: 'fonts-noto',
      title: 'Noto fonts for PDF export',
      spdx: ['OFL-1.1', 'MIT'],
      version: `noto2.015+cjk2.004+fontkit${pkgVersion('@pdf-lib/fontkit')}`,
      description: 'Noto Sans (Latin, Greek, Cyrillic) and Noto Sans CJK (Simplified and Traditional Chinese, Japanese, Korean), subset into PDF and GeoPDF exports so text in any of these scripts is shown, selectable and searchable (REQ-L10N-11).',
      licence,
      entries: [{ path: 'fontkit.js', kind: 'js', bytes: Buffer.from(fk) }, ...FONT_FILES.map((f, i) => ({ path: f, kind: 'data', bytes: fonts[i] }))],
    });
  }
  // ---- 2.4 grid packs (REQ-GAP-16): PROJ-data grids by region, and EGM2008 at 2.5′. The
  // GeoTIFFs are already DEFLATE-compressed, so they are stored (level 0, see `kind: 'grid'`).
  // grids.json lists each grid's operation, CRSs, EPSG transformation and accuracy.
  const cat = JSON.parse(readFileSync(join(root, 'build', 'grids-catalogue.json'), 'utf8'));
  for (const [name, p] of Object.entries(cat.packs)) {
    const items = p.grids.map((g) => ({ g, s: SOURCES.downloads.find((d) => d.id === `grid-${g}`), bytes: cached(`grid-${g}`) }));
    if (items.some((x) => !x.bytes)) continue;
    const grids = items.map(({ g, s }) => ({ id: g, file: `${g}.tif`, ...cat.grids[g], sha256: s.sha256, size: s.size, licence: s.spdx, source: s.url }));
    const json = Buffer.from(JSON.stringify({ format: 'gw-grids/1', pack: name, grids }, null, 1));
    const licence = [`${p.title}. Grids from PROJ-data (https://cdn.proj.org, https://github.com/OSGeo/PROJ-data), unchanged.`, '', ...items.map(({ g, s }) => `${g}.tif: ${s.licence}`), '', 'Licences: CC-BY-4.0 https://creativecommons.org/licenses/by/4.0/ ; OGL-Canada-2.0 https://open.canada.ca/en/open-government-licence-canada ; BSD-2-Clause https://opensource.org/licenses/BSD-2-Clause ; public domain (US Government works, NOAA/NGA) ; AdV BeTA2007: free redistribution allowed.'].join('\n');
    const spdx = [...new Set(items.map(({ s }) => s.spdx))];
    out.push({ name, title: p.title, version: '2.4.0+projdata', description: p.description, licence, spdx, entries: [{ path: 'grids.json', kind: 'data', bytes: json }, ...items.map(({ g, bytes }) => ({ path: `${g}.tif`, kind: 'data', stored: true, bytes }))] });
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
  // ---- 2.4 packs (REQ-GAP-56/57) ----
  // ai-gpu: float16 versions of the SAM 2.1 encoder and OWLv2 for the WebGPU runtime, made at build
  // time from the pinned int8 inputs by build/onnx-fp16.mjs (weights dequantised exactly, then
  // float16); the int8 graphs fall back to the CPU on WebGPU (S-33).
  {
    const enc = cached('sam2-encoder');
    const encData = cached('sam2-encoder-data');
    const owl = cached('owlv2-model');
    if (enc && encData && owl) {
      const s2 = convertModel(enc, encData);
      const ow = convertModel(owl, null);
      out.push({ name: 'ai-gpu', title: 'Local AI: WebGPU float16 models', version: '2.4-fp16', description: 'Float16 SAM 2.1 hiera-tiny encoder and OWLv2 for the graphics card (WebGPU): the same weights as the ai-sam2 and ai-detect packs, converted so they run on the GPU instead of falling back to the CPU (REQ-GAP-56).', licence: 'SAM 2.1 hiera-tiny: Meta AI, Apache-2.0 (github.com/facebookresearch/sam2); ONNX export onnx-community/sam2.1-hiera-tiny-ONNX. OWLv2: Google, google/owlv2-base-patch16-ensemble, Apache-2.0; ONNX export Xenova/owlv2-base-patch16-ensemble. Converted to float16 by GIS Workbench build/onnx-fp16.mjs from the pinned int8 files.\n\nRuns in the onnxruntime-web runtime of the ai pack (MIT).', spdx: ['Apache-2.0'], requires: 'ai', entries: [{ path: 'sam2/vision_encoder_fp16.onnx', kind: 'model', bytes: s2.bytes }, { path: 'owlv2/model_fp16.onnx', kind: 'model', bytes: ow.bytes }] });
    }
  }
  const MOONDREAM = 'Moondream2 (vikhyatk/moondream2, M. Vikhyat): Apache-2.0. Vision tower SigLIP (Google, Apache-2.0); text model Phi-1.5 (Microsoft, MIT). ONNX export and tokenizer: Xenova/moondream2 (Apache-2.0), revision 2d577a7.';
  pack('ai-vlm', 'Local AI: Moondream2 vision encoder', 'moondream2-2d577a7-fp16', 'The image side of the Moondream2 vision-language model (SigLIP, float16) and its tokenizer, for drafted observations and counts (REQ-LAI-04, REQ-GAP-57). Needs the ai-vlm-text pack too.', MOONDREAM, [
    ['vlm-vision-encoder-fp16', 'moondream2/vision_encoder_fp16.onnx', 'model'],
    ['vlm-preprocessor-config', 'moondream2/preprocessor_config.json', 'data'],
    ['vlm-config', 'moondream2/config.json', 'data'],
    ['vlm-vocab', 'moondream2/vocab.json', 'data'],
    ['vlm-merges', 'moondream2/merges.txt', 'data'],
    ['vlm-added-tokens', 'moondream2/added_tokens.json', 'data'],
    ['vlm-tokenizer-config', 'moondream2/tokenizer_config.json', 'data'],
  ], ['Apache-2.0', 'MIT']);
  pack('ai-vlm-text', 'Local AI: Moondream2 text decoder', 'moondream2-2d577a7-q4f16', 'The language side of Moondream2: token embeddings (float16) and the Phi-1.5 decoder (4-bit weights, float16), for drafted observations and counts (REQ-LAI-04).', MOONDREAM, [
    ['vlm-embed-tokens-fp16', 'moondream2/embed_tokens_fp16.onnx', 'model'],
    ['vlm-decoder-model-merged-q4f16', 'moondream2/decoder_model_merged_q4f16.onnx', 'model'],
    ['vlm-generation-config', 'moondream2/generation_config.json', 'data'],
  ], ['Apache-2.0', 'MIT']);
  pack('ai-landcover', 'Local AI: land cover (OpenEarthMap SparseMask)', 'sparsemask-934c17a', 'Eight-class land-cover segmentation of RGB aerial and satellite imagery at 0.25–0.5 m (bareland, rangeland, developed space, road, tree, water, agriculture land, buildings): a pixel classifier for Run Model (REQ-GAP-57).', 'SparseMask lightweight OpenEarthMap model (C. Broni-Bediako et al.; github.com/cliffbb/OEM-Lightweight, MIT). ONNX: geobase/sparsemask on Hugging Face (MIT), revision 934c17a. Trained on OpenEarthMap (J. Xia et al., WACV 2023; Zenodo 7223446, CC-BY-4.0).', [
    ['landcover-model', 'landcover/model.onnx', 'model'],
    ['landcover-config', 'landcover/config.json', 'data'],
    ['landcover-preprocessor-config', 'landcover/preprocessor_config.json', 'data'],
  ], ['MIT']);
  pack('ai-match', 'Local AI: DISK + LightGlue co-registration', 'disk-lightglue-2.0', 'Learned keypoints (DISK) and matching (LightGlue) for Auto Align (AI) between dates or sensors (REQ-LAI-05).', 'DISK: cvlab-epfl/disk, Apache-2.0. LightGlue and its DISK-trained weights: cvg/LightGlue, Apache-2.0 (the SuperPoint weights, which are not licensed for commercial use, are not used). End-to-end ONNX pipeline: fabio-sim/LightGlue-ONNX v2.0, Apache-2.0.', [['disk-lightglue', 'lightglue/disk_lightglue_pipeline.onnx', 'model']], ['Apache-2.0']);
  return out;
}

/**
 * Build every pack into `outDir`/packs; returns {manifest: {name: {...}}, files, warnings, code}
 * where `code` lists the JS entries for the eval gate.
 */
export async function buildPacks({ outDir, esbuild, toolVersion, extra = [] }) {
  const dir = join(outDir, 'packs');
  mkdirSync(dir, { recursive: true });
  const manifest = {};
  const files = [];
  const code = [];
  const models = []; // REQ-LAI-08: {pack, spdx, licence} of every pack that carries a model
  const warnings = [];
  const defs = [...(await definitions(esbuild)), ...extra];
  for (const want of ['geoid', 'hdf5', 'proj', 'ai', 'ai-sam2', 'ai-detect', 'ai-search', 'ai-match', 'codec-3d', 'fonts-noto', 'grids-na', 'grids-eu', 'grids-oceania', 'geoid-egm2008-25', 'ai-gpu', 'ai-vlm', 'ai-vlm-text', 'ai-landcover']) if (!defs.some((d) => d.name === want)) warnings.push(`pack "${want}" skipped: its inputs are missing (run node build/packs.mjs --fetch)`);
  for (const p of defs) {
    const entries = p.entries.map((e) => ({ path: e.path, kind: e.kind, size: e.bytes.length, sha256: sha256(e.bytes) }));
    const pj = { format: 'gw-pack/1', name: p.name, title: p.title, version: p.version, minTool: toolVersion, description: p.description, licence: p.licence, ...(p.requires ? { requires: p.requires } : {}), created: new Date().toISOString().slice(0, 10), entries };
    const pjBytes = strToU8(JSON.stringify(pj, null, 1));
    const zip = zipSync({ 'pack.json': pjBytes, 'LICENCE.txt': strToU8(p.licence), ...Object.fromEntries(p.entries.map((e) => [e.path, [new Uint8Array(e.bytes), { level: e.kind === 'model' || e.stored ? 0 : 6 }]])) });
    const file = `${p.name}-${p.version}.gwpack`;
    writeFileSync(join(dir, file), zip);
    manifest[p.name] = { title: p.title, version: p.version, ...(p.requires ? { requires: p.requires } : {}), file, sha256: sha256(zip), size: zip.length, packJson: sha256(pjBytes), entries: Object.fromEntries(entries.map((e) => [e.path, { kind: e.kind, sha256: e.sha256, size: e.size }])) };
    files.push(`packs/${file}`);
    for (const e of p.entries) if (e.kind === 'js') code.push({ name: `pack:${p.name}/${e.path}`, text: e.bytes.toString('utf8') });
    if (p.entries.some((e) => e.kind === 'model')) models.push({ pack: p.name, spdx: p.spdx ?? [], licence: p.licence });
  }
  // Older versions of the packs just built (a locale pack carries the app version) would sit beside
  // the new ones and be picked up instead: remove them. A file belongs to the longest pack name it
  // starts with, so "ai-sam2-…" is never taken for an old "ai" pack.
  const names = Object.keys(manifest).sort((a, b) => b.length - a.length);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.gwpack'))) {
    const owner = names.find((n) => f.startsWith(`${n}-`));
    if (owner && f !== manifest[owner].file) rmSync(join(dir, f));
  }
  return { manifest, files, warnings, code, models };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--fetch')) await fetchAll();
