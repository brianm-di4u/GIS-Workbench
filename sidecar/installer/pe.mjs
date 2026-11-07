// Minimal PE (Windows .exe/.dll) reader: the DLL names a binary imports, normal and delay-loaded.
// Used by compose.mjs to find the exact DLL closure of the shipped tools (S-43) so the bundle and
// its SBOM hold only what the tools load, and every DLL is traced to its package licence.

import { readFileSync } from 'node:fs';

export function peImports(path) {
  const b = readFileSync(path);
  const u16 = (o) => b.readUInt16LE(o);
  const u32 = (o) => b.readUInt32LE(o);
  if (u16(0) !== 0x5a4d) throw new Error(`${path}: not a PE file`);
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error(`${path}: bad PE signature`);
  const nSec = u16(pe + 6);
  const optSize = u16(pe + 20);
  const opt = pe + 24;
  const magic = u16(opt);
  const ddOff = opt + (magic === 0x20b ? 112 : 96);
  const dir = (i) => ({ rva: u32(ddOff + i * 8), size: u32(ddOff + i * 8 + 4) });
  const secs = [];
  const s0 = opt + optSize;
  for (let i = 0; i < nSec; i++) {
    const o = s0 + i * 40;
    secs.push({ va: u32(o + 12), vsize: u32(o + 8), raw: u32(o + 20), rsize: u32(o + 16) });
  }
  const off = (rva) => {
    for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return rva - s.va + s.raw;
    return -1;
  };
  const cstr = (o) => {
    let e = o;
    while (e < b.length && b[e] !== 0) e++;
    return b.toString('latin1', o, e);
  };
  const out = { imports: [], delay: [] };
  const imp = dir(1);
  if (imp.rva) {
    for (let o = off(imp.rva); o > 0 && o + 20 <= b.length; o += 20) {
      const nameRva = u32(o + 12);
      if (!nameRva && !u32(o)) break;
      const no = off(nameRva);
      if (no > 0) out.imports.push(cstr(no));
    }
  }
  const del = dir(13);
  if (del.rva) {
    for (let o = off(del.rva); o > 0 && o + 32 <= b.length; o += 32) {
      const nameRva = u32(o + 4);
      if (!nameRva) break;
      const no = off(nameRva);
      if (no > 0) out.delay.push(cstr(no));
    }
  }
  return out;
}

/** DLLs that come with Windows (or the Universal CRT): never bundled, never in the SBOM. */
export function isSystemDll(name) {
  const n = name.toLowerCase();
  return /^(api-ms-win-|ext-ms-)/.test(n) || SYSTEM.has(n);
}
const SYSTEM = new Set(
  'kernel32 user32 gdi32 advapi32 shell32 ole32 oleaut32 ws2_32 wsock32 crypt32 bcrypt ncrypt secur32 shlwapi comdlg32 comctl32 winmm version psapi iphlpapi dbghelp rpcrt4 setupapi userenv wldap32 normaliz netapi32 winhttp wininet mpr imm32 dnsapi cfgmgr32 powrprof ntdll ucrtbase opengl32 glu32 dwmapi uxtheme odbc32 odbccp32 msimg32 winspool usp10 avrt mfplat mf mfreadwrite mfuuid strmiids evr d3d9 d3d11 dxgi dxva2 bcryptprimitives propsys ksuser oleacc wtsapi32 dwrite d2d1 windowscodecs shcore mscoree msvcrt webservices xmllite avicap32 msacm32 msvfw32 ole32 d3d12 dxcore'
    .split(' ')
    .map((x) => `${x}.dll`),
);
