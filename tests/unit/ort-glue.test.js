import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { noEvalGlue } from '../../build/packs.mjs';

// The ai pack ships onnxruntime-web's WebGPU glue with its `new Function` invoker replaced. Packs
// aren't built in CI, so this checks the installed version here: 1.31 renamed every helper the
// replacement calls, and a stale name would only fail when the model runs.
describe('onnxruntime-web WebGPU glue without new Function', () => {
  const text = readFileSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'utf8');
  const out = noEvalGlue(text).toString();

  it('drops the dynamic invoker', () => {
    expect(text).toContain('new Function(Object.keys(k),h)');
    expect(out).not.toContain('new Function(Object.keys(k),h)');
  });

  it('calls the helpers the original handed to its generated code', () => {
    const given = (key) => text.match(new RegExp(`k\\.${key}=([\\w$]+)`))[1];
    const glue = out.slice(out.indexOf('c=((K,F,B,V)=>'));
    expect(glue).toContain(`[${given('getStringOrSymbol')}(methodName)]`);
    expect(glue).toContain(`return ${given('emval_returnValue')}(B,destructorsRef,r)`);
    expect(glue).toContain(`r=${text.match(/var k=\{toValue:([\w$]+)\}/)[1]}(handle)(...v)`);
  });
});
