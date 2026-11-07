// OD-2.30 at the packaging step: a Media module with OpenH264 in it, outside Cisco's own binary, fails.
// The markers are checked against the real binaries when they are on this machine: a gate that looks
// for something that is never there would pass on anything.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_NEEDS, MEDIA_REFUSED, OPENH264_CODE, OPENH264_WRAPPER, mediaLibraryPathProblems, mediaOpenH264Problems, parseListing } from '../../sidecar/installer/gates.mjs';

const DEPS = process.env.GWB_SIDECAR_DEPS ?? 'D:/gwb-sidecar-deps';
const OLD_WIN = `${DEPS}/ffmpeg/bin`;
const NEW_WIN = `${DEPS}/ffmpeg-26`;
const CISCO = process.env.GWB_CISCO_SO ?? 'D:/gwb26/data-ffmpeg/markers/libopenh264.so.8';

describe('the Media module holds no OpenH264 outside Cisco\'s binary', () => {
  let dir;
  const put = (name, text) => writeFileSync(join(dir, 'bin', name), text);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gwb-media-'));
    mkdirSync(join(dir, 'bin'));
    put('ffmpeg', 'an FFmpeg with nothing of concern, --disable-libopenh264 --disable-gpl');
    put('libavcodec.so.62', 'some codec library');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a clean module', () => {
    expect(mediaOpenH264Problems(dir)).toEqual([]);
  });

  it('fails with no ffmpeg at all, so an uncomposed module cannot pass', () => {
    rmSync(join(dir, 'bin', 'ffmpeg'));
    expect(mediaOpenH264Problems(dir).join()).toMatch(/no ffmpeg/);
  });

  it('fails on a library named for OpenH264, even Cisco\'s', () => {
    put('libopenh264.so.8', 'x');
    expect(mediaOpenH264Problems(dir).join()).toMatch(/libopenh264\.so\.8: an OpenH264 file/);
  });

  it.each(OPENH264_CODE)('fails on OpenH264 linked in statically (%s)', (marker) => {
    put('libavcodec.so.62', `head ${marker} tail`);
    expect(mediaOpenH264Problems(dir).join()).toMatch(/libavcodec\.so\.62 holds OpenH264's own code/);
  });

  it('fails on the wrapper in any program but ffmpeg-h264', () => {
    put('libavcodec.so.62', `x ${OPENH264_WRAPPER} y`);
    expect(mediaOpenH264Problems(dir).join()).toMatch(/built with --enable-libopenh264/);
  });

  it('fails on a configure line that asks for OpenH264, GPL or a non-free part', () => {
    put('libavutil.so.60', '--prefix=/x --enable-libopenh264');
    expect(mediaOpenH264Problems(dir).join()).toMatch(/configure line with --enable-libopenh264/);
    put('libavutil.so.60', '--prefix=/x --enable-gpl --enable-libx264');
    expect(mediaOpenH264Problems(dir).join()).toMatch(/configure line with --enable-gpl/);
    put('libavutil.so.60', '--prefix=/x --enable-nonfree');
    expect(mediaOpenH264Problems(dir).join()).toMatch(/configure line with --enable-nonfree/);
  });

  it('allows ffmpeg-h264 the wrapper only while it loads Cisco\'s library', () => {
    put('ffmpeg-h264', `x ${OPENH264_WRAPPER} --enable-libopenh264 WelsCreateSVCEncoder y`);
    expect(mediaOpenH264Problems(dir, { needed: () => ['libopenh264.so.8', 'libc.so.6'] })).toEqual([]);
    expect(mediaOpenH264Problems(dir, { needed: () => ['libc.so.6'] }).join()).toMatch(/cannot be using Cisco/);
  });

  it('does not let ffmpeg-h264 hide OpenH264 inside itself', () => {
    put('ffmpeg-h264', `x ${OPENH264_WRAPPER} ${OPENH264_CODE[0]} y`);
    expect(mediaOpenH264Problems(dir, { needed: () => ['libopenh264.so.8'] }).join()).toMatch(/ffmpeg-h264 holds OpenH264's own code/);
  });
});

describe('a Linux binary looks for libraries only beside itself', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gwb-media-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'licenses'));
    for (const f of ['bin/ffmpeg', 'bin/libavcodec.so.62', 'licenses/BUILD.txt']) writeFileSync(join(dir, f), 'x');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes no path, and the path beside the program', () => {
    expect(mediaLibraryPathProblems(dir, (f) => ({ runpath: f.endsWith('ffmpeg') ? '$ORIGIN/../lib' : null }))).toEqual([]);
  });

  it('fails a path of the build machine, on a program or a library', () => {
    const p = mediaLibraryPathProblems(dir, () => ({ runpath: '/home/brian/gwb/deps/ffbuild-env/lib' }));
    expect(p).toHaveLength(2);
    expect(p[0]).toMatch(/looks for libraries in \/home\/brian/);
  });

  it('does not read files that are not programs', () => {
    expect(() => mediaLibraryPathProblems(dir, (f) => { if (f.endsWith('.txt')) throw new Error('read a text file'); return { runpath: null }; })).not.toThrow();
  });
});

describe('the markers on the real binaries', () => {
  it.skipIf(!existsSync(CISCO))('are all in Cisco\'s library, so they do identify OpenH264', () => {
    const b = readFileSync(CISCO);
    for (const m of OPENH264_CODE) expect(b.includes(m), m).toBe(true);
    // The API names ffmpeg-h264 imports are not markers.
    for (const m of OPENH264_CODE) expect(/^Wels(Create|Destroy|Get)/.test(m), m).toBe(false);
  });

  it.skipIf(!existsSync(`${OLD_WIN}/avcodec-62.dll`))('fail the third-party build of Sidecar 0.2', () => {
    const p = mediaOpenH264Problems(join(OLD_WIN, '..'));
    expect(p.join()).toMatch(/avcodec-62\.dll holds OpenH264's own code/);
    expect(p.join()).toMatch(/avcodec-62\.dll is built with --enable-libopenh264/);
  }, 60_000);

  it.skipIf(!existsSync(`${NEW_WIN}/bin/avcodec-62.dll`))('pass the build of build-ffmpeg.sh', () => {
    expect(mediaOpenH264Problems(NEW_WIN)).toEqual([]);
  }, 60_000);
});

describe('the listings', () => {
  it('reads each kind of `ffmpeg -<kind>` table', () => {
    expect(parseListing('encoders', ' V....D h264_mf              H264 via MediaFoundation (codec h264)\n A....D aac                  AAC\n ------\n')).toEqual(['h264_mf', 'aac']);
    expect(parseListing('demuxers', ' D  mpegts          MPEG-TS (MPEG-2 Transport Stream)\n D  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\n')).toEqual(['mpegts', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']);
    expect(parseListing('muxers', ' .E. = Muxing supported\n ---\n  E  mpegts          MPEG-TS\n')).toEqual(['mpegts']);
    expect(parseListing('encoders', ' V....D libaom-av1           libaom AV1 (codec av1)\n')).toEqual(['libaom-av1']);
    expect(parseListing('filters', ' T.. fps               V->V       Force constant framerate.\n ... aresample         A->A       Resample audio data.\n')).toEqual(['fps', 'aresample']);
    expect(parseListing('protocols', 'Supported file protocols:\nInput:\n  file\n  pipe\nOutput:\n  file\n')).toEqual(['file', 'pipe', 'file']);
    expect(parseListing('bsfs', 'Bitstream filters:\naac_adtstoasc\nh264_mp4toannexb\n')).toEqual(['aac_adtstoasc', 'h264_mp4toannexb']);
  });

  it('never needs what it refuses', () => {
    for (const k of Object.keys(MEDIA_REFUSED)) for (const n of MEDIA_REFUSED[k]) expect(MEDIA_NEEDS[k]).not.toContain(n);
    expect(MEDIA_NEEDS.windows.encoders).toContain('h264_mf');
    expect(MEDIA_REFUSED.encoders).toContain('libopenh264');
  });
});
