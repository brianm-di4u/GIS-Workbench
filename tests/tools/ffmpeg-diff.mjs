#!/usr/bin/env node
// Differential test of two FFmpeg builds on real files (OD-2.30): the Media module's new build
// against the one it replaces, with the arguments the sidecar really uses.
//
//   node tests/tools/ffmpeg-diff.mjs --old <prefix> --new <prefix> --out <report.json>
//        [--corpus D:/TE-corpus] [--fixtures fixtures] [--scratch <dir>] [--jobs 4] [--no-encode]
//
// A prefix holds bin/ffmpeg and bin/ffprobe (and lib/ on Linux). For every media file under the
// corpus and the fixtures:
//   probe     the `probe` profile's ffprobe command: JSON equal, or what differs, field by field;
//   frames    framemd5 of the first video stream, the first 600 frames of a file over 32 MB, on one
//             thread: with frame threads a damaged stream decodes differently from run to run in
//             one and the same build, so a difference there says nothing about the builds;
//   klv       SHA-256 and time of every packet of each data stream;
// for files of other kinds, a sample of what a user might drop on the sidecar, the probe alone and
// the answer the service builds from it (`probe_match` in jobs.rs: video codec, format, KLV count);
// for the MPEG-2 clips, the profile's own ffmpeg command, in both builds, then its output checked as
// the e2e specs do: frames, KLV bytes and KLV times against the input, and the two outputs against
// each other. A build that dies on a file (a signal, or a Windows exception code) is a failure
// whatever the other build did. Timings are upper bounds on a shared machine.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const LINUX = process.platform === 'linux';
const OLD = resolve(arg('--old'));
const NEW = resolve(arg('--new'));
const OUT = resolve(arg('--out'));
const CORPUS = arg('--corpus', LINUX ? '/mnt/d/TE-corpus' : 'D:/TE-corpus');
const FIXTURES = arg('--fixtures', 'fixtures');
const SCRATCH = resolve(arg('--scratch', join(OUT, '..', 'ffmpeg-diff-scratch')));
const JOBS = Number(arg('--jobs', '4'));
const ENCODE = !process.argv.includes('--no-encode');
const MEDIA = new Set(['.ts', '.mpg', '.mpeg', '.mp4', '.mts', '.m2ts', '.mov', '.m1v', '.mp4v', '.webm', '.mkv', '.avi']);
const OTHER = new Set(['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.jp2', '.j2k', '.gif', '.bmp', '.webp', '.fits', '.fit', '.ntf', '.nitf', '.img', '.h5', '.nc', '.pdf', '.zip', '.laz', '.las', '.e57', '.shp', '.gpkg', '.json', '.txt', '.csv', '.xml', '.mp3', '.wav', '.aac', '.flac', '.ogg']);
const SAMPLE_OTHER = 40; // of each extension
const SKIP_DIR = /^(node_modules|\.git)$/;

const exe = (prefix, tool) => join(prefix, 'bin', LINUX ? tool : `${tool}.exe`);
const envOf = (prefix) => ({ ...process.env, LD_LIBRARY_PATH: join(prefix, 'lib') });

/** One run; stdout to a buffer or hashed, stderr kept short. Never throws. */
function run(prefix, tool, args, { timeout = 1_800_000, keepOut = true } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(exe(prefix, tool), args, { env: envOf(prefix), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let err = '';
    const hash = createHash('sha256');
    p.stdout.on('data', (d) => {
      hash.update(d);
      if (keepOut) out.push(d);
    });
    p.stderr.on('data', (d) => {
      if (err.length < 4000) err += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => {
      clearTimeout(timer);
      done({ code: -1, signal: null, out: '', err: String(e), sha: '', ms: 0, crashed: true });
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      // Windows reports an access violation or the like as a large exit code.
      const crashed = !!signal || (code !== null && (code >= 0xc0000000 || code < 0));
      done({ code, signal, out: keepOut ? Buffer.concat(out).toString('utf8') : '', err, sha: hash.digest('hex'), ms: Date.now() - t0, crashed });
    });
  });
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile()) out.push(join(dir, e.name));
  }
  return out;
}

/** The probe profile's command, and the fields the service reads from it. */
const PROBE = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
function matchOf(j) {
  const streams = j?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const fmt = j?.format?.format_name ?? '';
  const klv = streams.filter((s) => s.codec_name === 'klv' || s.codec_tag_string === 'KLVA').length;
  const codec = video?.codec_name ?? '';
  if (!video) return { kind: null, klv };
  const mpeg = codec === 'mpeg2video' || codec === 'mpeg1video';
  const still = /image2|tiff|png|jpeg|fits/.test(fmt);
  return { kind: mpeg ? 'video-h264-klv' : still ? null : 'video-unavailable', codec, fmt, klv };
}
function jsonDiff(a, b, path = '', out = []) {
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (a !== b) out.push({ path, old: a, new: b });
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'filename') continue;
    jsonDiff(a[k], b[k], `${path}/${k}`, out);
  }
  return out;
}
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

async function probeOne(file, rel) {
  const [a, b] = [await run(OLD, 'ffprobe', [...PROBE, file]), await run(NEW, 'ffprobe', [...PROBE, file])];
  const [ja, jb] = [parse(a.out), parse(b.out)];
  const fields = ja && jb ? jsonDiff(ja, jb) : ja || jb ? [{ path: '(json)', old: !!ja, new: !!jb }] : [];
  const [ma, mb] = [matchOf(ja), matchOf(jb)];
  return { file: rel, size: statSync(file).size, old: { code: a.code, crashed: a.crashed, ms: a.ms, streams: ja?.streams?.length ?? 0, format: ja?.format?.format_name ?? '' }, new: { code: b.code, crashed: b.crashed, ms: b.ms, streams: jb?.streams?.length ?? 0, format: jb?.format?.format_name ?? '' }, exitSame: a.code === b.code, fields: fields.slice(0, 20), fieldCount: fields.length, matchSame: JSON.stringify(ma) === JSON.stringify(mb), match: mb, matchOld: ma, newErr: b.code ? b.err.slice(0, 300) : '' };
}

async function framesOne(file, big) {
  const limit = big ? ['-frames:v', '600'] : [];
  const args = ['-v', 'error', '-threads', '1', '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn', ...limit, '-f', 'framemd5', '-'];
  const [a, b] = [await run(OLD, 'ffmpeg', args), await run(NEW, 'ffmpeg', args)];
  const lines = (s) => s.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const [la, lb] = [lines(a.out), lines(b.out)];
  let firstDiff = -1;
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      firstDiff = i;
      break;
    }
  }
  return { frames: { old: la.length, new: lb.length }, equal: firstDiff < 0, firstDiff, ms: { old: a.ms, new: b.ms }, code: { old: a.code, new: b.code }, crashed: { old: a.crashed, new: b.crashed }, oldErr: a.err.slice(0, 200), newErr: b.err.slice(0, 200) };
}

async function klvOne(prefix, file) {
  const r = await run(prefix, 'ffprobe', ['-v', 'error', '-select_streams', 'd', '-show_entries', 'packet=stream_index,pts,data_hash', '-show_data_hash', 'SHA256', '-of', 'json', file]);
  return (parse(r.out)?.packets ?? []).map((p) => `${p.stream_index}|${p.pts}|${p.data_hash}`);
}

/** The profile's ffmpeg command for this platform, as in sidecar/profiles. */
function profileArgs(container, input, output) {
  const head = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-progress', 'pipe:1', '-nostats', '-copyts', '-f', container, '-i', input, '-map', '0', '-ignore_unknown', '-c', 'copy'];
  const tail = ['-muxdelay', '0', '-muxpreload', '0', '-metadata', 'comment=ffmpeg-diff', '-f', 'mpegts', '-mpegts_copyts', '1', output];
  const v = LINUX ? ['-c:v', 'mpeg1video', '-b:v', '8000k', '-maxrate', '8000k', '-bufsize', '8000k', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-fpsmax', '60'] : ['-c:v', 'h264_mf', '-b:v', '6000k', '-g', '30', '-pix_fmt', 'nv12', '-fpsmax', '60'];
  return [...head, ...v, ...tail];
}

async function encodeOne(file, rel, fmt) {
  const container = fmt.includes('mpegts') ? 'mpegts' : 'mpeg';
  const id = createHash('sha1').update(rel).digest('hex').slice(0, 10);
  mkdirSync(SCRATCH, { recursive: true });
  const outA = join(SCRATCH, `${id}.old.ts`);
  const outB = join(SCRATCH, `${id}.new.ts`);
  const a = await run(OLD, 'ffmpeg', profileArgs(container, file, outA), { keepOut: false });
  const b = await run(NEW, 'ffmpeg', profileArgs(container, file, outB), { keepOut: false });
  const shaFile = async (p) => {
    const h = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    for await (const c of createReadStream(p)) h.update(c);
    return h.digest('hex');
  };
  const res = { file: rel, container, ok: { old: a.code === 0, new: b.code === 0 }, ms: { old: a.ms, new: b.ms }, newErr: b.code ? b.err.slice(-300) : '' };
  if (b.code === 0) {
    const count = async (prefix, f) => {
      const r = await run(prefix, 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,profile,width,height,nb_read_frames', '-of', 'json', f]);
      return parse(r.out)?.streams?.[0] ?? null;
    };
    const klvIn = await klvOne(NEW, file);
    const klvOut = await klvOne(NEW, outB);
    res.input = await count(NEW, file);
    res.output = await count(NEW, outB);
    res.bytes = { new: statSync(outB).size };
    res.klv = { packets: klvIn.length, out: klvOut.length, equal: klvIn.map((x) => x.split('|').slice(1).join('|')).join() === klvOut.map((x) => x.split('|').slice(1).join('|')).join() };
    if (a.code === 0) {
      res.bytes.old = statSync(outA).size;
      res.identical = (await shaFile(outA)) === (await shaFile(outB));
      res.outputOld = await count(OLD, outA);
      // The other build reads the file too: the output is not tied to the program that wrote it.
      res.readByOldBuild = await count(OLD, outB);
    }
  }
  rmSync(outA, { force: true });
  rmSync(outB, { force: true });
  return res;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
        if (++done % 25 === 0) console.log(`${done}/${items.length}`);
      }
    }),
  );
  return out;
}

async function main() {
  const all = [...(existsSync(CORPUS) ? walk(CORPUS).map((f) => [f, CORPUS]) : []), ...(existsSync(FIXTURES) ? walk(FIXTURES).map((f) => [f, FIXTURES]) : [])];
  const media = all.filter(([f]) => MEDIA.has(extname(f).toLowerCase()));
  const byExt = new Map();
  for (const [f, root] of all) {
    const e = extname(f).toLowerCase();
    if (!OTHER.has(e)) continue;
    if (!byExt.has(e)) byExt.set(e, []);
    byExt.get(e).push([f, root]);
  }
  const others = [...byExt.values()].flatMap((l) => {
    // Every n-th file, so a run is repeatable and spreads across the folders.
    const step = Math.max(1, Math.floor(l.length / SAMPLE_OTHER));
    return l.filter((_, i) => i % step === 0).slice(0, SAMPLE_OTHER);
  });
  console.log(`${media.length} media files, ${others.length} others`);
  const version = async (p) => (await run(p, 'ffmpeg', ['-hide_banner', '-version'])).out.split(/\r?\n/)[0];
  const report = { old: await version(OLD), new: await version(NEW), platform: process.platform, started: new Date().toISOString() };

  const rel = ([f, root]) => relative(root, f).replace(/\\/g, '/');
  report.media = await pool(media, JOBS, async (m) => {
    const r = await probeOne(m[0], rel(m));
    if (r.new.streams && r.match.kind) r.frames = await framesOne(m[0], r.size > 32 << 20);
    const [ka, kb] = [await klvOne(OLD, m[0]), await klvOne(NEW, m[0])];
    r.klv = { old: ka.length, new: kb.length, equal: ka.join() === kb.join() };
    return r;
  });
  report.others = await pool(others, JOBS, (m) => probeOne(m[0], rel(m)));
  writeFileSync(OUT, JSON.stringify(report, null, 1));

  if (ENCODE) {
    const clips = media
      .map((m, i) => ({ m, p: report.media[i] }))
      .filter(({ p }) => p.match.kind === 'video-h264-klv' && p.new.code === 0 && !p.file.startsWith('_mutants') && (p.new.format.includes('mpegts') || p.new.format === 'mpeg'))
      .sort((a, b) => a.p.size - b.p.size);
    console.log(`${clips.length} clips through the profile`);
    // One at a time: the encoder is given the machine, and the two outputs are compared byte by byte.
    report.encode = await pool(clips, 1, ({ m, p }) => encodeOne(m[0], rel(m), p.new.format));
  }

  const crashed = [...report.media, ...report.others].filter((r) => r.new.crashed || r.frames?.crashed?.new);
  report.summary = {
    media: report.media.length,
    others: report.others.length,
    probeEqual: report.media.filter((r) => r.fieldCount === 0).length,
    probeExitSame: report.media.filter((r) => r.exitSame).length,
    matchSame: report.media.filter((r) => r.matchSame).length,
    framesCompared: report.media.filter((r) => r.frames).length,
    framesEqual: report.media.filter((r) => r.frames?.equal).length,
    framesTotal: report.media.reduce((a, r) => a + (r.frames?.frames.new ?? 0), 0),
    klvFiles: report.media.filter((r) => r.klv.new > 0).length,
    klvPackets: report.media.reduce((a, r) => a + r.klv.new, 0),
    klvEqual: report.media.filter((r) => r.klv.equal).length,
    othersFieldEqual: report.others.filter((r) => r.fieldCount === 0).length,
    othersMatchSame: report.others.filter((r) => r.matchSame).length,
    crashedNew: crashed.map((r) => r.file),
    crashedOld: [...report.media, ...report.others].filter((r) => r.old.crashed || r.frames?.crashed?.old).map((r) => r.file),
    encoded: report.encode?.length ?? 0,
    encodedOk: report.encode?.filter((r) => r.ok.new).length ?? 0,
    encodedKlvEqual: report.encode?.filter((r) => r.klv?.equal).length ?? 0,
    encodedFramesEqual: report.encode?.filter((r) => r.input && r.output && r.input.nb_read_frames === r.output.nb_read_frames).length ?? 0,
    encodedIdentical: report.encode?.filter((r) => r.identical).length ?? 0,
  };
  report.finished = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report.summary, null, 1));
  console.log(basename(OUT), 'written');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
