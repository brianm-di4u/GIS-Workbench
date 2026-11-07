// FX-21 d3 checked by independent tools (SDP-2.1 §7.1 steps 2 and 5):
// - REQ-FMT-35: the Draco / KTX2 GLBs the app's compressor writes pass the Khronos glTF-Validator
//   (npm gltf-validator) with no errors. Its 2.0.0-dev.3.10 build does not know KHR_texture_basisu
//   and warns on every KTX2 image (IMAGE_UNRECOGNIZED_FORMAT); it does the same on Khronos' own
//   KTX-BasisU sample, which the test shows.
// - REQ-FMT-37: every tileset and content file the writers make passes CesiumGS 3d-tiles-validator
//   (installed beside the corpus tools: TE-tools/node-3dtv) with no errors.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import validator from 'gltf-validator';

const FX = resolve('fixtures/fx21/d3');
const TE = resolve('..', 'TE-corpus');
const TV = resolve('..', 'TE-tools', 'node-3dtv', 'node_modules', '3d-tiles-validator', 'build', 'main');
const KHRONOS = join(TE, '3d-gltf-khronos-ktx2', 'ChronographWatch', 'glTF-KTX-BasisU');

async function validate(bytes, dir = null) {
  const r = await validator.validateBytes(bytes, dir ? { externalResourceFunction: (u) => Promise.resolve(new Uint8Array(readFileSync(join(dir, decodeURIComponent(u))))) } : {});
  return { errors: r.issues.numErrors, warnings: r.issues.messages.filter((m) => m.severity === 1).map((m) => m.code) };
}

describe.skipIf(!existsSync(join(FX, 'gltf')))('REQ-FMT-35 glTF-Validator', () => {
  it('Draco, KTX2 and Draco + KTX2 GLBs have no errors', async () => {
    for (const f of ['box.glb', 'box-draco.glb', 'box-ktx2.glb', 'box-draco-ktx2.glb']) {
      const r = await validate(new Uint8Array(readFileSync(join(FX, 'gltf', f))));
      expect(r.errors, f).toBe(0);
      // Only the KTX2 image warnings the validator gives every KHR_texture_basisu file.
      expect(r.warnings.filter((c) => !['IMAGE_UNRECOGNIZED_FORMAT', 'VALUE_NOT_IN_LIST'].includes(c)), f).toEqual([]);
    }
  });
  it.skipIf(!existsSync(KHRONOS))('the validator gives Khronos’ own KTX2 sample the same image warnings', async () => {
    const r = await validate(new Uint8Array(readFileSync(join(KHRONOS, 'ChronographWatch.gltf'))), KHRONOS);
    expect(r.errors).toBe(0);
    expect(r.warnings).toContain('IMAGE_UNRECOGNIZED_FORMAT');
  }, 60000);
});

function tiles3dValidate(args) {
  const r = spawnSync(process.execPath, [TV, ...args], { encoding: 'utf8', timeout: 120000 });
  const m = /"numErrors":\s*(\d+)/.exec(r.stdout ?? '');
  if (!m) throw new Error(`3d-tiles-validator gave no result: ${r.stderr?.slice(0, 400)}`);
  return Number(m[1]);
}

describe.skipIf(!existsSync(TV) || !existsSync(join(FX, 'pnts')))('REQ-FMT-37 3d-tiles-validator', () => {
  it('implicit octree and quadtree tilesets', () => {
    for (const t of ['implicit-octree/tileset.json', 'implicit-quadtree/tileset.json', 'implicit-octree.3tz']) expect(tiles3dValidate(['--tilesetFile', join(FX, t)]), t).toBe(0);
  }, 300000);
  it('pnts (every encoding), i3dm, cmpt and a Draco + KTX2 b3dm', () => {
    const files = ['pnts/float-rgb.pnts', 'pnts/quantized-octnormals-rgba.pnts', 'pnts/rgb565-batch.pnts', 'pnts/constant-rgba.pnts', 'pnts/draco.pnts', 'i3dm/embedded-normals.i3dm', 'i3dm/quantized-oct-scale.i3dm', 'i3dm/external-enu-batch.i3dm', 'cmpt/composite.cmpt', 'cmpt/composite-of-composite.cmpt', 'cmpt/b3dm-only.b3dm', 'gltf/draco-ktx2.b3dm'];
    for (const f of files) expect(tiles3dValidate(['--tileContentFile', join(FX, f)]), f).toBe(0);
  }, 600000);
});
