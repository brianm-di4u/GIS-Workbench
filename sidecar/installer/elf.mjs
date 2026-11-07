// ELF64 (little-endian) dynamic-section reader for the Linux module closure (P16): the
// DT_NEEDED sonames of a program or shared library, as pe.mjs gives the imports of a PE file, and
// the symbol versions it asks for and offers, which is what the dynamic loader checks at start.

import { readFileSync } from 'node:fs';

/** The ELF64 LE file's dynamic section as { b, tags, needed, str, toOffset }; null when it has none. */
function dynamicSection(path) {
  const b = readFileSync(path);
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${path}: not an ELF file`);
  if (b[4] !== 2 || b[5] !== 1) throw new Error(`${path}: not a 64-bit little-endian ELF file`);
  const phoff = Number(b.readBigUInt64LE(0x20));
  const phentsize = b.readUInt16LE(0x36);
  const phnum = b.readUInt16LE(0x38);
  const loads = [];
  let dyn = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const type = b.readUInt32LE(o);
    const seg = { offset: Number(b.readBigUInt64LE(o + 8)), vaddr: Number(b.readBigUInt64LE(o + 16)), filesz: Number(b.readBigUInt64LE(o + 32)) };
    if (type === 1) loads.push(seg);
    if (type === 2) dyn = seg;
  }
  if (!dyn) return null; // static
  const toOffset = (va) => {
    const s = loads.find((l) => va >= l.vaddr && va < l.vaddr + l.filesz);
    if (!s) throw new Error(`${path}: address 0x${va.toString(16)} is in no PT_LOAD segment`);
    return va - s.vaddr + s.offset;
  };
  const tags = new Map();
  const needed = [];
  for (let o = dyn.offset; o + 16 <= dyn.offset + dyn.filesz; o += 16) {
    const tag = Number(b.readBigInt64LE(o));
    const val = Number(b.readBigUInt64LE(o + 8));
    if (tag === 0) break;
    if (tag === 1) needed.push(val);
    else tags.set(tag, val);
  }
  const strtab = tags.get(5);
  if (strtab === undefined) throw new Error(`${path}: no DT_STRTAB`);
  const base = toOffset(strtab);
  const str = (i) => {
    const s = base + i;
    let e = s;
    while (e < b.length && b[e] !== 0) e++;
    return b.toString('latin1', s, e);
  };
  return { b, tags, needed, str, toOffset };
}

/** { needed: [soname…], soname, runpath } of an ELF64 LE file; throws if it is not one. */
export function elfNeeded(path) {
  const d = dynamicSection(path);
  if (!d) return { needed: [], soname: null, runpath: null };
  const { tags, needed, str } = d;
  const soname = tags.has(14) ? tags.get(14) : null;
  // DT_RUNPATH wins over DT_RPATH, as it does in the loader.
  const runpath = tags.has(29) ? tags.get(29) : tags.has(15) ? tags.get(15) : null;
  return { needed: needed.map(str), soname: soname === null ? null : str(soname), runpath: runpath === null ? null : str(runpath) };
}

const DT_VERDEF = 0x6ffffffc;
const DT_VERDEFNUM = 0x6ffffffd;
const DT_VERNEED = 0x6ffffffe;
const DT_VERNEEDNUM = 0x6fffffff;

/**
 * The symbol versions of an ELF64 LE file, read from its version tables, not from its text:
 * { needs: [{ file: 'libc.so.6', versions: ['GLIBC_2.17', ...] }, ...], defines: ['GLIBCXX_3.4', ...] }.
 * A library asked for an unknown version refuses to load, and this is the list it is checked against.
 */
export function elfVersions(path) {
  const d = dynamicSection(path);
  if (!d) return { needs: [], defines: [] };
  const { b, tags, str, toOffset } = d;
  const needs = [];
  if (tags.has(DT_VERNEED)) {
    let o = toOffset(tags.get(DT_VERNEED));
    for (let i = 0; i < (tags.get(DT_VERNEEDNUM) ?? 0); i++) {
      const count = b.readUInt16LE(o + 2);
      const versions = [];
      let a = o + b.readUInt32LE(o + 8);
      for (let j = 0; j < count; j++) {
        versions.push(str(b.readUInt32LE(a + 8)));
        const next = b.readUInt32LE(a + 12);
        if (!next) break;
        a += next;
      }
      needs.push({ file: str(b.readUInt32LE(o + 4)), versions });
      const next = b.readUInt32LE(o + 12);
      if (!next) break;
      o += next;
    }
  }
  const defines = [];
  if (tags.has(DT_VERDEF)) {
    let o = toOffset(tags.get(DT_VERDEF));
    for (let i = 0; i < (tags.get(DT_VERDEFNUM) ?? 0); i++) {
      defines.push(str(b.readUInt32LE(o + b.readUInt32LE(o + 12))));
      const next = b.readUInt32LE(o + 16);
      if (!next) break;
      o += next;
    }
  }
  return { needs, defines };
}

// glibc's own libraries (and the kernel's vDSO): every Linux system has them, so they are never
// shipped. libgcc_s and libstdc++ are shipped when the tree has them, else taken from the system.
const GLIBC = new Set(['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'ld-linux-x86-64.so.2', 'libresolv.so.2', 'libutil.so.1', 'libmvec.so.1', 'libanl.so.1', 'libnsl.so.1', 'libBrokenLocale.so.1', 'linux-vdso.so.1']);
const SYSTEM_IF_ABSENT = new Set(['libgcc_s.so.1', 'libstdc++.so.6']);

export function isSystemSo(name, inTree = false) {
  return GLIBC.has(name) || (!inTree && SYSTEM_IF_ABSENT.has(name));
}
