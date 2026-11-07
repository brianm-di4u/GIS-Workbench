#!/usr/bin/env node
// Build OSSIM, its CNES sensor-model plug-in and gwb-ossim-model for the sidecar's `ossim` module
// (REQ-GAP-21).
//
//   node sidecar/ossim/build.mjs --src <folder with ossim/ and ossim-plugins/> --env <deps prefix>
//                                --out <install prefix> [--work <build folder>]
//
// Sources: OSSIM v2.12.1 and ossim-plugins OrchidIsland-2.11.1 (the last tag there), unpacked under
// the names OSSIM's CMake expects. Deps come from a conda-forge prefix: libtiff, geotiff,
// libjpeg-turbo, geos, zlib. Curl, PROJ, SQLite, FreeType and HDF5 are off: this tool reads files.
// Everything is linked dynamically: the OSSIM sources say LGPL in their headers (see
// docs/validation/2.6/csmhost.md), and GEOS is LGPL-2.1.
//
// Linux: with no --env it makes its own prefix, compilers on sysroot_linux-64=2.17 as build-ffmpeg.sh,
// solved as for a glibc 2.17 machine, with the library versions Sidecar 0.3.0 was tested on. A prefix
// on any other sysroot is refused, and so is a result over the packaging floor (gates.mjs).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { msvcEnv, run } from '../installer/native-build.mjs';
import { elfNeeded, elfVersions } from '../installer/elf.mjs';
import { elfGlibcNeeds, glibcFloorProblems, stageGlibc, stagePathProblems } from '../installer/gates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const win = process.platform === 'win32';
const fwd = (p) => resolve(p).replaceAll('\\', '/');
const SRC = fwd(arg('--src', 'D:/gwb26/data-csmhost/src/x'));
const ENVDIR = fwd(arg('--env', win ? 'D:/gwb-sidecar-deps/ossim-env-26' : `${process.env.HOME}/gwb/deps/ossim-env-g217`));
const OUT = fwd(arg('--out', win ? 'D:/gwb-sidecar-deps/ossim-26' : `${process.env.HOME}/gwb/deps/ossim-g217`));
const WORK = fwd(arg('--work', win ? 'D:/gwb26/data-csmhost/build' : `${process.env.HOME}/gwb/e2e/ossim-build`));
const PREFIX = win ? `${ENVDIR}/Library` : ENVDIR;
const LINUX_ENV = ['gxx_linux-64=16.2', 'sysroot_linux-64=2.17', 'cmake', 'ninja', 'patchelf', 'libtiff=4.7.2', 'geotiff=1.7.4', 'libjpeg-turbo=3.2.1', 'geos=3.15.0', 'zlib=1.3.2', 'libuuid=2.42.4'];

if (!win) {
  const home = process.env.HOME;
  if (!existsSync(`${ENVDIR}/bin/patchelf`)) {
    run(`${home}/gwb/bin/micromamba`, ['create', '-y', '-q', '-p', ENVDIR, '-c', 'conda-forge', '--override-channels', ...LINUX_ENV], { env: { ...process.env, CONDA_OVERRIDE_GLIBC: '2.17', MAMBA_ROOT_PREFIX: `${home}/gwb/mamba` } });
  }
  if (!readdirSync(`${ENVDIR}/conda-meta`).some((f) => f.startsWith('sysroot_linux-64-2.17-'))) throw new Error(`${ENVDIR} is not on sysroot_linux-64 2.17, so its result would need the glibc of the build machine's sysroot`);
}

let env = process.env;
if (win) {
  env = { ...msvcEnv() };
  env.PATH = `${PREFIX}/bin;${env.PATH}`;
} else {
  env = { ...process.env, PATH: `${ENVDIR}/bin:${process.env.PATH}`, CC: `${ENVDIR}/bin/x86_64-conda-linux-gnu-gcc`, CXX: `${ENVDIR}/bin/x86_64-conda-linux-gnu-g++` };
}

// MSVC 19.5 no longer has ios_base::_Openprot or _FPOSOFF. The 64-bit stream classes exist for
// compilers whose streams were 32-bit; the portable branch of the same file is right on this one.
function fix(file, from, to) {
  const f = join(SRC, file.startsWith('cnes/') ? 'ossim-plugins' : 'ossim', file);
  const s = readFileSync(f, 'utf8');
  // Some of these sources have CRLF line ends.
  const eol = (t) => (s.includes('\r\n') ? t.replaceAll('\n', '\r\n') : t);
  if (s.includes(eol(to))) return;
  if (!s.includes(eol(from))) throw new Error(`${file}: the text to fix is not there; is this OSSIM 2.12.1?`);
  writeFileSync(f, s.replace(eol(from), () => eol(to)));
}
if (win) {
  fix('src/base/ossimDate.cpp', '#include <ossim/base/ossimDate.h>', '#include <ossim/base/ossimDate.h>\n#include <ctime>\n#define timezone _timezone // gwb: MSVC');
  fix('include/ossim/base/ossimIoStream.h', '#ifdef _MSC_VER\n\nclass ossimIFStream64', '#if 0 // gwb: the portable branch\n\nclass ossimIFStream64');
  fix('src/base/ossimIoStream.cpp', '#ifdef _MSC_VER\n\n  ossimIFStream64::ossimIFStream64', '#if 0 // gwb: the portable branch\n\n  ossimIFStream64::ossimIFStream64');
}

// Every platform: ossim::getPath refuses a path with more than one node, and a dual- or quad-pol
// RADARSAT-2 product has one fullResolutionImageData per polarisation, so OSSIM could not open
// those at all. The geometry is the same for each: take the first.
fix('cnes/src/ossimRadarSat2ProductDoc.cpp', 'if ( ossim::getPath(path, xdoc, fileName) )', 'std::vector<ossimString> files; // gwb: one per polarisation\n   if ( ossim::getPath(path, xdoc, files) && !files.empty() )');
fix('cnes/src/ossimRadarSat2ProductDoc.cpp', 's = fileName;', 's = files[0];');

const cxx = win ? ['-DCMAKE_CXX_FLAGS=/EHsc /bigobj /utf-8 /D_HAS_STD_BYTE=0 /D_CRT_SECURE_NO_WARNINGS /DNOMINMAX /D_SILENCE_ALL_CXX17_DEPRECATION_WARNINGS /w'] : ['-DCMAKE_CXX_FLAGS=-w'];
const core = `${WORK}/ossim-${win ? 'win' : 'linux'}`;
const off = ['CURL', 'FREETYPE', 'HDF5', 'ID', 'MPI', 'PROJ', 'SQLITE'].map((k) => `-DBUILD_OSSIM_${k}_SUPPORT=OFF`);
mkdirSync(core, { recursive: true });
if (!process.argv.includes('--tool-only')) {
  run('cmake', ['-G', 'Ninja', '-S', `${SRC}/ossim`, '-B', core, '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_PREFIX_PATH=${PREFIX}`, `-DCMAKE_INCLUDE_PATH=${PREFIX}/include`, `-DCMAKE_LIBRARY_PATH=${PREFIX}/lib`, `-DCMAKE_INSTALL_PREFIX=${OUT}`, `-DOSSIM_DEV_HOME=${SRC}`, `-DOSSIM_INSTALL_PREFIX=${OUT}`, ...off, '-DBUILD_OSSIM_APPS=OFF', '-DBUILD_OSSIM_CURL_APPS=OFF', '-DBUILD_OSSIM_TESTS=OFF', '-DBUILD_OSSIM_FRAMEWORKS=OFF', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', ...cxx], { env: { ...env, OSSIM_DEV_HOME: SRC, OSSIM_INSTALL_PREFIX: OUT } });
  run('ninja', ['-C', core, '-j', arg('--jobs', '10'), 'install'], { env });
}
const tool = `${WORK}/gwb-ossim-${win ? 'win' : 'linux'}`;
mkdirSync(tool, { recursive: true });
run('cmake', ['-G', 'Ninja', '-S', here, '-B', tool, '-DCMAKE_BUILD_TYPE=Release', `-DOSSIM_PREFIX=${OUT}`, `-DOSSIM_BUILD=${core}`, `-DOSSIM_PLUGINS_SRC=${SRC}/ossim-plugins`, `-DDEPS_PREFIX=${PREFIX}`, `-DCMAKE_INSTALL_PREFIX=${OUT}`, ...cxx], { env });
run('ninja', ['-C', tool, '-j', arg('--jobs', '10'), 'install'], { env });
if (!existsSync(join(OUT, 'bin'))) throw new Error('no install');
if (!win) {
  // conda's linker writes the build prefix into what it links. In the composed module the libraries
  // sit in lib/, the program in bin/ and the plug-in in lib/plugins.
  const patch = (rpath, file) => run(`${ENVDIR}/bin/patchelf`, ['--set-rpath', rpath, join(OUT, file)], { env });
  patch('$ORIGIN', 'lib64/libossim.so.2.12.1');
  patch('$ORIGIN/../lib', 'bin/gwb-ossim-model');
  patch('$ORIGIN/..', 'lib/plugins/libossim_cnes_plugin.so');
  const needs = elfGlibcNeeds(OUT, elfVersions);
  const bad = [...glibcFloorProblems(needs), ...stagePathProblems(needs, elfNeeded)];
  if (bad.length) throw new Error(`refusing this build: ${bad.join('; ')}`);
  console.log(`needs glibc ${stageGlibc(needs)}`);
}
// compose.mjs reads this prefix as a conda tree; its files are listed in licences.json instead.
mkdirSync(join(OUT, 'conda-meta'), { recursive: true });
console.log(`installed ${OUT}`);
