#!/usr/bin/env bash
# Builds the Linux IfcOpenShell of the model3d module (REQ-GAP-36) from the project's own source.
# The wheels on PyPI say manylinux_2_31 and need glibc 2.34; their wrapper also links Open CASCADE at
# load time. conda-forge's build needs only 2.17, but its wrapper links Open CASCADE, RocksDB and
# CGAL's dependencies. This one is built with sysroot_linux-64=2.17, like build-ffmpeg.sh, and has
# no geometry kernel and no RocksDB: mesh_export.py uses the file API only. Everything the module
# takes from it is listed in subset-ifcopenshell.mjs.
#
#   sidecar/installer/build-ifcopenshell.sh <ifcopenshell-python-0.9.0post1.tar.gz> <typing_extensions.py>
#
# Output: ~/gwb/deps/ifc-subset-g217/linux and BUILD.txt beside it. Run in WSL under the `wsl` lock.
# The Python headers come from the sar module's interpreter, so the extension fits it.
set -euo pipefail
TARBALL=$1
TYPING=$2
HERE=$(cd "$(dirname "$0")" && pwd)
# https://github.com/IfcOpenShell/IfcOpenShell/archive/refs/tags/ifcopenshell-python-0.9.0post1.tar.gz
IFC_SHA256=2776eef7ddc0137df317f0294623523dc4ccdaba468c172232cfdda13f4e912a
GOT=$(sha256sum "$TARBALL" | cut -d' ' -f1)
if [ "$GOT" != "$IFC_SHA256" ]; then
  echo "refusing $TARBALL: sha256 $GOT is not the pin $IFC_SHA256" >&2
  exit 1
fi
GWB=${GWB:-$HOME/gwb}
ENVDIR=$GWB/deps/ifc-env-g217
OUT=$GWB/deps/ifc-subset-g217
WORK=${WORK:-$GWB/e2e/ifc-g217-build}
PY=$GWB/deps/python
export MAMBA_ROOT_PREFIX=$GWB/mamba
if [ ! -x "$ENVDIR/bin/patchelf" ]; then
  # Solved as for a glibc 2.17 machine, so that no package asks for more than the sysroot has.
  CONDA_OVERRIDE_GLIBC=2.17 "$GWB/bin/micromamba" create -y -q -p "$ENVDIR" -c conda-forge --override-channels \
    gxx_linux-64=16.2 'sysroot_linux-64=2.17' cmake ninja 'swig>=4.1' libboost-devel eigen patchelf zlib
fi
ls "$ENVDIR"/conda-meta/sysroot_linux-64-2.17-*.json > /dev/null
PYV=$("$PY/bin/python3" -I -c 'import sys; print("%d.%d" % sys.version_info[:2])')
export PATH=$ENVDIR/bin:$PATH
OPTIONS=(
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/install" -DCMAKE_PREFIX_PATH="$ENVDIR"
  -DCMAKE_C_COMPILER=x86_64-conda-linux-gnu-gcc -DCMAKE_CXX_COMPILER=x86_64-conda-linux-gnu-g++
  -DCMAKE_CXX_FLAGS=-w -DCMAKE_INSTALL_RPATH='$ORIGIN' -DCREATE_BUNDLE=ON -DBUILD_SHARED_LIBS=ON
  -DBUILD_IFCPYTHON=ON -DBUILD_IFCGEOM=ON -DBUILD_CONVERT=OFF -DBUILD_GEOMSERVER=OFF -DBUILD_EXAMPLES=OFF
  -DBUILD_DOCUMENTATION=OFF -DCOLLADA_SUPPORT=OFF -DGLTF_SUPPORT=OFF -DUSD_SUPPORT=OFF -DWITH_PROJ=OFF
  -DWITH_OPENCASCADE=OFF -DWITH_CGAL=OFF -DWITH_MANIFOLD=OFF -DWITH_ROCKSDB=OFF -DSCHEMA_VERSIONS=4
  -DPYTHON_EXECUTABLE="$PY/bin/python3" -DPYTHON_INCLUDE_DIR="$PY/include/python$PYV"
  -DPYTHON_MODULE_INSTALL_DIR="$WORK/install/python"
)
# SKIP_BUILD=1 takes the subset again from an earlier build in $WORK.
if [ -z "${SKIP_BUILD:-}" ]; then
  rm -rf "$WORK"
  mkdir -p "$WORK/src"
  tar -xzf "$TARBALL" -C "$WORK/src" --strip-components=1
  # The one edit, to the build recipe, not to code: the wrapper's install list names the Open CASCADE
  # geometry writer whether or not it is built.
  grep -q '^ *geometry_serializer$' "$WORK/src/src/ifcwrap/CMakeLists.txt"
  sed -i '/^ *geometry_serializer$/d' "$WORK/src/src/ifcwrap/CMakeLists.txt"
  cmake -G Ninja -S "$WORK/src/cmake" -B "$WORK/obj" "${OPTIONS[@]}" > "$WORK/cmake.log" 2>&1 || { tail -30 "$WORK/cmake.log"; exit 1; }
  ninja -C "$WORK/obj" -j "${JOBS:-8}" install > "$WORK/ninja.log" 2>&1 || { tail -40 "$WORK/ninja.log"; exit 1; }
fi
rm -rf "$OUT"
mkdir -p "$OUT"
"${NODE:-node}" "$HERE/subset-ifcopenshell.mjs" --wheel-dir "$WORK/install/python" --typing "$TYPING" --out "$OUT/linux" --platform linux-source --boost "$ENVDIR/lib"
# The project's Makefile stamps this at packaging, and the wheel carries 0.9.0.post1.
grep -q '^__version__ = version = "0.0.0"$' "$OUT/linux/ifcopenshell/__init__.py"
sed -i 's/^__version__ = version = "0.0.0"$/__version__ = version = "0.9.0.post1"/' "$OUT/linux/ifcopenshell/__init__.py"
# conda's linker writes the build prefix into what it links; everything needed sits side by side.
for f in "$OUT"/linux/ifcopenshell/*.so*; do
  patchelf --set-rpath '$ORIGIN' "$f"
  if readelf -d "$f" | grep -E 'R(UN)?PATH' | grep -q '/'; then
    echo "refusing $f: it still has a path of this machine" >&2
    exit 1
  fi
done
V=$(objdump -T "$OUT"/linux/ifcopenshell/*.so* | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' | sort -uV | tail -1)
if [ "$(printf '%s\n2.28\n' "$V" | sort -V | tail -1)" != 2.28 ]; then
  echo "refusing this build: it needs glibc $V, over the floor of 2.28" >&2
  exit 1
fi
echo "needs glibc $V"
{
  echo "IfcOpenShell source: $(basename "$TARBALL") sha256 $GOT"
  echo "Compiler: $(x86_64-conda-linux-gnu-g++ --version | head -1)"
  echo "Sysroot: $(basename "$ENVDIR"/conda-meta/sysroot_linux-64-2.17-*.json .json)"
  echo "CMake: ${OPTIONS[*]}"
} > "$OUT/BUILD.txt"
