"""Curate the embedded starter spectral library (REQ-MSI-13, `Research/10` §8) from USGS
Spectral Library Version 7, the AVIRIS-2014-convolved ASCII set (splib07b_cvAVIRISc2014,
224 channels 0.37–2.50 µm). Kokaly et al. 2017, USGS Data Series 1035, doi:10.5066/F7RR1WDJ.

Changes made (as the USGS use statement asks): a subset of about 90 spectra chosen by name,
values rounded to 4 decimals, deleted channels (-1.23e34) stored as null. No other change.

  python -I build/splib07-subset.py <ASCIIdata_splib07b_cvAVIRISc2014.zip> app/src/data/splib07-starter.json
"""

import json
import re
import sys
import zipfile

PICK = [
    # Minerals and rocks
    "Kaolinite_CM9", "Montmorillonite_SWy-1", "Illite_IMt-1", "Muscovite_GDS107", "Calcite_WS272", "Dolomite_HS102",
    "Gypsum_SU2202", "Alunite_GDS84", "Jarosite_GDS99", "Hematite_GDS27", "Goethite_WS222", "Quartz_GDS74",
    "Chlorite_SMR-13", "Epidote_GDS26", "Olivine_GDS70", "Serpentine_HS8", "Talc_GDS23", "Buddingtonite_GDS85",
    # Soils, sediments
    "Sand_DWO-3", "Soil", "Lunar", "Desert_Varnish",
    # Vegetation
    "Lawn_Grass_GDS91", "Grass_dry", "Oak_Oak-Leaf", "Conifer", "Aspen_Leaf", "Sagebrush", "Walnut_Leaf",
    "Juniper", "Cheatgrass", "Rangeland",
    # Water, snow, ice
    "Seawater_Coast", "Water", "Snow", "Ice", "Melting_snow",
    # Artificial
    "Asphalt", "Concrete", "Brick", "Roof", "Shingle", "Paint", "Plastic", "Fiberglass", "Aluminum",
    "Galvanized", "Steel", "Copper", "Cotton", "Nylon", "Polyester", "Rubber", "Wood", "Tarp", "Cardboard", "Glass",
]


def main(zpath, out):
    z = zipfile.ZipFile(zpath)
    names = z.namelist()
    wl_name = next(n for n in names if "Wavelengths_in_microns" in n)
    wl = [float(x) for x in z.read(wl_name).decode("latin1").split("\n")[1:] if x.strip()]
    spectra = []
    count = {}
    for n in sorted(names):
        if not n.endswith(".txt") or "Chapter" not in n or "_AREF" not in n:
            continue
        base = n.rsplit("/", 1)[-1]
        hit = next((p for p in PICK if p.lower() in base.lower()), None)
        # At most two spectra per pick keyword.
        if not hit or count.get(hit, 0) >= 2:
            continue
        lines = z.read(n).decode("latin1").splitlines()
        vals = [float(x) for x in lines[1:] if x.strip()]
        if len(vals) != len(wl):
            continue
        count[hit] = count.get(hit, 0) + 1
        spectra.append({
            "name": re.sub(r"^s07_AV14_", "", base[:-4]).replace("_AREF", "").replace("_", " "),
            "chapter": n.split("/")[1].replace("Chapter", "").split("_", 1)[-1],
            "values": [None if v < -1e30 else round(v, 4) for v in vals],
        })
    doc = {
        "source": "USGS Spectral Library Version 7 (Kokaly et al. 2017, USGS Data Series 1035, doi:10.5066/F7RR1WDJ), splib07b convolved to AVIRIS 2014",
        "acknowledgement": "Spectra courtesy of the U.S. Geological Survey. Subset and rounding by GIS Workbench; USGS has not reviewed or approved these changes.",
        "changes": "about 90 spectra selected by name; values rounded to 4 decimals; deleted channels stored as null",
        "wavelengthUnit": "um",
        "wavelengths": [round(v, 5) for v in wl],
        "spectra": spectra,
    }
    with open(out, "w", encoding="utf8") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(len(spectra), "spectra,", len(wl), "channels")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
