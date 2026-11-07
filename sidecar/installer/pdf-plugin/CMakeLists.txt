# GDAL's PDF driver as a plug-in reading through PDFium (REQ-GAP-67), built against the conda-forge
# libgdal the sidecar ships. conda-forge's own libgdal-pdf links poppler (GPL), and GDAL's tree can
# only build this driver together with the whole library, so this file compiles the driver's
# sources from the matching GDAL release and links them to the installed import library.
#
#   cmake -S sidecar/installer/pdf-plugin -B <build> -G Ninja -DCMAKE_BUILD_TYPE=Release \
#     -DGDAL_SRC=<gdal-3.13.3> -DGDAL_PREFIX=<conda prefix> -DPDFIUM_ROOT=<pdfium install>
#   cmake --build <build>
#
# GDAL_PREFIX is Library/ on Windows and the prefix itself on Linux. PDFIUM_ROOT is an unpacked
# release of rouault/pdfium_build_gdal_3_13 (MIT scripts; PDFium BSD-3-Clause and Apache-2.0).
# On Linux, afterwards: patchelf --set-rpath '$ORIGIN/..' gdal_PDF.so. conda's linker adds the build prefix,
# and the packaging gate refuses it (compose.mjs takes the result from gdal-*-26-rp).
cmake_minimum_required(VERSION 3.20)
project(gdal_PDF CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
foreach(v GDAL_SRC GDAL_PREFIX PDFIUM_ROOT)
  if(NOT DEFINED ${v})
    message(FATAL_ERROR "${v} is not set")
  endif()
endforeach()

set(D ${GDAL_SRC}/frmts/pdf)
# pdfdrivercore.cpp goes into the plug-in as well: its symbols carry the GDAL_driver_ prefix, so
# they do not meet the GDAL_core_ copies inside libgdal (GDAL's NO_SHARED_SYMBOL_WITH_CORE).
add_library(gdal_PDF MODULE
  ${D}/ogrpdflayer.cpp ${D}/pdfcreatecopy.cpp ${D}/pdfdataset.cpp ${D}/pdfio.cpp ${D}/pdfobject.cpp
  ${D}/pdfreadvectors.cpp ${D}/pdfwritabledataset.cpp ${D}/pdfcreatefromcomposition.cpp
  ${D}/pdfdrivercore.cpp)
set_target_properties(gdal_PDF PROPERTIES PREFIX "" CXX_VISIBILITY_PRESET hidden)
target_compile_definitions(gdal_PDF PRIVATE HAVE_PDFIUM GDAL_COMPILATION)
target_include_directories(gdal_PDF PRIVATE
  ${GDAL_SRC}/port ${GDAL_SRC}/gcore ${GDAL_SRC}/gcore/gdal_priv ${GDAL_SRC}/alg ${GDAL_SRC}/ogr
  ${GDAL_SRC}/ogr/ogrsf_frmts ${GDAL_SRC}/ogr/ogrsf_frmts/generic ${GDAL_SRC}/frmts/vrt
  ${GDAL_SRC}/frmts/mem ${GDAL_SRC}/third_party ${D}
  ${PDFIUM_ROOT}/include/pdfium ${PDFIUM_ROOT}/include/pdfium/public
  ${PDFIUM_ROOT}/include/pdfium/third_party/abseil-cpp
  # cpl_config.h and gdal_version.h, which the build of libgdal generated.
  ${GDAL_PREFIX}/include)
if(MSVC)
  target_compile_options(gdal_PDF PRIVATE /EHsc /utf-8 /permissive- /Zc:__cplusplus /bigobj)
  target_compile_definitions(gdal_PDF PRIVATE NOMINMAX _USE_MATH_DEFINES _CRT_SECURE_NO_DEPRECATE _CRT_NONSTDC_NO_DEPRECATE)
  target_link_libraries(gdal_PDF PRIVATE ${GDAL_PREFIX}/lib/gdal.lib ${PDFIUM_ROOT}/lib/pdfium.lib
    winmm gdi32 user32 advapi32)
else()
  # The libraries PDFium's static archive leaves open come from the same prefix as libgdal.
  target_compile_definitions(gdal_PDF PRIVATE _GLIBCXX_USE_CXX11_ABI=1)
  target_link_libraries(gdal_PDF PRIVATE -L${GDAL_PREFIX}/lib gdal ${PDFIUM_ROOT}/lib/libpdfium.a
    -l:libjpeg.so.8 -l:libpng16.so.16 -l:libopenjp2.so.7 -l:liblcms2.so.2 -l:libz.so.1 pthread)
  target_link_options(gdal_PDF PRIVATE -Wl,--as-needed -Wl,-rpath,$ORIGIN/..)
endif()
