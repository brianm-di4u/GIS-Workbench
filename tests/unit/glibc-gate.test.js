// The Linux glibc floor at the packaging step: a stage with a file that asks for more than the floor
// fails, and the .deb's dependency comes from what the files ask for. The test files here are real
// ELF images made byte by byte, so the reader is tested on the tables the loader reads. The real
// binaries that took the floor to 2.38 are checked too when they are on this machine: a gate that
// looks for something that is never there would pass on anything.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GLIBC_FLOOR, compareVersions, elfGlibcNeeds, glibcFloorProblems, runtimeProblems, stageGlibc, stagePathProblems } from '../../sidecar/installer/gates.mjs';
import { elfNeeded, elfVersions } from '../../sidecar/installer/elf.mjs';

const SAMPLES = process.env.GWB_GLIBC_SAMPLES ?? 'E:/gwb26/data-glibc/samples';

/**
 * An ELF64 file with a dynamic section: `needs` is { 'libc.so.6': ['GLIBC_2.17'] }, `defines` a list
 * of version names, `runpath` a string. Everything sits in one PT_LOAD at address 0.
 */
function elf({ needs = {}, defines = [], runpath = null, needed = null } = {}) {
  const strs = [''];
  const strOff = new Map([['', 0]]);
  let strLen = 1;
  const str = (s) => {
    if (!strOff.has(s)) {
      strOff.set(s, strLen);
      strs.push(s);
      strLen += Buffer.byteLength(s) + 1;
    }
    return strOff.get(s);
  };
  const files = Object.keys(needs);
  const verneed = Buffer.alloc(files.reduce((a, f) => a + 16 + needs[f].length * 16, 0));
  let o = 0;
  files.forEach((f, i) => {
    const count = needs[f].length;
    verneed.writeUInt16LE(1, o);
    verneed.writeUInt16LE(count, o + 2);
    verneed.writeUInt32LE(str(f), o + 4);
    verneed.writeUInt32LE(16, o + 8);
    verneed.writeUInt32LE(i === files.length - 1 ? 0 : 16 + count * 16, o + 12);
    needs[f].forEach((v, j) => {
      const a = o + 16 + j * 16;
      verneed.writeUInt32LE(str(v), a + 8);
      verneed.writeUInt32LE(j === count - 1 ? 0 : 16, a + 12);
    });
    o += 16 + count * 16;
  });
  const verdef = Buffer.alloc(defines.length * 28);
  defines.forEach((v, i) => {
    const d = i * 28;
    verdef.writeUInt16LE(1, d);
    verdef.writeUInt16LE(i + 1, d + 4);
    verdef.writeUInt16LE(1, d + 6);
    verdef.writeUInt32LE(20, d + 12);
    verdef.writeUInt32LE(i === defines.length - 1 ? 0 : 28, d + 16);
    verdef.writeUInt32LE(str(v), d + 20);
  });
  const neededList = needed ?? files;
  const neededOffs = neededList.map(str);
  const run = runpath === null ? null : str(runpath);
  const strtab = Buffer.alloc(strLen);
  let w = 1;
  for (const s of strs.slice(1)) {
    strtab.write(s, w, 'latin1');
    w += Buffer.byteLength(s) + 1;
  }
  const dynCount = neededOffs.length + 1 + (run === null ? 0 : 1) + (files.length ? 2 : 0) + (defines.length ? 2 : 0) + 1;
  const head = 64 + 2 * 56;
  const dynOff = head;
  const strOffset = dynOff + dynCount * 16;
  const needOff = strOffset + strtab.length;
  const defOff = needOff + verneed.length;
  const total = defOff + verdef.length;
  const b = Buffer.alloc(total);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2;
  b[5] = 1;
  b[6] = 1;
  b.writeUInt16LE(3, 16);
  b.writeUInt16LE(62, 18);
  b.writeBigUInt64LE(64n, 0x20);
  b.writeUInt16LE(64, 0x34);
  b.writeUInt16LE(56, 0x36);
  b.writeUInt16LE(2, 0x38);
  const ph = (i, type, off, size) => {
    const p = 64 + i * 56;
    b.writeUInt32LE(type, p);
    b.writeBigUInt64LE(BigInt(off), p + 8);
    b.writeBigUInt64LE(BigInt(off), p + 16);
    b.writeBigUInt64LE(BigInt(size), p + 32);
    b.writeBigUInt64LE(BigInt(size), p + 40);
  };
  ph(0, 1, 0, total);
  ph(1, 2, dynOff, dynCount * 16);
  let d = dynOff;
  const dyn = (tag, val) => {
    b.writeBigInt64LE(BigInt(tag), d);
    b.writeBigUInt64LE(BigInt(val), d + 8);
    d += 16;
  };
  for (const n of neededOffs) dyn(1, n);
  dyn(5, strOffset);
  if (run !== null) dyn(29, run);
  if (files.length) {
    dyn(0x6ffffffe, needOff);
    dyn(0x6fffffff, files.length);
  }
  if (defines.length) {
    dyn(0x6ffffffc, defOff);
    dyn(0x6ffffffd, defines.length);
  }
  dyn(0, 0);
  strtab.copy(b, strOffset);
  verneed.copy(b, needOff);
  verdef.copy(b, defOff);
  return b;
}

describe('the version tables of an ELF file', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gwb-glibc-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads what a file asks for and what it offers', () => {
    const f = join(dir, 'x.so');
    writeFileSync(f, elf({ needs: { 'libc.so.6': ['GLIBC_2.2.5', 'GLIBC_2.17'], 'libstdc++.so.6': ['GLIBCXX_3.4.21'] }, defines: ['libx.so.1', 'X_1.0'], runpath: '$ORIGIN' }));
    expect(elfVersions(f)).toEqual({ needs: [{ file: 'libc.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.17'] }, { file: 'libstdc++.so.6', versions: ['GLIBCXX_3.4.21'] }], defines: ['libx.so.1', 'X_1.0'] });
    expect(elfNeeded(f)).toMatchObject({ needed: ['libc.so.6', 'libstdc++.so.6'], runpath: '$ORIGIN' });
  });

  it('gives nothing for a file with no dynamic section', () => {
    const f = join(dir, 'static');
    const b = Buffer.alloc(64);
    b.writeUInt32BE(0x7f454c46, 0);
    b[4] = 2;
    b[5] = 1;
    writeFileSync(f, b);
    expect(elfVersions(f)).toEqual({ needs: [], defines: [] });
  });

  it('compares versions as numbers, not as text', () => {
    expect(compareVersions('2.9', '2.28')).toBeLessThan(0);
    expect(compareVersions('2.2.5', '2.2')).toBeGreaterThan(0);
    expect(compareVersions('2.28', '2.28')).toBe(0);
  });
});

describe('the packaging gate holds the glibc floor', () => {
  let stage;
  const put = (rel, bytes) => {
    mkdirSync(dirname(join(stage, rel)), { recursive: true });
    writeFileSync(join(stage, rel), bytes);
  };
  const needs = () => elfGlibcNeeds(stage, elfVersions);
  beforeEach(() => {
    stage = mkdtempSync(join(tmpdir(), 'gwb-stage-'));
    put('modules/core-gdal/bin/gdalinfo', elf({ needs: { 'libc.so.6': ['GLIBC_2.2.5', 'GLIBC_2.17'] } }));
    put('README.txt', 'GLIBC_2.99 in a text file is nothing to the loader');
  });
  afterEach(() => rmSync(stage, { recursive: true, force: true }));

  it('states the floor the owner decided on', () => {
    expect(GLIBC_FLOOR).toBe('2.28');
  });

  it('passes a stage at or under the floor and reads the real need', () => {
    expect(glibcFloorProblems(needs())).toEqual([]);
    expect(stageGlibc(needs())).toBe('2.17');
    put('modules/sar/lib/x.so', elf({ needs: { 'libm.so.6': ['GLIBC_2.28'] } }));
    expect(glibcFloorProblems(needs())).toEqual([]);
    expect(stageGlibc(needs())).toBe('2.28');
  });

  it('fails on one file over the floor, whatever library it asks', () => {
    put('modules/ossim/lib/libossim.so.2', elf({ needs: { 'libc.so.6': ['GLIBC_2.38'] } }));
    put('modules/model3d/python/x/y.so', elf({ needs: { 'libm.so.6': ['GLIBC_2.29'] } }));
    const p = glibcFloorProblems(needs()).join('\n');
    expect(p).toMatch(/modules\/ossim\/lib\/libossim\.so\.2 needs GLIBC_2\.38, over the floor of 2\.28/);
    expect(p).toMatch(/modules\/model3d\/python\/x\/y\.so needs GLIBC_2\.29/);
    expect(stageGlibc(needs())).toBe('2.38');
  });

  it('finds an ELF file by its first bytes, not by its name', () => {
    put('modules/x/data.bin', elf({ needs: { 'libc.so.6': ['GLIBC_2.34'] } }));
    expect(glibcFloorProblems(needs()).join()).toMatch(/data\.bin needs GLIBC_2\.34/);
  });

  it('ignores a version string in a file that is not ELF, and in an ELF file\'s data', () => {
    put('modules/x/notes.so', 'GLIBC_2.99');
    expect(glibcFloorProblems(needs())).toEqual([]);
    const withText = Buffer.concat([elf({ needs: { 'libc.so.6': ['GLIBC_2.17'] } }), Buffer.from('GLIBC_2.99')]);
    put('modules/x/y.so', withText);
    expect(glibcFloorProblems(needs())).toEqual([]);
    expect(stageGlibc(needs())).toBe('2.17');
  });

  it('fails on a GLIBC_ name with no number: an older system refuses those too', () => {
    put('modules/x/relr.so', elf({ needs: { 'libc.so.6': ['GLIBC_ABI_DT_RELR'] } }));
    put('modules/x/priv.so', elf({ needs: { 'libc.so.6': ['GLIBC_PRIVATE'] } }));
    const p = glibcFloorProblems(needs()).join('\n');
    expect(p).toMatch(/relr\.so needs GLIBC_ABI_DT_RELR/);
    expect(p).toMatch(/priv\.so needs GLIBC_PRIVATE/);
  });

  it('fails on a file it cannot read, and on a stage with no ELF file', () => {
    put('modules/x/bad32.so', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]), Buffer.alloc(80)]));
    expect(glibcFloorProblems(needs()).join()).toMatch(/bad32\.so could not be read/);
    expect(glibcFloorProblems([]).join()).toMatch(/nothing was checked/);
  });

  it('takes a lower floor when asked', () => {
    expect(glibcFloorProblems(needs(), '2.14').join()).toMatch(/needs GLIBC_2\.17, over the floor of 2\.14/);
  });

  it('checks the C++ runtime against the module\'s own copy, then the oldest system\'s', () => {
    put('modules/a/lib/libstdc++.so.6', elf({ defines: ['libstdc++.so.6', 'GLIBCXX_3.4', 'GLIBCXX_3.4.34'] }));
    put('modules/a/bin/ok', elf({ needs: { 'libstdc++.so.6': ['GLIBCXX_3.4.34'] } }));
    expect(runtimeProblems(needs())).toEqual([]);
    put('modules/a/bin/new', elf({ needs: { 'libstdc++.so.6': ['GLIBCXX_3.4.35'] } }));
    expect(runtimeProblems(needs()).join()).toMatch(/bin\/new needs GLIBCXX_3\.4\.35, which its module's libstdc\+\+\.so\.6 does not define/);
    rmSync(join(stage, 'modules/a/bin/new'));
    put('modules/b/x.so', elf({ needs: { 'libstdc++.so.6': ['GLIBCXX_3.4.30'] } }));
    expect(runtimeProblems(needs()).join()).toMatch(/modules\/b\/x\.so needs GLIBCXX_3\.4\.30, and its module ships no libstdc\+\+\.so\.6/);
    put('modules/b/y.so', elf({ needs: { 'libstdc++.so.6': ['GLIBCXX_3.4.25'] } }));
    rmSync(join(stage, 'modules/b/x.so'));
    expect(runtimeProblems(needs())).toEqual([]);
  });

  it('lets a module use the runtime of the module it depends on', () => {
    put('modules/core-gdal/lib/libstdc++.so.6', elf({ defines: ['libstdc++.so.6', 'GLIBCXX_3.4.31'] }));
    put('modules/points/bin/pdal', elf({ needs: { 'libstdc++.so.6': ['GLIBCXX_3.4.31'] } }));
    expect(runtimeProblems(needs())).toEqual([]);
  });

  it('refuses a library path of the build machine and allows $ORIGIN and the system\'s own', () => {
    put('modules/x/a.so', elf({ needs: { 'libc.so.6': ['GLIBC_2.17'] }, runpath: '$ORIGIN/../lib' }));
    put('modules/x/b.so', elf({ needs: { 'libc.so.6': ['GLIBC_2.17'] }, runpath: '/usr/local/lib64' }));
    expect(stagePathProblems(needs(), elfNeeded)).toEqual([]);
    put('modules/x/c.so', elf({ needs: { 'libc.so.6': ['GLIBC_2.17'] }, runpath: '$ORIGIN/..:/home/someone/gwb/deps/lib' }));
    expect(stagePathProblems(needs(), elfNeeded).join()).toMatch(/c\.so looks for libraries in \/home\/someone\/gwb\/deps\/lib/);
  });
});

describe('the real binaries that took the floor to 2.38', () => {
  const have = existsSync(SAMPLES) && readdirSync(SAMPLES).length > 0;

  it.skipIf(!have)('fail the gate, by name', () => {
    const needs = elfGlibcNeeds(SAMPLES, elfVersions);
    const p = glibcFloorProblems(needs).join('\n');
    expect(p).toMatch(/gwb-ossim-model needs GLIBC_2\.38/);
    expect(p).toMatch(/libossim\.so\.2 needs GLIBC_2\.38/);
    expect(p).toMatch(/libossim_cnes_plugin\.so needs GLIBC_2\.38/);
    expect(p).toMatch(/_ifcopenshell_wrapper\.cpython-312-x86_64-linux-gnu\.so needs GLIBC_2\.34/);
    expect(stageGlibc(needs)).toBe('2.38');
  });
});
