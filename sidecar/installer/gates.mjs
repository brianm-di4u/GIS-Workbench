// OD-2.18 at the packaging step: the CSM plug-in host stays out of every shipped build until the
// sidecar is signed and has passed its external security review. package.mjs and package-linux.mjs
// call this on each stage. It looks at what would ship, not at how it was built:
//   - no file of the host, the CSM API or a mock plug-in anywhere in the stage;
//   - the service binary does not hold the host's code (the name of the host program appears only
//     in the code the `csm-host` Cargo feature compiles in);
//   - run with the test environment and the test flag, the service refuses the flag as unknown.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const FORBIDDEN_FILE = /^(gwb-csm-host|csmapi|libcsmapi|gwb_mock_csm)/i;
/** Strings only the feature's code holds. */
const FEATURE_MARK = ['gwb-csm-host.exe', 'the plug-in host never runs with the sandbox turned off'];

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Problems with one stage; empty when the plug-in host is off in it. */
export function csmHostProblems(stage, serviceExe, { run = true } = {}) {
  const problems = [];
  for (const f of walk(stage)) {
    if (FORBIDDEN_FILE.test(f.split(/[\\/]/).pop())) problems.push(`OD-2.18: ${f} is part of the CSM plug-in host and must not ship`);
  }
  const bytes = readFileSync(serviceExe);
  for (const m of FEATURE_MARK) {
    if (bytes.includes(m)) problems.push(`OD-2.18: ${serviceExe} holds the CSM plug-in host (built with the csm-host feature)`);
  }
  if (run) {
    const r = spawnSync(serviceExe, ['--test-allow-csm', '--headless', '--port', '1'], { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (!`${r.stderr}${r.stdout}`.includes('unknown flag --test-allow-csm')) problems.push(`OD-2.18: ${serviceExe} did not refuse --test-allow-csm as an unknown flag (exit ${r.status}, ${String(r.stderr).slice(0, 200)})`);
  }
  return problems;
}

// OD-2.30 and OD-2.29 at the packaging step: OpenH264 reaches a user only as Cisco's own binary, and
// no package holds that binary, so no file of the Media module may hold OpenH264's code. A file can
// carry it three ways: under its own name; linked in statically, as the third-party builds of Sidecar
// 0.2 did (found by strings of OpenH264's own source, which FFmpeg's wrapper does not contain:
// `tests/unit/media-gate.test.js` checks them against Cisco's library); or as FFmpeg's wrapper
// linked to any OpenH264. bin/ffmpeg-h264 is the one program allowed the wrapper, because it takes
// the library from Cisco's download at run time: it must name libopenh264.so.8 as a dependency.
// API names such as WelsCreateSVCEncoder are not markers: ffmpeg-h264 imports them.

/** Strings in OpenH264's own code. */
export const OPENH264_CODE = ['CWelsH264SVCEncoder::', 'WelsInitEncoderExt', 'WelsEncoderEncodeExt', 'WelsEnc25IWelsParametersetStrategy', 'WELS CPU features/capacities'];
/** FFmpeg's wrapper (libavcodec/libopenh264enc.c), with or without the library inside. */
export const OPENH264_WRAPPER = 'libopenh264enc';
/** A configure line that must not be in anything shipped. `--enable-libopenh264` is only for ffmpeg-h264. */
const BAD_CONFIG = /--enable-(gpl|nonfree|version3|libx264|libx265|libxvid|libxavs2?|libdavs2|libvidstab|librubberband|frei0r)\b/;

function hasBytes(buf, s) {
  return buf.includes(Buffer.from(s, 'latin1'));
}

/** Problems with one Media module folder; empty when OD-2.30 holds. `needed` reads ELF dependencies. */
export function mediaOpenH264Problems(dir, { needed = null } = {}) {
  const problems = [];
  const files = walk(dir);
  if (!files.some((f) => /^ffmpeg(\.exe)?$/.test(basename(f)))) problems.push(`media: no ffmpeg in ${dir}`);
  for (const f of files) {
    const name = basename(f);
    const h264 = name === 'ffmpeg-h264';
    if (/openh264/i.test(name)) problems.push(`media: ${name}: an OpenH264 file in a package (OD-2.29: only Cisco's download may bring it)`);
    if (!/\.(exe|dll)$|\.so(\.\d+)*$|^ff/.test(name)) continue;
    const b = readFileSync(f);
    const code = OPENH264_CODE.filter((m) => hasBytes(b, m));
    if (code.length) problems.push(`media: ${name} holds OpenH264's own code (${code[0]}), outside Cisco's binary (OD-2.30)`);
    if (!h264 && hasBytes(b, OPENH264_WRAPPER)) problems.push(`media: ${name} is built with --enable-libopenh264 (OD-2.30)`);
    if (!h264 && hasBytes(b, '--enable-libopenh264')) problems.push(`media: ${name} comes from a configure line with --enable-libopenh264 (OD-2.30)`);
    const bad = BAD_CONFIG.exec(b.toString('latin1'));
    if (bad) problems.push(`media: ${name} comes from a configure line with ${bad[0]}`);
    if (h264 && needed && !needed(f).includes('libopenh264.so.8')) problems.push('media: ffmpeg-h264 does not load libopenh264.so.8, so it cannot be using Cisco\'s binary');
  }
  return problems;
}

/**
 * A Linux binary of the module may look for libraries beside itself and nowhere else: conda's linker
 * writes a path of the build machine into what it links, and on a user's machine that is a folder
 * someone else might own. `elfInfo` is elf.mjs's elfNeeded.
 */
export function mediaLibraryPathProblems(dir, elfInfo) {
  const problems = [];
  for (const f of walk(dir)) {
    const name = basename(f);
    if (!/^ff|\.so(\.\d+)*$/.test(name) || /\.(json|txt|md)$/.test(name)) continue;
    const { runpath } = elfInfo(f);
    if (runpath !== null && runpath !== '$ORIGIN/../lib') problems.push(`media: ${name} looks for libraries in ${runpath}`);
  }
  return problems;
}

/** What profiles, spikes and tests take from `ffmpeg` and `ffprobe`; a build must keep all of it. */
export const MEDIA_NEEDS = {
  decoders: ['mpeg1video', 'mpeg2video', 'h264', 'hevc', 'mpeg4', 'aac', 'ac3', 'mp2', 'mp3', 'png', 'mjpeg', 'tiff'],
  encoders: ['mpeg1video', 'aac'],
  demuxers: ['mpegts', 'mpeg', 'mpegvideo', 'mov', 'matroska', 'avi', 'flv', 'asf', 'h264', 'hevc', 'image2', 'png_pipe', 'jpeg_pipe', 'tiff_pipe', 'fits'],
  muxers: ['mpegts', 'data', 'null', 'framemd5', 'rawvideo', 'mp4'],
  filters: ['buffer', 'buffersink', 'abuffer', 'abuffersink', 'format', 'aformat', 'fps', 'scale', 'null', 'anull', 'aresample', 'trim', 'atrim'],
  bsfs: ['h264_mp4toannexb', 'hevc_mp4toannexb', 'aac_adtstoasc'],
  protocols: ['file', 'pipe'],
  windows: { encoders: ['h264_mf'] },
};
/** What a build must not have, whatever the reason. */
export const MEDIA_REFUSED = {
  encoders: ['libopenh264', 'libx264', 'libx264rgb', 'libx265', 'libxvid'],
  protocols: ['http', 'https', 'tcp', 'udp', 'rtmp', 'rtp', 'tls', 'ftp'],
};

/** The names in `ffmpeg -encoders`, `-decoders`, `-muxers`, `-demuxers`, `-filters`, `-bsfs`, `-protocols`. */
export function parseListing(kind, text) {
  const lines = text.split(/\r?\n/);
  if (kind === 'bsfs' || kind === 'protocols') return lines.map((l) => l.trim()).filter((l) => /^[a-z0-9_]+$/.test(l) && !['Input', 'Output'].includes(l));
  const out = [];
  for (const l of lines) {
    const m = kind === 'filters' ? /^\s[A-Z.|]{2,3}\s+([a-z0-9_]+)\s+\S+->\S+/.exec(l) : /^\s+[A-Z.]{1,6}\s+([a-z0-9_,-]+)\s/.exec(l);
    if (m) out.push(...m[1].split(','));
  }
  return out;
}

/** Runs the module's own ffmpeg and checks the lists above. Windows: on the platform the module is for. */
export function mediaNeedsProblems(dir, platform) {
  const exe = join(dir, 'bin', platform === 'windows' ? 'ffmpeg.exe' : 'ffmpeg');
  const probe = join(dir, 'bin', platform === 'windows' ? 'ffprobe.exe' : 'ffprobe');
  const env = { ...process.env, LD_LIBRARY_PATH: join(dir, 'lib') };
  const problems = [];
  for (const t of [exe, probe]) {
    const r = spawnSync(t, ['-hide_banner', '-version'], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (r.status !== 0) problems.push(`media: ${t} does not start (${r.status ?? r.error})`);
  }
  if (problems.length) return problems;
  const want = (kind) => [...(MEDIA_NEEDS[kind] ?? []), ...(platform === 'windows' ? (MEDIA_NEEDS.windows[kind] ?? []) : [])];
  for (const kind of ['decoders', 'encoders', 'demuxers', 'muxers', 'filters', 'bsfs', 'protocols']) {
    const r = spawnSync(exe, ['-hide_banner', `-${kind}`], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 24, windowsHide: true });
    const have = new Set(parseListing(kind, r.stdout));
    for (const n of want(kind)) if (!have.has(n)) problems.push(`media: ffmpeg has lost ${kind.replace(/s$/, '')} ${n}`);
    for (const n of MEDIA_REFUSED[kind] ?? []) if (have.has(n)) problems.push(`media: ffmpeg has ${kind.replace(/s$/, '')} ${n}, which must not ship`);
  }
  return problems;
}

// The Linux floor at the packaging step. A file asking for a newer glibc symbol than the system has
// refuses to load, and one such file makes the .deb's libc6 dependency refuse the whole package, so
// the floor is checked on every ELF file of a stage. Debian 10 and RHEL 8 have 2.28, Ubuntu 22.04
// has 2.35 and Debian 12 has 2.36. The versions come from the files' version tables (elf.mjs
// elfVersions), which is what the loader reads, not from a search of their text.

/** The newest glibc a Linux package may ask for. */
export const GLIBC_FLOOR = '2.28';
/**
 * The C++ runtime of the same systems (GCC 8), for a file in a module that ships no copy of its own.
 * A module's own libstdc++.so.6 answers for that module: the service puts its lib/ first.
 */
export const SYSTEM_RUNTIME = { GLIBCXX: '3.4.25', CXXABI: '1.3.11', GCC: '8.0.0' };

const RUNTIME_FILES = new Set(['libstdc++.so.6', 'libgcc_s.so.1']);
const versionParts = (v) => v.split('.').map(Number);
/** Negative, zero or positive, as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
const newest = (list, fallback = null) => list.reduce((a, v) => (a === null || compareVersions(v, a) > 0 ? v : a), fallback);

function isElf(path) {
  const b = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    return readSync(fd, b, 0, 4, 0) === 4 && b.readUInt32BE(0) === 0x7f454c46;
  } finally {
    closeSync(fd);
  }
}

/**
 * What each ELF file under `dir` asks for: [{ file, glibc, oddGlibc, runtime, defines, error }].
 * `glibc` is the newest numbered version, `oddGlibc` any other GLIBC_ name (GLIBC_PRIVATE, or
 * GLIBC_ABI_DT_RELR from a new linker: neither has a number, and an older system refuses both).
 * `elfInfo` is elf.mjs's elfVersions.
 */
export function elfGlibcNeeds(dir, elfInfo) {
  const out = [];
  for (const path of walk(dir)) {
    if (!isElf(path)) continue;
    const file = relative(dir, path).replaceAll('\\', '/');
    let info;
    try {
      info = elfInfo(path);
    } catch (e) {
      out.push({ file, path, glibc: null, oddGlibc: [], runtime: [], defines: [], error: e.message });
      continue;
    }
    const names = info.needs.flatMap((n) => n.versions);
    const numbered = names.map((n) => /^GLIBC_(\d+(?:\.\d+)+)$/.exec(n)).filter(Boolean).map((m) => m[1]);
    const oddGlibc = [...new Set(names.filter((n) => n.startsWith('GLIBC_') && !/^GLIBC_\d/.test(n)))];
    const runtime = info.needs.filter((n) => RUNTIME_FILES.has(n.file)).flatMap((n) => n.versions.map((version) => ({ lib: n.file, version })));
    out.push({ file, path, glibc: newest(numbered), oddGlibc, runtime, defines: info.defines });
  }
  return out;
}

/** The newest glibc any file of the stage asks for; the .deb's libc6 dependency says this. */
export function stageGlibc(needs) {
  return newest(needs.map((n) => n.glibc).filter(Boolean), null);
}

/** Problems with one Linux stage; empty when every file loads on a system with `floor`. */
export function glibcFloorProblems(needs, floor = GLIBC_FLOOR) {
  if (!needs.length) return ['glibc: no ELF file in the stage, so nothing was checked'];
  const problems = [];
  for (const n of needs) {
    if (n.error) problems.push(`glibc: ${n.file} could not be read: ${n.error}`);
    if (n.glibc && compareVersions(n.glibc, floor) > 0) problems.push(`glibc: ${n.file} needs GLIBC_${n.glibc}, over the floor of ${floor}`);
    for (const o of n.oddGlibc) problems.push(`glibc: ${n.file} needs ${o}, which an older system does not offer`);
  }
  return problems;
}

/** Modules that take their libraries from another one (compose.mjs `dependsOn`). */
const RUNTIME_FROM = { points: 'core-gdal' };
/** The module whose libraries a stage file runs with, or '' for the service and other top-level files. */
const moduleOf = (file) => {
  const id = /^modules\/([^/]+)\//.exec(file)?.[1] ?? '';
  return RUNTIME_FROM[id] ?? id;
};

/**
 * Problems with the C++ runtime of one Linux stage: a file must find every GLIBCXX_, CXXABI_ and
 * GCC_ version it asks for in the libstdc++ and libgcc_s its module ships, or else in the oldest
 * system's (SYSTEM_RUNTIME). A stage that passes only on the build machine's runtime would look
 * fine by its glibc alone and still not start.
 */
export function runtimeProblems(needs, system = SYSTEM_RUNTIME) {
  const shipped = new Map();
  for (const n of needs) {
    const name = n.file.split('/').pop();
    if (RUNTIME_FILES.has(name)) shipped.set(`${moduleOf(n.file)}|${name}`, new Set(n.defines));
  }
  const problems = [];
  for (const n of needs) {
    for (const { lib, version } of n.runtime) {
      const own = shipped.get(`${moduleOf(n.file)}|${lib}`);
      if (own) {
        if (!own.has(version)) problems.push(`runtime: ${n.file} needs ${version}, which its module's ${lib} does not define`);
        continue;
      }
      const m = /^(GLIBCXX|CXXABI|GCC)_(\d+(?:\.\d+)*)$/.exec(version);
      if (m && compareVersions(m[2], system[m[1]]) > 0) problems.push(`runtime: ${n.file} needs ${version}, and its module ships no ${lib} (the oldest system has ${m[1]}_${system[m[1]]})`);
    }
  }
  return problems;
}

/**
 * Library paths of every ELF file in a stage: `$ORIGIN`, or the system's own /usr, where one upstream
 * wheel looks. A path of the build machine is a folder someone else might own on a user's machine.
 * `elfInfo` is elf.mjs's elfNeeded.
 */
export function stagePathProblems(needs, elfInfo) {
  const problems = [];
  for (const n of needs) {
    if (n.error) continue;
    const { runpath } = elfInfo(n.path);
    for (const p of (runpath ?? '').split(':').filter(Boolean)) {
      if (!/^(\$ORIGIN|\$\{ORIGIN\}|\/usr)(\/|$)/.test(p)) problems.push(`path: ${n.file} looks for libraries in ${p}`);
    }
  }
  return problems;
}
