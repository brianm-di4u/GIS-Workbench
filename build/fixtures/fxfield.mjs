// Inputs for the field-data findings (phase F), shaped like the user's deliveries:
//   te060_delivery.zip   a stored ZIP of a stored reef/date ZIP (DigitalGlobe NextView layout): the
//                        big-endian JPEG tile (te060_bigendian_jpeg.tif from fxbigendian.py) as
//                        Reef_20150101_R1C1.tif, a _BROWSE quick look and the FX-12 shapefile ZIP
//                        as Reef_20150101_TILE_SHAPE.zip;
//   te060_dimap.zip      a deflated Pléiades-style volume: IMG_…_R1C1.TIF, its TFW, a DIM_….XML
//                        and a PREVIEW JPEG;
//   te063_roi.gml        a Pléiades-style GML 3 mask (hma:Mask, one footprint polygon, UTM 52N) and
//   te063_empty.gml      an empty one (no clouds): the DIMAP MASKS/*.GML shape;
//   te061_header.sid     a MrSID MG3 container header (synthetic: 20000 × 12000 px, 3 bands, 8-bit)
//                        and its .sdw world file.
//
//   node build/fixtures/fxfield.mjs [outdir]   (after python -I build/fixtures/fxbigendian.py)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'formats') : join(ROOT, 'fixtures', 'formats');
mkdirSync(OUT, { recursive: true });
const tif = readFileSync(join(OUT, 'te060_bigendian_jpeg.tif'));
// One shapefile set, as in a TILE_SHAPE ZIP.
const shp = zipSync(Object.fromEntries(Object.entries(unzipSync(readFileSync(join(ROOT, 'fixtures', 'fx12', 'fx12_shp.zip')))).filter(([k]) => k.startsWith('fx12_polygons.'))));
const tfw = new TextEncoder().encode('0.0001\n0\n0\n-0.0001\n10.00005\n19.99995\n');
const stored = (u8) => [u8, { level: 0 }];

const reef = zipSync({ 'Reef_20150101_R1C1.tif': stored(tif), 'Reef_20150101_BROWSE.tif': stored(tif), 'Reef_20150101_TILE_SHAPE.zip': stored(shp), 'NEXTVIEW.TXT': new TextEncoder().encode('synthetic licence notice\n') });
writeFileSync(join(OUT, 'te060_delivery.zip'), zipSync({ 'Islands/Reef 20150101.zip': stored(reef) }));

const stem = 'PHR1B_PMS_201804210157279_ORT_TEST';
const dim = `<?xml version="1.0"?>
<Dimap_Document><Metadata_Identification><METADATA_FORMAT version="2.0">DIMAP</METADATA_FORMAT></Metadata_Identification>
<Raster_Data><Raster_Display><Band_Display_Order><RED_CHANNEL>B2</RED_CHANNEL><GREEN_CHANNEL>B1</GREEN_CHANNEL><BLUE_CHANNEL>B0</BLUE_CHANNEL></Band_Display_Order></Raster_Display>
<Raster_Dimensions><NROWS>1024</NROWS><NCOLS>1024</NCOLS><NBANDS>3</NBANDS></Raster_Dimensions></Raster_Data>
<Dataset_Sources><Source_Identification><Strip_Source><MISSION>PHR</MISSION><MISSION_INDEX>1B</MISSION_INDEX><INSTRUMENT>PHR</INSTRUMENT><INSTRUMENT_INDEX>1B</INSTRUMENT_INDEX><IMAGING_DATE>2018-04-21</IMAGING_DATE><IMAGING_TIME>01:57:27.9Z</IMAGING_TIME></Strip_Source></Source_Identification></Dataset_Sources>
<Geometric_Data><Use_Area><Located_Geometric_Values><LOCATION_TYPE>Center</LOCATION_TYPE><TIME>2018-04-21T01:57:32.906Z</TIME>
<Acquisition_Angles><AZIMUTH_ANGLE>179.49</AZIMUTH_ANGLE><VIEWING_ANGLE unit="deg">24.35</VIEWING_ANGLE><INCIDENCE_ANGLE>27.33</INCIDENCE_ANGLE></Acquisition_Angles>
<Solar_Incidences><SUN_AZIMUTH unit="deg">147.16</SUN_AZIMUTH><SUN_ELEVATION unit="deg">55.00</SUN_ELEVATION></Solar_Incidences></Located_Geometric_Values></Use_Area></Geometric_Data>
<Processing_Information><Product_Settings><PROCESSING_LEVEL>ORTHO</PROCESSING_LEVEL><SPECTRAL_PROCESSING>PMS</SPECTRAL_PROCESSING></Product_Settings></Processing_Information>
</Dimap_Document>
`;
writeFileSync(join(OUT, 'te060_dimap.zip'), zipSync({
  [`VOL/IMG_PHR1B_PMS_001/IMG_${stem}_R1C1.TIF`]: tif,
  [`VOL/IMG_PHR1B_PMS_001/IMG_${stem}_R1C1.TFW`]: tfw,
  [`VOL/IMG_PHR1B_PMS_001/DIM_${stem}.XML`]: new TextEncoder().encode(dim),
  [`VOL/IMG_PHR1B_PMS_001/PREVIEW_${stem}.JPG`]: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
}, { level: 6 }));

// MrSID container header: magic, version 3, then the big-endian size at 26/30, bands at 36, bits at 40.
const sid = new Uint8Array(4096);
sid.set([0x6d, 0x73, 0x69, 0x64, 0x03, 0x00, 0x1a, 0x71, 0x01, 0x03]);
const v = new DataView(sid.buffer);
v.setUint32(26, 20000);
v.setUint32(30, 12000);
sid[36] = 3;
sid[40] = 8;
writeFileSync(join(OUT, 'te061_header.sid'), sid);
writeFileSync(join(OUT, 'te061_header.sdw'), '0.5\n0\n0\n-0.5\n869848.25\n1072964.25\n');
// DIMAP masks (GML 3, ESA HMA schema). Truth: pyproj EPSG:32652 → 4326 of the first and 14th vertices.
const mask = (members, title) => `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<hma:Mask gml:id="msk" xmlns:gml="http://www.opengis.net/gml" xmlns:hma="http://earth.esa.int/hma">
  <gml:name>${title}</gml:name>
  <gml:boundedBy><gml:Envelope srsName="urn:ogc:def:crs:EPSG:6.3:32652"><gml:lowerCorner>735601.25 4770958.75</gml:lowerCorner><gml:upperCorner>739947.75 4775658.25</gml:upperCorner></gml:Envelope></gml:boundedBy>
  ${members}
</hma:Mask>
`;
writeFileSync(join(OUT, 'te063_roi.gml'), mask(`<hma:maskMembers><hma:MaskFeature gml:id="roi-0"><hma:maskType codeSpace="urn:phr:ipu:maskType">SOURCE_IMAGE_FOOTPRINT</hma:maskType><gml:extentOf><gml:Polygon srsName="urn:ogc:def:crs:EPSG:6.3:32652"><gml:exterior><gml:LinearRing><gml:posList>739317.5 4775658.5 739579 4775573.5 739770 4775328.5 739848 4774984 739948 4771741 739891.5 4771398.5 739715.5 4771142.5 739467 4771044 736216.5 4770958.5 736207 4770958.5 735953.5 4771044 735762 4771291 735685 4771636.5 735601 4774880 735659 4775222.5 735835 4775476 736082.5 4775573.5 739317.5 4775658.5</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:extentOf></hma:MaskFeature></hma:maskMembers>`, 'ROI mask'));
writeFileSync(join(OUT, 'te063_empty.gml'), mask('<hma:maskMembers/>', 'Cloud mask'));
writeFileSync(join(OUT, 'te063_truth.json'), `${JSON.stringify({ roi: { vertices: 17, v0: [131.940598397, 43.095866925], v13: [131.894659619, 43.090029468], oracle: 'pyproj EPSG:32652→4326' } }, null, 1)}\n`);
console.log('fixtures/formats: te060_delivery.zip, te060_dimap.zip, te061_header.sid/.sdw, te063_*.gml');
