#!/usr/bin/env bash
# Builds ffmpeg-h264 for the Linux sidecar (REQ-GAP-51): a small LGPL FFmpeg that decodes MPEG-2,
# copies every other stream and encodes H.264 only through a libopenh264.so.8 it finds at run time.
# Cisco's binary is licensed under its AVC patent licence only when it is downloaded separately to
# the user's device (BINARY_LICENSE.txt, conditions 1 and 2), so nothing of it may ship here: the
# sidecar package holds this program, and `gwb-sidecar-setup vendor openh264` fetches the library.
# It is a program of its own because the Media module's FFmpeg (build-ffmpeg.sh) has no OpenH264 at
# all, not even the wrapper: that keeps the rest of the module free of it (OD-2.30).
#
#   sidecar/installer/build-ffmpeg-h264.sh <ffmpeg-8.1.3.tar.xz> <libopenh264-*.so.bz2> <openh264 api dir>
#
# The .so is linked against, not shipped; the api dir holds codec_api.h, codec_app_def.h,
# codec_def.h and codec_ver.h of the same OpenH264 tag (BSD-2-Clause). Output: ~/gwb/deps/ffmpeg-h264-26
# with bin/ffmpeg-h264 and BUILD.txt. Run in WSL under the `wsl` lock. Compilers come from
# conda-forge (an old glibc baseline, as the rest of the Linux trees), in ~/gwb/deps/ffbuild-env-26.
set -euo pipefail
TARBALL=$1
CISCO=$2
API=$3
# The same source as the Media module (FFMPEG_SHA256 in build-ffmpeg.sh).
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
GOT=$(sha256sum "$TARBALL" | cut -d' ' -f1)
if [ "$GOT" != "$FFMPEG_SHA256" ]; then
  echo "refusing $TARBALL: sha256 $GOT is not the pin $FFMPEG_SHA256" >&2
  exit 1
fi
GWB=${GWB:-$HOME/gwb}
ENVDIR=$GWB/deps/ffbuild-env-26
OUT=$GWB/deps/ffmpeg-h264-26
WORK=$GWB/e2e/ffmpeg-h264-26-build
export MAMBA_ROOT_PREFIX=$GWB/mamba
if [ ! -x "$ENVDIR/bin/patchelf" ]; then
  "$GWB/bin/micromamba" create -y -q -p "$ENVDIR" -c conda-forge --override-channels gxx_linux-64 'sysroot_linux-64=2.17' nasm make pkg-config zlib patchelf
fi
rm -rf "$WORK"
mkdir -p "$WORK/stage/lib/pkgconfig" "$WORK/stage/include/wels" "$OUT/bin"
cp "$API"/codec_*.h "$WORK/stage/include/wels/"
bzip2 -dc "$CISCO" > "$WORK/stage/lib/libopenh264.so.8"
ln -s libopenh264.so.8 "$WORK/stage/lib/libopenh264.so"
cat > "$WORK/stage/lib/pkgconfig/openh264.pc" <<EOF
prefix=$WORK/stage
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: OpenH264
Description: link stand-in; the library comes from Cisco at install time
Version: 2.7.0
Libs: -L\${libdir} -lopenh264
Cflags: -I\${includedir}
EOF
tar -xf "$TARBALL" -C "$WORK"
cd "$WORK"/ffmpeg-*
export PATH=$ENVDIR/bin:$PATH
export PKG_CONFIG_PATH=$WORK/stage/lib/pkgconfig
CONFIG=(
  --prefix="$WORK/prefix" --cc=x86_64-conda-linux-gnu-gcc --cxx=x86_64-conda-linux-gnu-g++ --ar=x86_64-conda-linux-gnu-gcc-ar
  --nm=x86_64-conda-linux-gnu-gcc-nm --ranlib=x86_64-conda-linux-gnu-gcc-ranlib --strip=x86_64-conda-linux-gnu-strip
  --pkg-config=pkg-config --pkg-config-flags=--static --extra-ldflags=-Wl,--allow-shlib-undefined
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug
  --disable-ffplay --disable-ffprobe --disable-avdevice --enable-static --disable-shared
  --enable-libopenh264 --enable-encoder=libopenh264
  --enable-decoder=mpeg1video,mpeg2video,aac,ac3,mp2,mp3
  --enable-parser=mpegvideo,mpegaudio,aac,ac3,h264
  --enable-demuxer=mpegts,mpegps,mpegvideo --enable-muxer=mpegts
  --enable-bsf=h264_mp4toannexb,aac_adtstoasc
  --enable-protocol=file,pipe
  --enable-filter=scale,format,fps,null,anull,aformat,aresample
)
./configure "${CONFIG[@]}" > "$WORK/configure.log" 2>&1 || { tail -30 ffbuild/config.log; exit 1; }
if grep -E '^(CONFIG_GPL|CONFIG_NONFREE)=yes' ffbuild/config.mak; then
  echo "refusing a GPL or non-free configuration" >&2
  exit 1
fi
make -j"$(nproc)" ffmpeg > "$WORK/make.log" 2>&1 || { tail -30 "$WORK/make.log"; exit 1; }
x86_64-conda-linux-gnu-strip -o "$OUT/bin/ffmpeg-h264" ffmpeg
# conda's linker writes a path of this machine into the program; the library comes from
# LD_LIBRARY_PATH (the module's lib/), set by the sidecar.
patchelf --remove-rpath "$OUT/bin/ffmpeg-h264"
if readelf -d "$OUT/bin/ffmpeg-h264" | grep -qE 'R(UN)?PATH'; then
  echo "refusing ffmpeg-h264: it still has a library path" >&2
  exit 1
fi
V=$(objdump -T "$OUT/bin/ffmpeg-h264" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' | sort -uV | tail -1)
if [ "$(printf '%s\n2.28\n' "$V" | sort -V | tail -1)" != 2.28 ]; then
  echo "refusing ffmpeg-h264: it needs glibc $V, over the floor of 2.28" >&2
  exit 1
fi
{
  echo "FFmpeg source: $(basename "$TARBALL") sha256 $(sha256sum "$TARBALL" | cut -d' ' -f1)"
  echo "Linked against the Cisco binary (not shipped): $(basename "$CISCO") sha256 $(sha256sum "$CISCO" | cut -d' ' -f1)"
  echo "Compiler: $(x86_64-conda-linux-gnu-gcc --version | head -1)"
  echo "Configure: ${CONFIG[*]}"
} > "$OUT/BUILD.txt"
readelf -d "$OUT/bin/ffmpeg-h264" | grep NEEDED
ls -la "$OUT/bin/ffmpeg-h264"
