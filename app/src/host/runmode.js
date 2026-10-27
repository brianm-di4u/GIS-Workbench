// Run-mode and capability detection (REQ-HOST-01). The mode is reported in About and
// Diagnostics, but features switch on detected capabilities, never on the mode name.

function inFrame() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function sameOriginParent() {
  try {
    void window.parent.location.href;
    return true;
  } catch {
    return false;
  }
}

function policyAllows(feature) {
  const p = document.permissionsPolicy ?? document.featurePolicy;
  if (!p?.allowsFeature) return null;
  try {
    return p.allowsFeature(feature);
  } catch {
    return null;
  }
}

async function idbWorks() {
  if (!('indexedDB' in globalThis)) return false;
  return new Promise((res) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        res(v);
      }
    };
    try {
      const r = indexedDB.open('gisworkbench-probe', 1);
      r.onsuccess = () => {
        r.result.close();
        finish(true);
      };
      r.onerror = () => finish(false);
      r.onblocked = () => finish(false);
      setTimeout(() => finish(false), 1500);
    } catch {
      finish(false);
    }
  });
}

function lsWorks() {
  try {
    const k = '__gw_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function webgl2() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const info = {
      renderer: String(renderer),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
      software: /swiftshader|llvmpipe|basic render|software/i.test(String(renderer)),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  } catch {
    return null;
  }
}

function wasmWorks() {
  try {
    // (module) — the smallest valid module; compiling it proves 'wasm-unsafe-eval'.
    return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) instanceof WebAssembly.Module;
  } catch {
    return false;
  }
}

async function blobWorkerWorks() {
  try {
    const url = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    const w = new Worker(url);
    const ok = await new Promise((res) => {
      w.onmessage = () => res(true);
      w.onerror = () => res(false);
      setTimeout(() => res(false), 2000);
    });
    w.terminate();
    URL.revokeObjectURL(url);
    return ok;
  } catch {
    return false;
  }
}

export async function detectRunMode() {
  const proto = location.protocol;
  const framed = inFrame();
  const srcdoc = location.href === 'about:srcdoc';
  // Opaque origin = a sandbox without allow-same-origin (srcdoc included); file: pages are
  // also 'null' in Chromium but are not sandboxed.
  const opaque = (self.origin === 'null' || location.origin === 'null') && proto !== 'file:';
  let mode;
  if (srcdoc) mode = 'srcdoc';
  else if (!framed) mode = proto === 'file:' ? 'file' : 'hosted';
  else if (opaque) mode = 'sandboxed-iframe';
  else mode = sameOriginParent() ? 'same-origin-iframe' : 'cross-origin-iframe';

  const crossFrame = framed && !sameOriginParent();
  const [idb, worker] = await Promise.all([idbWorks(), blobWorkerWorks()]);
  const gl = webgl2();
  const caps = {
    // The picker throws in cross-origin frames in Chromium; detected by mode + presence.
    fsaPicker: typeof window.showOpenFilePicker === 'function' && !crossFrame && !opaque,
    fsaSave: typeof window.showSaveFilePicker === 'function' && !crossFrame && !opaque,
    indexedDB: idb,
    localStorage: lsWorks(),
    webgl2: !!gl,
    gl,
    webgpu: 'gpu' in navigator,
    wasm: wasmWorks(),
    blobWorkers: worker,
    decompression: typeof DecompressionStream === 'function',
    offscreenCanvas: typeof OffscreenCanvas === 'function',
    imageDecoder: typeof ImageDecoder === 'function',
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true,
    fullscreen: policyAllows('fullscreen') ?? !!document.fullscreenEnabled,
    displayCapture: (policyAllows('display-capture') ?? true) && !!navigator.mediaDevices?.getDisplayMedia,
    clipboardWrite: policyAllows('clipboard-write') ?? !!navigator.clipboard,
    keyboardLock: !!navigator.keyboard?.lock,
    // Downloads cannot be probed; in an opaque sandbox they depend on allow-downloads.
    downloadsLikely: !opaque,
    webHid: 'hid' in navigator,
    webSerial: 'serial' in navigator,
    secureContext: globalThis.isSecureContext,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 4,
    deviceMemory: navigator.deviceMemory ?? null,
  };
  const problems = [];
  if (!caps.webgl2) problems.push('WebGL2 is not available; image panes cannot render.');
  if (!caps.wasm) problems.push("WebAssembly is blocked (the host page's policy may forbid 'wasm-unsafe-eval').");
  if (!caps.blobWorkers) problems.push('Background workers are blocked; files will not decode.');
  if (!caps.indexedDB) problems.push('Browser storage is unavailable: no crash recovery and no saved whiteboard sessions.');
  if (!caps.decompression) problems.push('DecompressionStream is missing; this browser is below the supported floor.');
  return { mode, framed, srcdoc, opaque, protocol: proto, caps, problems, userAgent: navigator.userAgent };
}
