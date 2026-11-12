#!/bin/bash
# COLMAP for the sidecar's sfm module (REQ-GAP-29). Run in Git Bash on Windows, or in Linux or WSL.
#
#   SFM_DEPS=E:/gwb-sidecar-deps/colmap-26 VCPKG=E:/gwb-sidecar-deps/vcpkg-26 ./build-colmap.sh [deps|configure|build|all]
#
# On Windows, configure and build need the MSVC environment: start Git Bash from a shell that has run
# vcvars64.bat. SFM_DEPS/src holds COLMAP 4.2.1 with colmap-gwb.patch applied. The binary goes to
# build-<triplet>/src/colmap/exe/; copy it with gwb-sfm to SFM_DEPS/stage/bin for compose.mjs.
#
# What differs from COLMAP's own release, and why (docs/validation/2.6/sfm.md has the licence texts):
#   LSD_ENABLED=OFF       src/thirdparty/LSD is AGPL-3.0.
#   CUDA and OpenGL OFF   GPU_ENABLED compiles src/thirdparty/SiftGPU, which is licensed for
#                         "educational, research and non-profit purposes" only, and CUDA would add
#                         NVIDIA's runtime, which REQ-SEC-08 does not admit.
#   CGAL_ENABLED=OFF      CGAL's triangulations are GPL-3.0-or-later.
#   colmap-gwb.patch      Removes CHOLMOD: its Supernodal module is GPL. Eigen's LDLT replaces it.
#   vcpkg.json            Ceres on Eigen's sparse solvers, so no SuiteSparse at all.
#   overlay/openblas      LAPACK from OpenBLAS's C translation, so no Fortran runtime.
#   GUI, ONNX, download   OFF: no Qt, no onnxruntime, no network code in the binary.
set -eu
LINK=()
HERE=$(cd "$(dirname "$0")" && pwd)
DEPS=${SFM_DEPS:?set SFM_DEPS to the folder for this build}
VCPKG=${VCPKG:?set VCPKG to a bootstrapped vcpkg}
STEP=${1:-all}
case "$(uname -s)" in
  MINGW*|MSYS*) TRIPLET=x64-windows-gwb; EXE=$VCPKG/vcpkg.exe; GEN=(-G Ninja)
    export CXXFLAGS="${CXXFLAGS:-} /bigobj" ;; # bundle_adjustment_ceres.cc exceeds the section limit
  *) TRIPLET=x64-linux-gwb; EXE=$VCPKG/vcpkg; GEN=(-G Ninja)
    # Run under the `wsl` lock, with TMPDIR off /tmp, which is small in WSL. Compilers from
    # conda-forge on sysroot_linux-64=2.17, solved as for a glibc 2.17 machine, as the FFmpeg and
    # OSSIM recipes: the Linux package floor is 2.28 (installer/gates.mjs), and conda's default
    # sysroot of 2.39 gave this binary a floor of 2.38. The sysroot changes no compiler hash, so
    # vcpkg's binary cache would hand back packages built on another one: VCPKG_BINARY_SOURCES clears it.
    GWB=${GWB:-$HOME/gwb}
    ENVDIR=$GWB/deps/sfmbuild-env
    if [ ! -x "$ENVDIR/bin/patchelf" ]; then
      CONDA_OVERRIDE_GLIBC=2.17 MAMBA_ROOT_PREFIX=$GWB/mamba "$GWB/bin/micromamba" create -y -q -p "$ENVDIR" -c conda-forge --override-channels 'gxx_linux-64=16.2' 'sysroot_linux-64=2.17' make pkg-config patchelf
    fi
    ls "$ENVDIR"/conda-meta/sysroot_linux-64-2.17-*.json >/dev/null 2>&1 || { echo "$ENVDIR is not on sysroot_linux-64 2.17, so its result would need the glibc of the sysroot" >&2; exit 1; }
    export PATH=$ENVDIR/bin:$PATH CC=$ENVDIR/bin/x86_64-conda-linux-gnu-gcc CXX=$ENVDIR/bin/x86_64-conda-linux-gnu-g++
    export AR=$ENVDIR/bin/x86_64-conda-linux-gnu-ar RANLIB=$ENVDIR/bin/x86_64-conda-linux-gnu-ranlib NM=$ENVDIR/bin/x86_64-conda-linux-gnu-nm LD=$ENVDIR/bin/x86_64-conda-linux-gnu-ld
    export VCPKG_FORCE_SYSTEM_BINARIES=${VCPKG_FORCE_SYSTEM_BINARIES:-1} VCPKG_BINARY_SOURCES=clear
    LINK=("-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc -s" -DCMAKE_SKIP_RPATH=ON) ;;
esac
export VCPKG_DISABLE_METRICS=1 VCPKG_MAX_CONCURRENCY=${SFM_JOBS:-8}
# SFM_WORK: a fast disk for the build trees, which are many small files. Nothing there is kept.
WORK=${SFM_WORK:-$DEPS}
INSTALLED=$WORK/installed
SRC=$DEPS/src
BUILD=$WORK/build-$TRIPLET
export VCPKG_DOWNLOADS=$WORK/dl

if [ "$STEP" = deps ] || [ "$STEP" = all ]; then
  mkdir -p "$VCPKG_DOWNLOADS"
  "$EXE" install --keep-going --x-manifest-root="$HERE" --x-install-root="$INSTALLED" --x-buildtrees-root="$WORK/bt" --x-packages-root="$WORK/pk" --overlay-ports="$HERE/overlay" --overlay-triplets="$HERE/triplets" --triplet "$TRIPLET" --host-triplet "$TRIPLET" --clean-after-build
fi
if [ "$STEP" = configure ] || [ "$STEP" = all ]; then
  cmake -S "$SRC" -B "$BUILD" "${GEN[@]}" ${LINK[@]+"${LINK[@]}"} -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE="$VCPKG/scripts/buildsystems/vcpkg.cmake" -DVCPKG_TARGET_TRIPLET="$TRIPLET" -DVCPKG_OVERLAY_TRIPLETS="$HERE/triplets" \
    -DVCPKG_MANIFEST_MODE=OFF -DVCPKG_INSTALLED_DIR="$INSTALLED" \
    -DLSD_ENABLED=OFF -DCUDA_ENABLED=OFF -DHIP_ENABLED=OFF -DOPENGL_ENABLED=OFF -DGUI_ENABLED=OFF \
    -DCGAL_ENABLED=OFF -DONNX_ENABLED=OFF -DDOWNLOAD_ENABLED=OFF -DCASPAR_ENABLED=OFF \
    -DCCACHE_ENABLED=OFF -DIPO_ENABLED=OFF -DUNINSTALL_ENABLED=OFF -DTESTS_ENABLED=ON
fi
if [ "$STEP" = build ] || [ "$STEP" = all ]; then
  # The program, and the tests of what colmap-gwb.patch changes. Not every upstream test builds here:
  # sift_test.cc uses M_PI, which MSVC leaves undefined.
  cmake --build "$BUILD" --parallel "${SFM_JOBS:-8}" --target colmap_main colmap_optim_sparse_cholesky_test colmap_optim_least_absolute_deviations_test
  # conda's toolchain writes its own lib folder into what it links, whatever CMake is told, and that
  # is a folder of the build machine. As build-ffmpeg.sh: only the module's own lib/, for libgomp.
  [ "$TRIPLET" != x64-linux-gwb ] || patchelf --set-rpath '$ORIGIN/../lib' "$BUILD/src/colmap/exe/colmap"
fi
