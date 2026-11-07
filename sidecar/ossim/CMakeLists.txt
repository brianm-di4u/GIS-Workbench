# gwb-ossim-model and OSSIM's CNES plug-in, against an installed OSSIM (REQ-GAP-21). build.mjs
# drives this file. The plug-in holds the rigorous models of RADARSAT-2, TerraSAR-X, Pleiades,
# SPOT 6/7, ALOS PALSAR, COSMO-SkyMed, ENVISAT and ERS.
cmake_minimum_required(VERSION 3.16)
project(gwb_ossim CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
foreach(v OSSIM_PREFIX OSSIM_BUILD OSSIM_PLUGINS_SRC DEPS_PREFIX)
  if(NOT ${v})
    message(FATAL_ERROR "-D${v}=...")
  endif()
endforeach()

find_library(OSSIM_LIB NAMES ossim PATHS "${OSSIM_PREFIX}/lib" "${OSSIM_PREFIX}/lib64" NO_DEFAULT_PATH REQUIRED)
find_library(TIFF_LIB NAMES tiff PATHS "${DEPS_PREFIX}/lib" NO_DEFAULT_PATH REQUIRED)
include_directories("${OSSIM_PREFIX}/include" "${DEPS_PREFIX}/include")

file(GLOB_RECURSE CNES_SRC "${OSSIM_PLUGINS_SRC}/cnes/src/*.cpp")
add_library(ossim_cnes_plugin SHARED ${CNES_SRC})
target_include_directories(ossim_cnes_plugin PRIVATE "${OSSIM_PLUGINS_SRC}/cnes/src")
target_compile_definitions(ossim_cnes_plugin PRIVATE OSSIMPLUGINSMAKINGDLL)
target_link_libraries(ossim_cnes_plugin PRIVATE "${OSSIM_LIB}" "${TIFF_LIB}")

add_executable(gwb-ossim-model gwb_ossim_model.cpp)
target_link_libraries(gwb-ossim-model PRIVATE "${OSSIM_LIB}")
if(NOT MSVC)
  # libossim's own libraries are in the conda prefix, and the linker looks in them for its symbols.
  target_link_options(gwb-ossim-model PRIVATE "-Wl,-rpath-link,${DEPS_PREFIX}/lib")
  target_link_options(ossim_cnes_plugin PRIVATE "-Wl,-rpath-link,${DEPS_PREFIX}/lib")
  set_target_properties(gwb-ossim-model PROPERTIES INSTALL_RPATH "$ORIGIN/../lib" BUILD_WITH_INSTALL_RPATH ON)
  set_target_properties(ossim_cnes_plugin PROPERTIES INSTALL_RPATH "$ORIGIN/.." BUILD_WITH_INSTALL_RPATH ON)
endif()

install(TARGETS gwb-ossim-model RUNTIME DESTINATION bin)
install(TARGETS ossim_cnes_plugin RUNTIME DESTINATION plugins LIBRARY DESTINATION lib/plugins)
