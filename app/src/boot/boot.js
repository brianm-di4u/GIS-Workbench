// Boot loader (REQ-ARC-02, REQ-ARC-04, REQ-RUST-01). Runs first, as its own hashed inline
// script. It reads the build manifest and offers the only way to turn an inline block into
// bytes, text, a running script or a compiled WebAssembly module: decode base64, inflate,
// and check the SHA-256 against the manifest. A block that fails the check is refused.

(() => {
  const t0 = performance.now();
  const el = document.getElementById('build-manifest');
  let manifest;
  try {
    manifest = JSON.parse(el.textContent);
  } catch (e) {
    document.body.textContent = 'GIS Workbench: the build manifest is damaged; this file cannot start.';
    throw e;
  }

  const cache = new Map();

  function b64(text) {
    const s = text.replace(/\s+/g, '');
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  async function inflate(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function sha256(u8) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
    let h = '';
    for (const x of d) h += x.toString(16).padStart(2, '0');
    return h;
  }

  /** Verified bytes of a block. Rejects if the block is missing, unlisted or tampered with. */
  function bytes(name) {
    if (!cache.has(name)) {
      cache.set(
        name,
        (async () => {
          const entry = manifest.blocks[name];
          if (!entry && manifest.omitted?.includes(name)) throw new Error(`this needs the ${{ 'js-three': '3D', 'js-mpegts': 'video', 'wasm-pointcloud': 'LiDAR', 'js-worker-pointcloud': 'LiDAR', 'wasm-sar': 'SAR' }[name] ?? name} module, which GIS Workbench Lite leaves out: open the Standard file`);
          if (!entry) throw new Error(`block "${name}" is not in the build manifest`);
          const node = document.getElementById(`blk-${name}`);
          if (!node) throw new Error(`block "${name}" is missing from the file`);
          let u8;
          try {
            u8 = b64(node.textContent);
            if (entry.gz) u8 = await inflate(u8);
          } catch {
            throw new Error(`block "${name}" is damaged (its base64/gzip data does not decode); refusing to use it`);
          }
          const h = await sha256(u8);
          if (h !== entry.sha256) throw new Error(`block "${name}" failed its SHA-256 check (expected ${entry.sha256.slice(0, 12)}…, got ${h.slice(0, 12)}…); refusing to use it`);
          return u8;
        })(),
      );
      cache.get(name).catch(() => cache.delete(name));
    }
    return cache.get(name);
  }

  async function text(name) {
    return new TextDecoder().decode(await bytes(name));
  }

  /** Compile a verified WASM block once; the Module can be posted to workers. */
  const modules = new Map();
  function wasm(name) {
    if (!modules.has(name)) {
      const entry = manifest.blocks[name];
      if (!entry && manifest.omitted?.includes(name)) return bytes(name);
      if (!entry || entry.kind !== 'wasm') return Promise.reject(new Error(`"${name}" is not a WASM block`));
      modules.set(name, bytes(name).then((u8) => WebAssembly.compile(u8)));
      modules.get(name).catch(() => modules.delete(name));
    }
    return modules.get(name);
  }

  /** Run a verified main-thread JS block as a classic script (Blob URL; allowed by script-src blob:). */
  const scripts = new Map();
  function runScript(name) {
    if (!scripts.has(name)) {
      scripts.set(
        name,
        (async () => {
          const entry = manifest.blocks[name];
          if (!entry || entry.kind !== 'js') throw new Error(`"${name}" is not a script block`);
          const u8 = await bytes(name);
          const url = URL.createObjectURL(new Blob([u8], { type: 'text/javascript' }));
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = res;
            s.onerror = () => rej(new Error(`script block "${name}" failed to run`));
            document.head.appendChild(s);
          });
          URL.revokeObjectURL(url);
          return globalThis.__lib?.[name];
        })(),
      );
    }
    return scripts.get(name);
  }

  globalThis.__gw = Object.freeze({
    manifest,
    build: manifest.build,
    bytes,
    text,
    wasm,
    runScript,
    sha256,
    bootStart: t0,
    /** For tests and Diagnostics: verify every block now. */
    async verifyAll() {
      const out = {};
      for (const name of Object.keys(manifest.blocks)) {
        try {
          await bytes(name);
          out[name] = 'ok';
        } catch (e) {
          out[name] = String(e.message || e);
        }
      }
      return out;
    },
  });
})();
