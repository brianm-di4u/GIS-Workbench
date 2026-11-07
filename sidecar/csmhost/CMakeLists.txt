# The CSM 3.0.x plug-in host (REQ-GAP-25, OD-2.18) and its mock plug-in. Neither is packaged: the
# host stays out of every shipped build until the sidecar is signed and has passed its external
# security review, and the project never distributes a plug-in. build.mjs drives this file.
cmake_minimum_required(VERSION 3.16)
project(gwb_csmhost CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CSM_SRC)
  message(FATAL_ERROR "-DCSM_SRC=<the CSM API source folder, 3.0.x>")
endif()
if(MSVC)
  add_compile_options(/W3 /EHsc /utf-8 /guard:cf)
  add_link_options(/guard:cf /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA)
else()
  add_compile_options(-Wall -fstack-protector-strong -fPIC)
  add_link_options(-Wl,-z,relro,-z,now -Wl,-z,noexecstack)
endif()

# The CSM API itself, public domain. A plug-in links this library, so the host must load the same
# one: csm::Plugin keeps its list of plug-ins here.
set(CSM_FILES BundleGM CorrelationModel Ellipsoid FourParameterCorrelationModel GeometricModel Isd
  LinearDecayCorrelationModel ModelIdentifier MultiNitfIsd Plugin RasterGM SettableEllipsoid Version)
set(CSM_SOURCES)
foreach(f ${CSM_FILES})
  list(APPEND CSM_SOURCES "${CSM_SRC}/${f}.cpp")
endforeach()
add_library(csmapi SHARED ${CSM_SOURCES})
target_include_directories(csmapi PUBLIC "${CSM_SRC}")
target_compile_definitions(csmapi PRIVATE CSM_LIBRARY)
if(MSVC)
  # The API's own files build with warnings the host's do not need to read.
  target_compile_options(csmapi PRIVATE /W1)
endif()

add_executable(gwb-csm-host src/host.cpp)
target_link_libraries(gwb-csm-host PRIVATE csmapi ${CMAKE_DL_LIBS})
if(NOT MSVC)
  set_target_properties(gwb-csm-host PROPERTIES BUILD_RPATH "$ORIGIN" INSTALL_RPATH "$ORIGIN")
endif()

add_library(gwb_mock_csm_plugin MODULE mock/mock_plugin.cpp)
# The same mock, stating a CSM version the host must refuse.
add_library(gwb_mock_csm_v2 MODULE mock/mock_plugin.cpp)
target_compile_definitions(gwb_mock_csm_v2 PRIVATE GWB_MOCK_VERSION_MAJOR=2 GWB_MOCK_VERSION_MINOR=1 GWB_MOCK_VERSION_REV=0)
target_link_libraries(gwb_mock_csm_v2 PRIVATE csmapi)
target_link_libraries(gwb_mock_csm_plugin PRIVATE csmapi)
if(NOT MSVC)
  set_target_properties(gwb_mock_csm_plugin gwb_mock_csm_v2 PROPERTIES PREFIX "" BUILD_RPATH "$ORIGIN")
else()
  target_link_libraries(gwb_mock_csm_plugin PRIVATE ws2_32)
  target_link_libraries(gwb_mock_csm_v2 PRIVATE ws2_32)
endif()

install(TARGETS gwb-csm-host gwb_mock_csm_plugin gwb_mock_csm_v2 csmapi RUNTIME DESTINATION . LIBRARY DESTINATION .)
