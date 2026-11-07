set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)
set(VCPKG_BUILD_TYPE release)
set(VCPKG_FIXUP_ELF_RPATH ON)
# The compilers come from conda-forge (an old glibc baseline, as the rest of the Linux trees).
set(VCPKG_ENV_PASSTHROUGH_UNTRACKED CC CXX AR RANLIB NM LD)
# GKlib's gk_arch.h defines __USE_XOPEN2K by hand, and glibc 2.17's signal.h then declares psiginfo
# before siginfo_t, in string.c, which asks for an empty _XOPEN_SOURCE. Newer headers guard it otherwise.
if(PORT STREQUAL "gklib")
  set(VCPKG_C_FLAGS "-D_GNU_SOURCE")
  set(VCPKG_CXX_FLAGS "-D_GNU_SOURCE")
endif()
