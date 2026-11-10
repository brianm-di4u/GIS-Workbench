import { describe, expect, it } from 'vitest';
import { upgradeGltf1 } from '../../app/src/render/gltf1.js';

// A binary glTF 1.0 holding only JSON (KHR_binary_glTF header, content format 0).
const glb1 = (j) => {
  const jb = new TextEncoder().encode(JSON.stringify(j));
  const out = new Uint8Array(20 + jb.length);
  const w = new DataView(out.buffer);
  w.setUint32(0, 0x46546c67, true);
  w.setUint32(4, 1, true);
  w.setUint32(8, out.length, true);
  w.setUint32(12, jb.length, true);
  w.setUint32(16, 0, true);
  out.set(jb, 20);
  return out;
};
const json2 = (glb) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
const pbr = (diffuse) => json2(upgradeGltf1(glb1({ textures: { other: {}, tex0: {} }, materials: { m: { values: { diffuse } } } })).glb).materials[0].pbrMetallicRoughness;

describe('REQ-FMT-36 glTF 1.0 materials', () => {
  const base = { metallicFactor: 0, roughnessFactor: 1 };
  it('takes a diffuse texture named alone or in an array (#37), or a colour', () => {
    expect(pbr('tex0')).toEqual({ ...base, baseColorTexture: { index: 1 } });
    expect(pbr(['tex0'])).toEqual({ ...base, baseColorTexture: { index: 1 } });
    expect(pbr([0.5, 0.25, 1])).toEqual({ ...base, baseColorFactor: [0.5, 0.25, 1, 1] });
  });
  it('a texture it cannot find leaves the default colour, not a colour made of names', () => {
    expect(pbr('missing')).toEqual(base);
    expect(pbr(['missing'])).toEqual(base);
  });
});
