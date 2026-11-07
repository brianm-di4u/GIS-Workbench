// Worker and Rust errors keep their message key across threads (REQ-L10N-05, DN-62), and the
// coordinate parser reads decimal commas (REQ-L10N-07). The WASM part runs on the release `core`
// bundle and is skipped when it has not been built.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gwError, msgOf, setLocale, en } from '../../app/src/i18n/index.js';
import { parse } from '../../app/src/i18n/icu.js';
import { Msg, nested, plain, revive, wasmError, keyFor } from '../../app/src/workers/errors.js';
import { workerError } from '../../app/src/workers/pool.js';
import { mrsidRefusal, mrsidRefusalError } from '../../app/src/workers/decode/mrsid-header.js';
import { ecwRefusal } from '../../app/src/workers/decode/ecw-header.js';
import { titlesInToml } from '../../build/i18n.mjs';
import { Core } from '../../app/src/wasm/core.js';

afterEach(() => setLocale('en'));

/** What the worker core posts and the pool rebuilds, through a structured clone. */
const cross = (e) => workerError(structuredClone({ type: 'error', id: 'j1', error: e.message, i18n: plain(e.i18n), code: e.code }));

describe('errors across the worker boundary', () => {
  it('keeps the key, params, code and English text', () => {
    const e = cross(gwError('the ENVI data file is {size} bytes; the header needs {need}', { size: '1200', need: '4800' }, 'E_SIZE'));
    expect(e.message).toBe('the ENVI data file is 1200 bytes; the header needs 4800');
    expect(e.code).toBe('E_SIZE');
    setLocale('de', { keys: ['the ENVI data file is {size} bytes; the header needs {need}'], values: ['die ENVI-Datei hat {size} Bytes; der Header braucht {need}'] });
    expect(msgOf(e)).toBe('die ENVI-Datei hat 1200 Bytes; der Header braucht 4800');
  });

  it('localises a wrapped message and the message inside it', () => {
    const inner = gwError('zone {zone} not in [1,60]', { zone: '61' });
    const e = gwError('JPEG 2000 tile {t}: {msg}', { t: '3', msg: nested(inner) });
    expect(e.message).toBe('JPEG 2000 tile 3: zone 61 not in [1,60]');
    const back = cross(e);
    expect(back.i18n.params.msg).toBeInstanceOf(Msg);
    expect(msgOf(back)).toBe(e.message);
    setLocale('de', { keys: ['JPEG 2000 tile {t}: {msg}', 'zone {zone} not in [1,60]'], values: ['JPEG-2000-Kachel {t}: {msg}', 'Zone {zone} nicht in [1,60]'] });
    expect(msgOf(back)).toBe('JPEG-2000-Kachel 3: Zone 61 nicht in [1,60]');
    setLocale('en-XA');
    expect(msgOf(back)).toMatch(/^⟦.*⟦.*61.*⟧.*⟧$/);
  });

  it('passes errors without a key through as before', () => {
    const e = workerError({ type: 'error', error: 'plain text', code: 4, trapped: true });
    expect(e.message).toBe('plain text');
    expect(e.i18n).toBeUndefined();
    expect(e).toMatchObject({ code: 4, trapped: true, cancelled: false });
    // A static inner message is looked up as it is; text that ICU would read differently stays text.
    expect(nested(new Error('x'))).toBeInstanceOf(Msg);
    expect(String(nested(new Error('x')))).toBe('x');
    expect(nested("HFA dictionary: expected '{' at 5")).toBe("HFA dictionary: expected '{' at 5");
    setLocale('de', { keys: ['JPEG 2000: {msg}', 'the codestream has no SIZ marker'], values: ['JPEG 2000: {msg}', 'dem Codestream fehlt der SIZ-Marker'] });
    expect(msgOf(cross(gwError('JPEG 2000: {msg}', { msg: nested(new Error('the codestream has no SIZ marker')) })))).toBe('JPEG 2000: dem Codestream fehlt der SIZ-Marker');
    expect(revive(null)).toBeNull();
  });

  it('keeps the MrSID and ECW refusals word for word', () => {
    const h = new Uint8Array(41);
    h.set([0x6d, 0x73, 0x69, 0x64, 3]);
    new DataView(h.buffer).setUint32(26, 98304);
    new DataView(h.buffer).setUint32(30, 188416);
    h[36] = 1;
    h[40] = 8;
    expect(mrsidRefusal(h)).toMatch(/^MrSID \(MG3; 98,304 × 188,416 px, 1 band, 8-bit\)\. Its pixels/);
    const e = mrsidRefusalError(h, gwError('MrSID {gen}: the image size is not in the header', { gen: 'MG3' }));
    expect(e.message).toMatch(/^MrSID \(MG3; 98,304 × 188,416 px, 1 band, 8-bit\): MrSID MG3: the image size is not in the header\. Its pixels/);
    expect(cross(e).message).toBe(e.message);
    expect(ecwRefusal('bad box')).toMatch(/^ECW \(Hexagon's proprietary wavelet format\): bad box\. Its pixels have no open decoder/);
    expect(ecwRefusal()).toMatch(/^ECW \(Hexagon's proprietary wavelet format\)\. Its pixels/);
  });
});

describe('sidecar profile titles for the catalogue', () => {
  it('reads every title of a profile', () => {
    const t = titlesInToml('id = "x"\ntitle = "Raster to \\"COG\\""\r\n[[options]]\n  title = \'Tile size\' # a comment\nname = "title"\n');
    expect(t.map((m) => [m.src, m.line])).toEqual([
      ['Raster to "COG"', 2],
      ['Tile size', 4],
    ]);
  });
  it('finds them in sidecar/profiles, all valid ICU', () => {
    const dir = resolve('sidecar', 'profiles');
    const files = readdirSync(dir).filter((f) => f.endsWith('.toml'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const t = titlesInToml(readFileSync(join(dir, f), 'utf8'));
      expect(t.length, f).toBeGreaterThan(0);
      for (const m of t) expect(() => parse(m.src)).not.toThrow();
    }
  });
});

// Every `err!` template in the Rust crates is a valid ICU message whose English, with each
// argument as its own name, is the template without ICU quoting.
describe('Rust error templates', () => {
  const walk = (d, out = []) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) {
        if (!['vendor', 'target'].includes(f.name)) walk(join(d, f.name), out);
      } else if (f.name.endsWith('.rs')) out.push(join(d, f.name));
    }
    return out;
  };
  const tpls = [];
  for (const f of walk(resolve('crates'))) for (const m of readFileSync(f, 'utf8').matchAll(/err!\(\s*[A-Z]+\s*,\s*"((?:[^"\\]|\\.)*)"/g)) tpls.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  it('are many and parse as ICU', () => {
    expect(tpls.length).toBeGreaterThan(100);
    for (const s of tpls) {
      expect(() => parse(s), s).not.toThrow();
      const names = [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const params = Object.fromEntries(names.map((n) => [n, `<${n}>`]));
      expect(en(s, params), s).toBe(s.replace(/''/g, "'").replace(/\{(\w+)\}/g, '<$1>'));
    }
  });
});

const corePath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_core.wasm');
  } catch {
    return null;
  }
})();
const haveCore = !!corePath && existsSync(corePath);

describe.skipIf(!haveCore)('Rust errors through the core bundle', () => {
  const core = haveCore ? new Core(new WebAssembly.Module(readFileSync(corePath))) : null;
  const hasI18n = typeof core?.x.gw_last_error_i18n === 'function';

  it.skipIf(!hasI18n)('exposes the template of an error with values', () => {
    let err;
    try {
      core.parse('12 34 abc');
    } catch (e) {
      err = e;
    }
    expect(err.message).toBe('cannot read "12 34 ABC" as a coordinate');
    expect(keyFor(core, err.message)).toEqual({ src: 'cannot read "{up}" as a coordinate', params: { up: '12 34 ABC' } });
    const w = wasmError(core);
    expect(w.message).toBe(err.message);
    setLocale('de', { keys: ['cannot read "{up}" as a coordinate'], values: ['„{up}“ ist keine Koordinate'] });
    expect(msgOf(cross(w))).toBe('„12 34 ABC“ ist keine Koordinate');
    // A static message has no template, and does not keep the one before it.
    expect(() => core.parse('')).toThrow('empty coordinate');
    expect(keyFor(core, 'empty coordinate')).toBeNull();
    expect(wasmError(core).i18n).toBeUndefined();
  });

  it.skipIf(!hasI18n)('reads decimal commas', () => {
    const p = core.parse('48,137; 11,575');
    expect(p.lat).toBeCloseTo(48.137, 9);
    expect(p.lon).toBeCloseTo(11.575, 9);
    expect(core.parse('48,137 11,575').lat).toBeCloseTo(48.137, 9);
    expect(core.parse('48,11')).toMatchObject({ lat: 48, lon: 11 });
  });
});
