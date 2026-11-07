# GDAL's FITS driver as a plug-in, with one correction (REQ-GAP-72). Built against the conda-forge
# libgdal the sidecar ships, the way pdf-plugin/ builds the PDF driver.
#
# The driver as released reads an image through cfitsio's scaling and then also reports BSCALE and
# BZERO as the band's scale and offset. An integer image comes back as physical values cut to integers
# (IRAS ISSA, 2.69..18.18 MJy/sr, reads as 2..18) and a reader that applies the scale changes them a
# second time. scale-fix.cmake makes the band hold the stored values, so that the scale and offset it
# reports are right, on every band. The unsigned conventions (BZERO 32768, 2147483648) stay as they were.
#
#   cmake -S sidecar/installer/fits-plugin -B <build> -G Ninja -DCMAKE_BUILD_TYPE=Release \
#     -DGDAL_SRC=<gdal-3.13.3> -DGDAL_PREFIX=<conda prefix> -DCFITSIO_PREFIX=<prefix with fitsio.h>
#   cmake --build <build>
#
# GDAL_PREFIX and CFITSIO_PREFIX are Library/ on Windows and the prefix itself on Linux.
# On Linux, afterwards: patchelf --set-rpath '$ORIGIN/..' gdal_FITS.so. conda's linker adds the build prefix,
# and the packaging gate refuses it (compose.mjs takes the result from gdal-*-26-rp).
cmake_minimum_required(VERSION 3.20)
project(gdal_FITS CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
foreach(v GDAL_SRC GDAL_PREFIX CFITSIO_PREFIX)
  if(NOT DEFINED ${v})
    message(FATAL_ERROR "${v} is not set")
  endif()
endforeach()

set(D ${GDAL_SRC}/frmts/fits)
include(${CMAKE_CURRENT_SOURCE_DIR}/scale-fix.cmake)
add_library(gdal_FITS MODULE ${CMAKE_CURRENT_BINARY_DIR}/fitsdataset.cpp ${D}/fitsdrivercore.cpp)
set_target_properties(gdal_FITS PROPERTIES PREFIX "" CXX_VISIBILITY_PRESET hidden)
target_compile_definitions(gdal_FITS PRIVATE GDAL_COMPILATION)
target_include_directories(gdal_FITS PRIVATE
  ${GDAL_SRC}/port ${GDAL_SRC}/gcore ${GDAL_SRC}/gcore/gdal_priv ${GDAL_SRC}/alg ${GDAL_SRC}/ogr
  ${GDAL_SRC}/ogr/ogrsf_frmts ${GDAL_SRC}/ogr/ogrsf_frmts/generic ${GDAL_SRC}/frmts/vrt
  ${GDAL_SRC}/frmts/mem ${GDAL_SRC}/third_party ${D}
  # cpl_config.h and gdal_version.h, which the build of libgdal generated.
  ${GDAL_PREFIX}/include ${CFITSIO_PREFIX}/include)
if(MSVC)
  target_compile_options(gdal_FITS PRIVATE /EHsc /utf-8 /permissive- /Zc:__cplusplus /bigobj)
  target_compile_definitions(gdal_FITS PRIVATE NOMINMAX _USE_MATH_DEFINES _CRT_SECURE_NO_DEPRECATE _CRT_NONSTDC_NO_DEPRECATE)
  target_link_libraries(gdal_FITS PRIVATE ${GDAL_PREFIX}/lib/gdal.lib ${CFITSIO_PREFIX}/lib/cfitsio.lib)
else()
  target_compile_definitions(gdal_FITS PRIVATE _GLIBCXX_USE_CXX11_ABI=1)
  target_link_libraries(gdal_FITS PRIVATE -L${GDAL_PREFIX}/lib gdal -L${CFITSIO_PREFIX}/lib cfitsio)
  target_link_options(gdal_FITS PRIVATE -Wl,--as-needed -Wl,-rpath,$ORIGIN/..)
endif()
