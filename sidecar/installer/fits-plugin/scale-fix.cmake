# The correction to fitsdataset.cpp, as exact replacements, so a different GDAL release stops the
# build here instead of being patched blindly. The result goes into the build folder.
file(READ ${D}/fitsdataset.cpp SRC)
function(fix old new)
  string(FIND "${SRC}" "${old}" at)
  if(at EQUAL -1)
    message(FATAL_ERROR "fitsdataset.cpp has changed: ${old}")
  endif()
  string(REPLACE "${old}" "${new}" SRC2 "${SRC}")
  set(SRC "${SRC2}" PARENT_SCOPE)
endfunction()

# Remember that this image is read as stored.
fix("    bool m_isExistingFile = false;"
    "    bool m_isExistingFile = false;\n    bool m_bStoredValues = false;  // BSCALE/BZERO left to the reader")
# The unsigned conventions are BSCALE = 1 only.
fix("    fits_read_key(hFITS, TDOUBLE, \"BLANK\", &m_dfNoDataValue, nullptr, &status);\n    m_bNoDataSet = !status;\n    status = 0;\n\n    // Determine data type"
    "    double dfBScale = 1.0;\n    fits_read_key(hFITS, TDOUBLE, \"BSCALE\", &dfBScale, nullptr, &status);\n    if (status)\n    {\n        status = 0;\n        dfBScale = 1.0;\n    }\n\n    fits_read_key(hFITS, TDOUBLE, \"BLANK\", &m_dfNoDataValue, nullptr, &status);\n    m_bNoDataSet = !status;\n    status = 0;\n\n    // Determine data type")
fix("if (offset == 32768.)" "if (offset == 32768. && dfBScale == 1.0)")
fix("if (offset == 2147483648.)" "if (offset == 2147483648. && dfBScale == 1.0)")
# Stored values, on every band.
fix("    fits_read_img(hFITS, dataset->m_fitsDataType, offset, nElements, nullptr,\n                  pImage, nullptr, &status);"
    "    if (dataset->m_bStoredValues)\n        fits_set_bscale(hFITS, 1.0, 0.0, &status);\n    fits_read_img(hFITS, dataset->m_fitsDataType, offset, nElements, nullptr,\n                  pImage, nullptr, &status);")
fix("            poBand->m_bHaveOffsetScale = true;\n            poBand->m_dfScale = dfScale;\n            poBand->m_dfOffset = dfOffset;"
    "            m_bStoredValues = m_isExistingFile;\n            for (int iBand = 1; iBand <= nBands; ++iBand)\n            {\n                poBand = cpl::down_cast<FITSRasterBand *>(GetRasterBand(iBand));\n                poBand->m_bHaveOffsetScale = true;\n                poBand->m_dfScale = dfScale;\n                poBand->m_dfOffset = dfOffset;\n            }")
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/fitsdataset.cpp "${SRC}")
