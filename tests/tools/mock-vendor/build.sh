#!/usr/bin/env bash
# Test modules for the Linux half of tests/e2e/sidecar/26-codecs.spec.js, in ~/gwb/e2e/codecs-modules:
# the Linux bundle by symlink, ffmpeg-h264 in the Media module, and, through the real
# gwb-sidecar-setup, the mock vendor plug-ins and Cisco's OpenH264 binary from a local copy.
# Run in WSL under the `wsl` lock:
#   tests/tools/mock-vendor/build.sh <folder with BINARY_LICENSE.txt and libopenh264-*.so.bz2> <setup binary>
#
# `--accept` here is a test harness standing in for the end user's answer on a test folder, not an
# acceptance by anyone: ACCEPTED.json is rewritten below to say so. These modules are never shipped.
set -euo pipefail
CISCO=$1
SETUP=$2
GWB=${GWB:-$HOME/gwb}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$GWB/e2e/codecs-modules
WORK=$GWB/e2e/mock-vendor
rm -rf "$OUT" "$WORK"
mkdir -p "$OUT/media/bin" "$WORK/mrsid/lib" "$WORK/ecw/lib"
for m in core-gdal points sar; do ln -s "$GWB/bundle/modules/$m" "$OUT/$m"; done
ln -s "$GWB/bundle/modules/media/lib" "$OUT/media/lib"
for t in ffmpeg ffprobe; do ln -s "$GWB/bundle/modules/media/bin/$t" "$OUT/media/bin/$t"; done
cp "$GWB/deps/ffmpeg-h264-26/bin/ffmpeg-h264" "$OUT/media/bin/ffmpeg-h264"
G=$GWB/deps/conda-gdal
g++ -std=c++17 -shared -fPIC -O1 -I"$G/include" "$HERE/mock_vendor.cpp" -L"$G/lib" -lgdal -o "$WORK/gdal_MrSID.so"
cp "$WORK/gdal_MrSID.so" "$WORK/mrsid/gdal_MrSID.so"
cp "$WORK/gdal_MrSID.so" "$WORK/ecw/gdal_ECW_JP2ECW.so"
echo "Mock plug-in for tests. No vendor code." | tee "$WORK/mrsid/LICENSE.txt" > "$WORK/ecw/LICENSE.txt"
export GWB_SIDECAR_MODULES=$OUT
"$SETUP" --quiet vendor mrsid --from "$WORK/mrsid" --accept
"$SETUP" --quiet vendor ecw --from "$WORK/ecw" --accept
"$SETUP" --quiet vendor openh264 --from "$CISCO" --accept
for m in vendor-mrsid vendor-ecw vendor-openh264; do
  python3 - "$OUT/$m/ACCEPTED.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["by"] = "test harness (tests/tools/mock-vendor/build.sh); not an acceptance by anyone"
json.dump(d, open(p, "w"), indent=2)
PY
done
ls -la "$OUT" "$OUT/vendor-openh264/lib"
