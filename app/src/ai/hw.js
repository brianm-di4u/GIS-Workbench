// AI hardware probe (REQ-LAI-01; 2.0 plan P5): what this device can run the local models on.
//   Tier 2: WebGPU with shader-f16, a large buffer limit and ≥ 8 GB of memory (vision-language
//           models, when their packs arrive).
//   Tier 1: WebGPU with shader-f16 (SAM 2.1, OWLv2, CLIP, LightGlue at interactive speed).
//   Tier 0: no usable WebGPU: every model still runs on the CPU (WASM, one thread) but slowly;
//           the commands say so instead of hiding (DN-56).

export async function probeAi(nav = globalThis.navigator) {
  const out = { webgpu: false, f16: false, adapter: '', maxBuffer: 0, memoryGB: nav?.deviceMemory ?? null, cores: nav?.hardwareConcurrency ?? null, tier: 0, reasons: [] };
  if (!nav?.gpu) out.reasons.push('this browser offers no WebGPU');
  else {
    let a = null;
    try {
      a = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch {}
    if (!a) out.reasons.push('WebGPU is present but no graphics adapter was granted');
    else {
      out.webgpu = true;
      out.f16 = a.features.has('shader-f16');
      out.maxBuffer = a.limits?.maxBufferSize ?? 0;
      const i = a.info ?? {};
      out.adapter = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'WebGPU adapter';
      if (!out.f16) out.reasons.push('the adapter has no 16-bit float shaders (shader-f16)');
    }
  }
  if (out.webgpu && out.f16) out.tier = 1;
  if (out.tier === 1 && out.maxBuffer >= 2 ** 31 && (out.memoryGB ?? 0) >= 8) out.tier = 2;
  else if (out.tier === 1) out.reasons.push('vision-language models need a 2 GB buffer limit and 8 GB of memory');
  return out;
}

/** One line for the status bar and the AI device dialog. */
export function tierText(p) {
  if (!p) return 'AI device: not probed';
  if (p.tier === 0) return `AI device: CPU only (${p.reasons[0] ?? 'no WebGPU'}); models run slowly`;
  return `AI device: Tier ${p.tier}, WebGPU on ${p.adapter}${p.f16 ? ' (f16)' : ''}`;
}
