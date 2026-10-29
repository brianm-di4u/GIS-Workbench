"""Derived SICD 1.4.0 / 1.5 and SIDD 3.0 NITF from real older-version products (REQ-SAR SICD/SIDD
version coverage). No anonymous public SICD 1.4+ NITF exists (sarkit ships XML only); the pixels and
metadata of each source are kept, the XML is moved to the newer namespace, fields the newer schema
requires are filled from the existing metadata, and the result must validate against the SARkit
schema before SARkit's NitfWriter writes it. Registers the item in sources/archive-derived.json.

  micromamba run -n gw-te python -I build/campaign/derive_sar_versions.py
"""

import copy
import json
import pathlib
import re

import lxml.etree as et
import numpy as np
import sarkit.sicd as sicd
import sarkit.sidd as sidd

HERE = pathlib.Path(__file__).resolve().parent
CORPUS = pathlib.Path(__import__('os').environ.get('TE_CORPUS', HERE.parents[2] / 'TE-corpus'))
OUT_JSON = HERE / 'sources' / 'archive-derived.json'
ID = 'derived-sar-sicd14-sidd30'
OUT = CORPUS / ID
OUT.mkdir(parents=True, exist_ok=True)

SICD_SRC = [  # (item, file, tag)
    ('sar-osml-sicd-sidd-chips', 'capella-sicd130-chip1.ntf', 'capella_chip1'),
    ('sar-osml-sicd-sidd-chips', 'umbra-sicd121-chip1.ntf', 'umbra_chip1'),
    ('sar-sicd-sidd-six-library', 'SICD/sicd_50x50.nitf', 'six_50x50'),
]
SIDD_SRC = [
    ('sar-capella-c10-sp-20240329', 'capella_C10_SP_SIDD.ntf', 'capella_c10_sp_sidd'),  # the OSML umbra-sidd200 chip keeps the full-scene XML (15328², pixels 512²)
    ('capella-c13-sm-20240924', 'capella_C13_SM_SIDD.ntf', 'capella_c13_sm_sidd'),
    ('umbra-bingham-20230821-repeat', 'umbra_20230821_SIDD.nitf', 'umbra_bingham_sidd'),
]


def renamespace(tree, old, new):
    root = copy.deepcopy(tree.getroot())
    for el in root.iter():
        if isinstance(el.tag, str) and el.tag.startswith('{' + old + '}'):
            el.tag = '{' + new + '}' + el.tag[len(old) + 2:]
    et.cleanup_namespaces(root, top_nsmap={None: new})
    nsmap = {k: v for k, v in root.nsmap.items() if v != old}
    nsmap[None] = new
    fresh = et.Element(root.tag, nsmap=nsmap, attrib=root.attrib)
    fresh.extend(list(root))
    return et.ElementTree(fresh)


def validate(tree, xsd):
    schema = et.XMLSchema(file=str(xsd))
    if not schema.validate(tree):
        raise ValueError('; '.join(f'{e.line}: {e.message}' for e in list(schema.error_log)[:8]))


def ns_of(tree):
    return et.QName(tree.getroot()).namespace


ISM13 = 'urn:us:gov:ic:ism:13'


def raw_xml(src, root):
    """The XML DES payload straight from the file bytes (for files SARkit's strict reader refuses)."""
    b = pathlib.Path(src).read_bytes()
    m = re.search(rb'<(\w+:)?' + root.encode() + rb'[\s>].*?</(\w+:)?' + root.encode() + rb'>', b, re.S)  # root may carry a prefix (ns0:SICD)
    return et.ElementTree(et.fromstring(m.group(0)))


def ism13(tree):
    """SIDD 3.0 takes ISM v13 on ProductCreation/Classification (as ICEYE's SIDD 3.0 products)."""
    for el in tree.getroot().iter():
        if isinstance(el.tag, str) and et.QName(el).localname == 'Classification' and et.QName(el.getparent()).localname == 'ProductCreation':
            old = {et.QName(k).localname: v for k, v in el.attrib.items()}
            el.attrib.clear()
            for k, v in (('DESVersion', '13'), ('resourceElement', 'true'), ('createDate', old.get('createDate', '2026-10-28')), ('compliesWith', 'USGov'),
                         ('ISMCATCESVersion', '201903'), ('classification', old.get('classification', 'U')), ('ownerProducer', old.get('ownerProducer', 'USA'))):
                el.set('{' + ISM13 + '}' + k, v)
    root = tree.getroot()
    fresh = et.Element(root.tag, nsmap={**{k: v for k, v in root.nsmap.items() if not (v or '').startswith('urn:us:gov:ic:ism')}, 'ism': ISM13}, attrib=root.attrib)
    fresh.extend(list(root))
    et.cleanup_namespaces(fresh)
    return et.ElementTree(fresh)


ANGLES = {'Angle', 'MultiPath', 'GroundTrack', 'Azimuth', 'North', 'Shadow', 'Layover', 'RotationAngle'}


def angles360(tree):
    """SICommon/SIDD angle types are [0, 360): some producers (Umbra) write negative angles."""
    for el in tree.getroot().iter():
        if isinstance(el.tag, str) and et.QName(el).localname in ANGLES and el.text:
            try:
                v = float(el.text)
            except ValueError:
                continue
            if v < 0:
                el.text = repr(v % 360)
    return tree


def to_sicd(src, urn):
    try:
        with open(src, 'rb') as f:
            r = sicd.NitfReader(f)
            meta, img = r.metadata, r.read_image()
        xml, parts = meta.xmltree, dict(file_header_part=meta.file_header_part, im_subheader_part=meta.im_subheader_part, de_subheader_part=meta.de_subheader_part)
    except ValueError:  # blank DESCRC etc.: pixels through sarpy, XML from the DES bytes, fresh U subheaders
        from sarpy.io.complex.converter import open_complex
        rd = open_complex(str(src))
        xml = raw_xml(src, 'SICD')
        pt = rd.sicd_meta.ImageData.PixelType
        a = rd[:, :]
        img = np.empty(a.shape, sicd.PIXEL_TYPES[pt]['dtype'])
        if pt == 'RE32F_IM32F':
            img[...] = a
        else:
            img['real'], img['imag'] = a.real, a.imag
        sec = sicd.NitfSecurityFields(clas='U')
        parts = dict(file_header_part=sicd.NitfFileHeaderPart(ostaid='GISWB-TE', ftitle=pathlib.Path(src).stem, security=sec),
                     im_subheader_part=sicd.NitfImSubheaderPart(isorce=rd.sicd_meta.CollectionInfo.CollectorName or 'SAR', security=sec),
                     de_subheader_part=sicd.NitfDeSubheaderPart(security=sec))
    old = ns_of(xml)
    tree = renamespace(xml, old, urn)
    validate(tree, sicd.VERSION_INFO[urn]['schema'])
    return sicd.NitfMetadata(xmltree=tree, **parts), img, old


def to_sidd(src, urn):
    try:
        with open(src, 'rb') as f:
            r = sidd.NitfReader(f)
            meta = r.metadata
            imgs = [r.read_image(k) for k in range(len(meta.images))]
        if not imgs:
            raise IndexError('no product image segments')
    except (ValueError, IndexError):  # strict reader refused: pixels through GDAL, XML from the DES bytes, fresh U subheaders
        from osgeo import gdal
        xml = raw_xml(src, 'SIDD')
        old = ns_of(xml)
        tree = angles360(ism13(renamespace(xml, old, urn)))
        validate(tree, sidd.VERSION_INFO[urn]['schema'])
        ds = gdal.Open(str(src))  # keep the dataset alive while the band is read
        a = ds.GetRasterBand(1).ReadAsArray()
        sec = sidd.NitfSecurityFields(clas='U')
        im = sidd.NitfProductImageMetadata(xmltree=tree, im_subheader_part=sidd.NitfImSubheaderPart(security=sec), de_subheader_part=sidd.NitfDeSubheaderPart(security=sec))
        return sidd.NitfMetadata(file_header_part=sidd.NitfFileHeaderPart(ostaid='GISWB-TE', ftitle=pathlib.Path(src).stem, security=sec), images=[im]), [a], old
    old = ns_of(meta.images[0].xmltree)
    images = []
    for im in meta.images:
        tree = angles360(ism13(renamespace(im.xmltree, old, urn)))
        validate(tree, sidd.VERSION_INFO[urn]['schema'])
        images.append(sidd.NitfProductImageMetadata(xmltree=tree, im_subheader_part=im.im_subheader_part, de_subheader_part=im.de_subheader_part, legends=im.legends, lookup_table=im.lookup_table))
    # The source SICD XML DES (if any) stays out: its version would not match the 3.0 product.
    return sidd.NitfMetadata(file_header_part=meta.file_header_part, images=images, ded=meta.ded, product_support_xmls=meta.product_support_xmls), imgs, old


def main():
    files, recipe, fails = [], [], []
    for urn, short in (('urn:SICD:1.4.0', '14'), ('urn:SICD:1.5', '15')):
        for item, rel, tag in SICD_SRC:
            name = f'{tag}_sicd{short}.nitf'
            try:
                meta, img, old = to_sicd(CORPUS / item / rel, urn)
                with open(OUT / name, 'wb') as f, sicd.NitfWriter(f, meta) as w:
                    w.write_image(img)
                files.append({'name': name, 'url': None, 'role': 'primary'})
                recipe.append(f'{item}/{rel} ({old}) → {urn}')
                print('ok  ', name, flush=True)
            except Exception as ex:  # noqa: BLE001 - report each source and continue
                fails.append(f'{name}: {type(ex).__name__}: {ex}')
                print('FAIL', fails[-1], flush=True)
    for item, rel, tag in SIDD_SRC:
        name = f'{tag}_sidd30.nitf'
        try:
            meta, imgs, old = to_sidd(CORPUS / item / rel, 'urn:SIDD:3.0.0')
            with open(OUT / name, 'wb') as f, sidd.NitfWriter(f, meta) as w:
                for k, a in enumerate(imgs):
                    w.write_image(k, a)
            files.append({'name': name, 'url': None, 'role': 'primary'})
            recipe.append(f'{item}/{rel} ({old}) → urn:SIDD:3.0.0')
            print('ok  ', name, flush=True)
        except Exception as ex:  # noqa: BLE001
            fails.append(f'{name}: {type(ex).__name__}: {ex}')
            print('FAIL', fails[-1], flush=True)
    entry = {
        'id': ID, 'area': 'sar',
        'title': 'SICD 1.4.0 and 1.5 NITF (Capella, Umbra, six-library) and SIDD 3.0 NITF (Umbra, six-library), re-versioned from real products with SARkit',
        'source': 'Derived from sar-osml-sicd-sidd-chips and sar-sicd-sidd-six-library', 'landing': 'build/campaign/derive_sar_versions.py',
        'licence': 'Apache-2.0 (OSML test chips); MIT (six-library); source imagery CC BY 4.0 (Capella, Umbra open data)',
        'attribution': 'Capella Space, Umbra Space open data; aws-solutions-library-samples/osml; ngageoint/six-library',
        'tier': 'A', 'origin': 'derived', 'format': 'SICD 1.4.0 / 1.5 NITF, SIDD 3.0 NITF',
        'profile': 'Pixels and NITF subheaders copied; XML moved to the newer namespace and validated against the SARkit XSD; written by sarkit NitfWriter',
        'files': files, 'sign': None, 'derivation': '; '.join(recipe),
        'notes': 'Generated by build/campaign/derive_sar_versions.py. Only the namespace changes, so the metadata uses no field new in 1.4/1.5/3.0.' + (f' Failed: {"; ".join(fails)}' if fails else ''),
        'feeds': ['ingest', 'sar.metadata', 'sar.remap'],
        'covers': ['fmt:sar.sicd.v1.4.0', 'fmt:sar.sidd.v3.0.0'], 'pairs': [],
    }
    old = json.loads(OUT_JSON.read_text(encoding='utf-8')) if OUT_JSON.exists() else []
    old = [e for e in old if e['id'] != ID] + [entry]
    OUT_JSON.write_text(json.dumps(old, indent=1, ensure_ascii=False), encoding='utf-8')
    print(f'{ID}: {len(files)} files, {len(fails)} failed')


if __name__ == '__main__':
    main()
