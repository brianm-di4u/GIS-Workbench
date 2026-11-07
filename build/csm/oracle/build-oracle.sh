#!/usr/bin/env bash
# GIS Workbench: build the native usgscsm oracle (REQ-GAP-24) with g++ (WSL or Linux).
#   build-oracle.sh <usgscsm source dir (with csm, ale, json submodules)> <eigen dir> <out dir>
# Writes <out>/csm_oracle_upstream (ALE Rotation.cpp + usgscsm EigenUtilities.cpp, with Eigen) and
# <out>/csm_oracle_gw (the Eigen-free replacements the wasm module uses). Test-time only: Eigen
# (MPL-2.0) is never in the browser bundle.
set -euo pipefail
SRC=$(realpath "$1"); EIGEN=$(realpath "$2"); OUT=$(realpath -m "$3")
HERE=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT/obj-common" "$OUT/obj-upstream" "$OUT/obj-gw"
USG_VER="2.1.0 ($(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown))"
CSM_VER="3.0.3 ($(git -C "$SRC/csm" rev-parse --short HEAD 2>/dev/null || echo unknown))"
FLAGS=(-std=c++17 -O2 -fno-fast-math -ffp-contract=off -D__EMSCRIPTEN__ -DNDEBUG
  "-DUSGSCSM_VERSION_TEXT=\"$USG_VER\"" "-DCSM_VERSION_TEXT=\"$CSM_VER\""
  -I"$HERE/compat" -I"$SRC/include/usgscsm" -I"$SRC/include" -I"$SRC" -I"$SRC/csm" -I"$SRC/ale/include" -I"$SRC/json/single_include")
COMMON=("$SRC"/src/{UsgsAstroPlugin,UsgsAstroFrameSensorModel,UsgsAstroPushFrameSensorModel,UsgsAstroLsSensorModel,UsgsAstroSarSensorModel,Distortion,Utilities,VariantMap}.cpp
  "$SRC"/ale/src/{InterpUtils,Orientations,States,Util,Vectors}.cpp
  "$SRC"/csm/{BundleGM,CorrelationModel,Ellipsoid,FourParameterCorrelationModel,GeometricModel,Isd,LinearDecayCorrelationModel,ModelIdentifier,Plugin,RasterGM,SettableEllipsoid,Version}.cpp
  "$HERE/src/gw_csm.cpp" "$HERE/oracle/csm_oracle.cpp")
compile() { # dir files...
  local d=$1; shift; local objs=()
  for f in "$@"; do local o="$d/$(basename "${f%.cpp}").o"; objs+=("$o"); g++ "${FLAGS[@]}" -I"$EIGEN" -c "$f" -o "$o" & done
  wait; echo "${objs[@]}"
}
C=$(compile "$OUT/obj-common" "${COMMON[@]}")
U=$(compile "$OUT/obj-upstream" "$SRC/ale/src/Rotation.cpp" "$SRC/src/EigenUtilities.cpp")
G=$(compile "$OUT/obj-gw" "$HERE/src/gw_ale_rotation.cpp" "$HERE/src/gw_eigen_utilities.cpp")
g++ -o "$OUT/csm_oracle_upstream" $C $U
g++ -o "$OUT/csm_oracle_gw" $C $G
echo "built $OUT/csm_oracle_upstream $OUT/csm_oracle_gw"
