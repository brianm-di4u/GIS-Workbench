// GIS Workbench build shim for usgscsm (REQ-GAP-24): replaces <emscripten.h> in both the wasm
// module and the native oracle. usgscsm's Utilities.cpp uses one EM_ASM_INT, in isMsgpack, to ask
// Emscripten's JS file system whether an ISD file exists; the GIS Workbench module has no JS glue
// and no file system (ISDs and states arrive as strings through gw_csm.cpp), so the answer is
// "no file". Licence: Apache-2.0 (GIS Workbench).
#ifndef GW_CSM_COMPAT_EMSCRIPTEN_H
#define GW_CSM_COMPAT_EMSCRIPTEN_H
#define EM_ASM_INT(code, ...) 0
#endif
