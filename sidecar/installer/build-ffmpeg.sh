#!/usr/bin/env bash
# Builds the FFmpeg of the sidecar's Media module (OD-2.30) from the ffmpeg.org release tarball:
# LGPL only, as shared libraries, with no GPL, no non-free part, no OpenH264 and no x264 inside.
# H.264 reaches a user two ways only: on Windows through the operating system's encoder (h264_mf,
# Media Foundation); on Linux through Cisco's own binary, used by bin/ffmpeg-h264, a separate program
# (build-ffmpeg-h264.sh, OD-2.29).
#
#   sidecar/installer/build-ffmpeg.sh <ffmpeg-8.1.3.tar.xz>
#
# Windows: run in Git Bash; compilers from conda-forge in E:/gwb-sidecar-deps/ffbuild-env-26, output
# in E:/gwb-sidecar-deps/ffmpeg-26. Linux: run in WSL under the `wsl` lock; compilers from conda-forge
# in ~/gwb/deps/ffbuild-env-26, output in ~/gwb/deps/ffmpeg-26. Old glibc baseline, as the other
# Linux trees. Each output holds bin/ (and lib/ on Linux) as compose.mjs expects, and licenses/ with
# the LGPL text and BUILD.txt, which go into the module.
#
# Every native codec, format and filter stays on, because the `probe` profile hands ffprobe any file
# the user drops (REQ-SDC-09). What goes: every external library but zlib, the network protocols
# (no profile may use them, and ffprobe has no protocol list of its own), and capture devices.
# The list a build must keep is `MEDIA_NEEDS` in gates.mjs.
set -euo pipefail

# ffmpeg.org, signed by the FFmpeg release key FCF986EA15E6E293A5644F10B4322F04D67658D8.
FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3

TARBALL=$1
GOT=$(sha256sum "$TARBALL" | cut -d' ' -f1 | tr -d '*')
if [ "$GOT" != "$FFMPEG_SHA256" ]; then
  echo "refusing $TARBALL: sha256 $GOT is not the pin $FFMPEG_SHA256" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux)
    PLATFORM=linux
    DEPS=${GWB_SIDECAR_DEPS:-$HOME/gwb/deps}
    WORK=${GWB_FFMPEG_WORK:-$HOME/gwb/e2e/ffmpeg-26-build}
    ENVDIR=$DEPS/ffbuild-env-26
    export MAMBA_ROOT_PREFIX=$HOME/gwb/mamba
    [ -x "$ENVDIR/bin/nasm" ] || "$HOME/gwb/bin/micromamba" create -y -q -p "$ENVDIR" -c conda-forge --override-channels gxx_linux-64 'sysroot_linux-64=2.17' nasm make pkg-config zlib patchelf
    [ -x "$ENVDIR/bin/patchelf" ] || { echo "$ENVDIR is not from this script" >&2; exit 1; }
    export PATH=$ENVDIR/bin:$PATH
    TRIPLE=x86_64-conda-linux-gnu
    STRIP=$TRIPLE-strip
    ;;
  MINGW*|MSYS*)
    PLATFORM=windows
    DEPS=${GWB_SIDECAR_DEPS:-/e/gwb-sidecar-deps}
    WORK=${GWB_FFMPEG_WORK:-$DEPS/ffmpeg-26-work}
    ENVDIR=$DEPS/ffbuild-env-26
    export PATH=$ENVDIR/Library/bin:$PATH
    # configure writes its test programs here; the default is a path with backslashes, on C:.
    mkdir -p "$WORK/tmp"
    TMPDIR=$(cygpath -m "$WORK/tmp")
    export TMPDIR TEMP=$TMPDIR TMP=$TMPDIR
    TRIPLE=x86_64-w64-mingw32
    STRIP=$TRIPLE-strip
    ;;
  *)
    echo "unknown platform $(uname -s)" >&2
    exit 1
    ;;
esac
OUT=$DEPS/ffmpeg-26

# What the Linux binaries must not take with them: a path of this machine (conda's linker writes one),
# and a newer glibc than the floor of the 0.2 module (conda's default sysroot would give 2.35).
elf_check() {
  local f bad v
  for f in "$@"; do
    bad=$(readelf -d "$f" | grep -E 'R(UN)?PATH' | grep -vF '[$ORIGIN/../lib]' || true)
    if [ -n "$bad" ]; then
      echo "refusing $f: $bad" >&2
      exit 1
    fi
    v=$(objdump -T "$f" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' | sort -uV | tail -1)
    if [ -n "$v" ] && [ "$(printf '%s\n2.28\n' "$v" | sort -V | tail -1)" != 2.28 ]; then
      echo "refusing $f: it needs glibc $v, over the floor of 2.28" >&2
      exit 1
    fi
  done
}

rm -rf "$WORK/src" "$WORK/prefix" "$WORK/zlib"
mkdir -p "$WORK/src" "$WORK/prefix"
tar -xJf "$TARBALL" -C "$WORK/src" --strip-components=1
cd "$WORK/src"
# Windows compilers read E:/ paths, not Git Bash's /e/.
PREFIX=$WORK/prefix
[ "$PLATFORM" = linux ] || PREFIX=$(cygpath -m "$PREFIX")

CONFIG=(
  --prefix="$PREFIX"
  --cc=$TRIPLE-gcc --cxx=$TRIPLE-g++ --ar=$TRIPLE-gcc-ar --nm=$TRIPLE-gcc-nm
  --ranlib=$TRIPLE-gcc-ranlib --strip=$STRIP --pkg-config=pkg-config
  --disable-gpl --disable-nonfree --disable-version3
  --disable-libopenh264 --disable-libx264 --disable-libx265
  --disable-autodetect --disable-network --disable-doc --disable-debug --disable-ffplay
  --disable-static --enable-shared
  --disable-indevs --enable-indev=lavfi --disable-outdevs
  --enable-zlib
)
# zlib alone in its own folder, so nothing else of the compiler environment can be picked up.
mkdir -p "$WORK/zlib/include" "$WORK/zlib/lib"
if [ "$PLATFORM" = windows ]; then
  # zlib from conda-forge is a DLL here, so it ships beside FFmpeg (compose.mjs walks the imports);
  # FFmpeg's own DLLs take no GCC runtime with them.
  cp "$ENVDIR"/Library/include/{zlib.h,zconf.h} "$WORK/zlib/include/"
  cp "$ENVDIR/Library/lib/z.lib" "$WORK/zlib/lib/"
  CONFIG+=(
    # libavcodec/mfenc.c does not compile without d3d11va in 8.1.3.
    --arch=x86_64 --target-os=mingw32 --enable-mediafoundation --enable-d3d11va
    "--extra-cflags=-I$(cygpath -m "$WORK/zlib/include")"
    "--extra-ldflags=-L$(cygpath -m "$WORK/zlib/lib") -static-libgcc"
  )
else
  # glibc has iconv. zlib is static here: conda-forge's libz.a goes inside libavcodec and libavformat.
  cp "$ENVDIR"/include/{zlib.h,zconf.h} "$WORK/zlib/include/"
  cp "$ENVDIR/lib/libz.a" "$WORK/zlib/lib/"
  CONFIG+=(--enable-iconv "--extra-cflags=-I$WORK/zlib/include" "--extra-ldflags=-L$WORK/zlib/lib")
fi

./configure "${CONFIG[@]}" > "$WORK/configure.log" 2>&1 || { tail -30 ffbuild/config.log; exit 1; }

# The configure line above asks for this; these lines check what configure did.
BAD=$(grep -E '^CONFIG_(GPL|NONFREE|VERSION3|LIBOPENH264|LIBX264|LIBX265|LIBXAVS2?|LIBXVID|LIBVIDSTAB|FREI0R|LIBRUBBERBAND|LIBDAVS2)=yes' ffbuild/config.mak || true)
if [ -n "$BAD" ]; then
  echo "refusing this configuration:" >&2
  echo "$BAD" >&2
  exit 1
fi
if [ "$PLATFORM" = windows ] && ! grep -q '^CONFIG_H264_MF_ENCODER=yes' ffbuild/config.mak; then
  echo "configure dropped h264_mf: Windows would lose its H.264 encoder" >&2
  exit 1
fi

RECIPE="no change to the source"
if [ "$PLATFORM" = windows ]; then
  # A Windows command line stops at 32 KB and libavcodec's object list is about 60 KB, so here make
  # writes the two lists to files itself, and makedef reads one of them. These are build recipes: no
  # C or assembly file changes, and the lists hold the same objects. Each sed is checked: a later
  # FFmpeg that words these lines differently must fail here, not at the link.
  sed -i 's|\$(Q)echo \$\$(filter %.o,\$\$^) > \$\$@.objs|$$(file >$$@.objs,$$(filter %.o,$$^))|' ffbuild/library.mak
  sed -i 's|\[ ! -f "\$object" \]|[ ! -f "${object#@}" ]|' compat/windows/makedef
  sed -i -e 's|^SLIB_CREATE_DEF_CMD=|SLIB_CREATE_DEF_CMD=$$(file >$$@.defobjs,$(OBJS))|' \
    -e 's|makedef \$(SUBDIR)lib\$(NAME).ver \$(OBJS) >|makedef $(SUBDIR)lib$(NAME).ver @$$@.defobjs >|' ffbuild/config.mak
  # conda-forge names the tool with its prefix, and `make install` wants the .lib files it makes.
  sed -i "s|^DLLTOOL=.*|DLLTOOL=$TRIPLE-dlltool|" ffbuild/config.mak
  grep -q 'file >$$@.objs' ffbuild/library.mak
  grep -q 'object#@' compat/windows/makedef
  grep -q '@$$@.defobjs' ffbuild/config.mak
  RECIPE="no change to C or assembly; on Windows make writes its object lists itself (ffbuild/library.mak, compat/windows/makedef)"
fi

make -j"${GWB_FFMPEG_JOBS:-12}" > "$WORK/make.log" 2>&1 || { tail -30 "$WORK/make.log"; exit 1; }
make install > "$WORK/install.log" 2>&1 || { tail -30 "$WORK/install.log"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/licenses"
cp -a "$WORK/prefix/bin" "$OUT/bin"
if [ "$PLATFORM" = windows ]; then
  for f in ffmpeg.exe ffprobe.exe; do "$STRIP" "$OUT/bin/$f"; done
  for f in "$OUT"/bin/*.dll; do "$STRIP" "$f"; done
  # The import libraries of `make install` are of no use to the module.
  rm -f "$OUT"/bin/*.lib
  cp "$ENVDIR/Library/bin/zlib.dll" "$ENVDIR/Library/bin/vcruntime140.dll" "$OUT/bin/"
else
  cp -a "$WORK/prefix/lib" "$OUT/lib"
  rm -rf "$OUT/lib/pkgconfig"
  for f in "$OUT"/bin/ff*; do "$STRIP" "$f"; patchelf --set-rpath '$ORIGIN/../lib' "$f"; done
  for f in "$OUT"/lib/lib*.so.*.*.*; do "$STRIP" "$f"; patchelf --remove-rpath "$f"; done
  elf_check "$OUT"/bin/ff* "$OUT"/lib/lib*.so.*.*.*
fi
cp COPYING.LGPLv2.1 LICENSE.md "$OUT/licenses/"
{
  echo "FFmpeg $FFMPEG_VERSION: $(basename "$TARBALL") from https://ffmpeg.org/releases/ sha256 $FFMPEG_SHA256"
  echo "Compiler: $($TRIPLE-gcc --version | head -1)"
  echo "Built by sidecar/installer/build-ffmpeg.sh; $RECIPE."
  echo "Configure: ${CONFIG[*]}"
} > "$OUT/licenses/BUILD.txt"
ls -la "$OUT/bin"
