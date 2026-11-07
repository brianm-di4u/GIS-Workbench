"""Make fixtures/fx26/sfm from the CC0 Aukerman set (OpenDroneMap/odm_data_aukerman).

    python -I sfm26_fixture.py <aukerman>/images fixtures/fx26/sfm

Downsized copies of a run of neighbouring frames, with their EXIF (GPS, camera) kept, so the test
of the whole route runs in minutes. Nothing else changes in the photographs.
"""
import sys
from pathlib import Path

from PIL import Image

SIZE = (800, 600)
NAMES = ["DSC00229", "DSC00230", "DSC00232", "DSC00233", "DSC00234", "DSC00235", "DSC00236", "DSC00237", "DSC00238", "DSC00239"]


def main(src, dst):
    src, dst = Path(src), Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    total = 0
    for n in NAMES:
        p = src / f"{n}.JPG"
        with Image.open(p) as im:
            exif = im.info["exif"]
            out = dst / f"{n}.JPG"
            im.resize(SIZE, Image.LANCZOS).save(out, quality=80, exif=exif)
        total += out.stat().st_size
    print(f"{len(NAMES)} files, {total} bytes")


if __name__ == "__main__":
    main(*sys.argv[1:3])
