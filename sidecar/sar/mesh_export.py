#!/usr/bin/env python3
"""3D model export for the sidecar (REQ-GAP-36): one script, three targets.

  fbx   Assimp's FBX exporter (binary).
  ifc   IFC4 through IfcOpenShell's file API: one IfcBuildingElementProxy per mesh, each an
        IfcTriangulatedFaceSet, with IfcMapConversion when a CRS and an origin are given. The
        module holds only the parser, the IFC4 schema and the Python layer of IfcOpenShell, with
        no CGAL kernel. Linux adds the Open CASCADE libraries the wrapper links at load time.
  wkt   A CSV of mesh names and TIN Z geometry, for ogr2ogr to write as Esri multipatch.

Assimp reads the input (glTF, GLB, OBJ, STL, PLY, COLLADA, FBX and the rest it knows). The library
comes from the sidecar's model3d module and is loaded by its fixed path, with ctypes. Node transforms are applied, faces become
triangles, and glTF's Y-up becomes Z-up for the two georeferenced targets.

Progress goes to stdout as `PROGRESS <0..1>` lines (the `lines` kind in sidecar/profiles).
"""

import argparse
import ctypes
import hashlib
import math
import os
import sys
import time
import uuid

AI_TRIANGULATE = 0x8
AI_JOIN_IDENTICAL = 0x2
AI_VALIDATE = 0x400
AI_SORT_BY_PTYPE = 0x8000
MAX_TRIANGLES = 50_000_000


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def progress(p):
    print(f"PROGRESS {p:.3f}", flush=True)


class Assimp:
    """The few functions of Assimp's C API this needs (assimp/cimport.h, cexport.h)."""

    def __init__(self, module_dir):
        win = sys.platform == "win32"
        libdir = os.path.join(module_dir, "bin" if win else "lib")
        names = ["assimp.dll"] if win else ["libassimp.so.6", "libassimp.so"]
        path = next((os.path.join(libdir, n) for n in names if os.path.exists(os.path.join(libdir, n))), None)
        if path is None:
            fail(f"the 3D model module is damaged: no Assimp library in {libdir}")
        if win:
            os.add_dll_directory(libdir)
        self.lib = ctypes.CDLL(path)
        self.lib.aiImportFile.restype = ctypes.c_void_p
        self.lib.aiImportFile.argtypes = [ctypes.c_char_p, ctypes.c_uint]
        self.lib.aiGetErrorString.restype = ctypes.c_char_p
        self.lib.aiReleaseImport.argtypes = [ctypes.c_void_p]
        self.lib.aiExportScene.restype = ctypes.c_int
        self.lib.aiExportScene.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]

    def error(self):
        e = self.lib.aiGetErrorString()
        return e.decode("utf-8", "replace") if e else "unknown error"

    def load(self, path, flags):
        s = self.lib.aiImportFile(path.encode("utf-8"), flags)
        if not s:
            err = self.error()
            if "compression not supported" in err or "KHR_draco" in err or "meshopt" in err:
                fail(f"{os.path.basename(path)} uses a compressed glTF extension Assimp does not read ({err}); export it uncompressed")
            fail(f"{os.path.basename(path)} is not a 3D model Assimp can read: {err}")
        return s

    def export(self, scene, fmt, path, flags=0):
        if self.lib.aiExportScene(scene, fmt.encode("ascii"), path.encode("utf-8"), flags) != 0:
            fail(f"Assimp could not write {fmt}: {self.error()}")

    def release(self, scene):
        self.lib.aiReleaseImport(scene)


def read_obj(path):
    """Meshes of an OBJ that Assimp wrote: [(name, [(x, y, z)...], [(a, b, c)...])], indices 0-based."""
    verts = []
    groups = []
    name = "mesh"
    cur = None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("v "):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                p = line.split()[1:]
                if len(p) != 3:
                    continue  # lines and points of a mixed model
                ids = []
                for x in p:
                    i = int(x.split("/")[0])
                    ids.append(i - 1 if i > 0 else len(verts) + i)
                if cur is None:
                    cur = (name, [])
                    groups.append(cur)
                cur[1].append(tuple(ids))
            elif line.startswith(("g ", "o ")):
                name = line[2:].strip() or "mesh"
                cur = None
    out = []
    for nm, tris in groups:
        used = {}
        local = []
        pts = []
        for t in tris:
            n = []
            for i in t:
                if i not in used:
                    used[i] = len(pts)
                    pts.append(verts[i])
                n.append(used[i])
            local.append(tuple(n))
        out.append((nm, pts, local))
    return out


def georeference(meshes, up, origin, scale):
    """Z-up metres at the origin, whatever the model's axes were."""
    ox, oy, oz = origin
    out = []
    for nm, pts, tris in meshes:
        if up == "y":
            q = [(x * scale + ox, -z * scale + oy, y * scale + oz) for x, y, z in pts]
        else:
            q = [(x * scale + ox, y * scale + oy, z * scale + oz) for x, y, z in pts]
        out.append((nm, q, tris))
    return out


def num(v):
    """A WKT number: shortest exact text."""
    if not math.isfinite(v):
        fail("the model holds a coordinate that is not a finite number")
    return repr(float(v))


def write_ifc(path, meshes, name, crs, origin, provenance, modules):
    sys.path.insert(0, os.path.join(modules, "model3d", "python"))
    try:
        import ifcopenshell
        import ifcopenshell.guid
    except ImportError as e:
        fail(f"the 3D model module has no IfcOpenShell: {e}")
    seed = hashlib.sha256()
    for nm, pts, tris in meshes:
        seed.update(nm.encode("utf-8"))
        seed.update(repr((len(pts), len(tris), pts[:8], tris[:8])).encode("ascii"))
    ns = uuid.UUID(bytes=seed.digest()[:16])
    guid = lambda key: ifcopenshell.guid.compress(uuid.uuid5(ns, key).hex)
    f = ifcopenshell.file(schema="IFC4")
    org = f.create_entity("IfcOrganization", Name="GIS Workbench")
    who = f.create_entity("IfcPersonAndOrganization", ThePerson=f.create_entity("IfcPerson", FamilyName="GIS Workbench Sidecar"), TheOrganization=org)
    app = f.create_entity("IfcApplication", ApplicationDeveloper=org, Version="1", ApplicationFullName="GIS Workbench Sidecar", ApplicationIdentifier="gwb-sidecar")
    hist = f.create_entity("IfcOwnerHistory", OwningUser=who, OwningApplication=app, ChangeAction="ADDED", CreationDate=int(time.time()))
    si = lambda kind, unit: f.create_entity("IfcSIUnit", UnitType=kind, Name=unit)
    lu = si("LENGTHUNIT", "METRE")
    units = f.create_entity("IfcUnitAssignment", Units=[lu, si("AREAUNIT", "SQUARE_METRE"), si("VOLUMEUNIT", "CUBIC_METRE"), si("PLANEANGLEUNIT", "RADIAN")])
    axis = f.create_entity("IfcAxis2Placement3D", Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)))
    ctx = f.create_entity("IfcGeometricRepresentationContext", ContextType="Model", CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=axis)
    body = f.create_entity("IfcGeometricRepresentationSubContext", ContextIdentifier="Body", ContextType="Model", ParentContext=ctx, TargetView="MODEL_VIEW")
    if crs:
        target = f.create_entity("IfcProjectedCRS", Name=crs, MapUnit=lu)
        f.create_entity("IfcMapConversion", SourceCRS=ctx, TargetCRS=target, Eastings=origin[0], Northings=origin[1], OrthogonalHeight=origin[2], XAxisAbscissa=1.0, XAxisOrdinate=0.0, Scale=1.0)
    project = f.create_entity("IfcProject", GlobalId=guid("project"), OwnerHistory=hist, Name=name, RepresentationContexts=[ctx], UnitsInContext=units)
    place = f.create_entity("IfcLocalPlacement", RelativePlacement=axis)
    site = f.create_entity("IfcSite", GlobalId=guid("site"), OwnerHistory=hist, Name=name, ObjectPlacement=place, CompositionType="ELEMENT")
    f.create_entity("IfcRelAggregates", GlobalId=guid("aggregate"), OwnerHistory=hist, RelatingObject=project, RelatedObjects=[site])
    parts = []
    for i, (nm, pts, tris) in enumerate(meshes):
        for p in pts:
            if not all(math.isfinite(c) for c in p):
                fail("the model holds a coordinate that is not a finite number")
        pl = f.create_entity("IfcCartesianPointList3D", CoordList=tuple(pts))
        fs = f.create_entity("IfcTriangulatedFaceSet", Coordinates=pl, CoordIndex=tuple((a + 1, b + 1, c + 1) for a, b, c in tris))
        rep = f.create_entity("IfcShapeRepresentation", ContextOfItems=body, RepresentationIdentifier="Body", RepresentationType="Tessellation", Items=[fs])
        shape = f.create_entity("IfcProductDefinitionShape", Representations=[rep])
        ep = f.create_entity("IfcLocalPlacement", PlacementRelTo=place, RelativePlacement=axis)
        parts.append(f.create_entity("IfcBuildingElementProxy", GlobalId=guid(f"part{i}"), OwnerHistory=hist, Name=nm, ObjectPlacement=ep, Representation=shape, PredefinedType="NOTDEFINED"))
        progress(0.5 + 0.4 * (i + 1) / len(meshes))
    f.create_entity("IfcRelContainedInSpatialStructure", GlobalId=guid("contains"), OwnerHistory=hist, RelatedElements=parts, RelatingStructure=site)
    h = f.header
    h.file_description.description = ("ViewDefinition [ReferenceView_V1.2]", provenance[:240])
    h.file_name.name = name
    h.file_name.organization = ("GIS Workbench",)
    h.file_name.originating_system = "GIS Workbench Sidecar"
    f.write(path)


def write_wkt(path, meshes):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("name,wkt\n")
        for i, (nm, pts, tris) in enumerate(meshes):
            tx = []
            for a, b, c in tris:
                ring = [pts[a], pts[b], pts[c], pts[a]]
                tx.append("((" + ",".join(f"{num(x)} {num(y)} {num(z)}" for x, y, z in ring) + "))")
            label = nm.replace('"', '""')
            f.write(f'"{label}","TIN Z (' + ",".join(tx) + ')"\n')
            progress(0.5 + 0.45 * (i + 1) / len(meshes))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modules", required=True)
    ap.add_argument("--format", required=True, choices=["fbx", "ifc", "wkt"])
    ap.add_argument("--up", default="auto", choices=["auto", "y", "z"])
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--origin-x", type=float, default=0.0)
    ap.add_argument("--origin-y", type=float, default=0.0)
    ap.add_argument("--origin-z", type=float, default=0.0)
    ap.add_argument("--crs", default="")
    ap.add_argument("--name", default="model")
    ap.add_argument("--provenance", default="")
    ap.add_argument("--work", default=".")
    ap.add_argument("input")
    ap.add_argument("output")
    a = ap.parse_args()
    if not (a.scale > 0) or not math.isfinite(a.scale):
        fail("the scale must be a positive number")
    ai = Assimp(os.path.join(a.modules, "model3d"))
    progress(0.02)
    if a.format == "fbx":
        s = ai.load(a.input, AI_VALIDATE)
        progress(0.5)
        ai.export(s, "fbx", a.output)
        ai.release(s)
        progress(1)
        return
    s = ai.load(a.input, AI_VALIDATE | AI_TRIANGULATE | AI_JOIN_IDENTICAL | AI_SORT_BY_PTYPE)
    progress(0.2)
    tmp = os.path.join(a.work, "mesh.obj")
    # The OBJ exporter applies the node transforms itself and keeps one group per node and mesh.
    ai.export(s, "obj", tmp)
    ai.release(s)
    progress(0.35)
    meshes = read_obj(tmp)
    if not meshes:
        fail(f"{os.path.basename(a.input)} holds no triangles")
    total = sum(len(t) for _, _, t in meshes)
    if total > MAX_TRIANGLES:
        fail(f"{os.path.basename(a.input)} has {total} triangles; this route takes at most {MAX_TRIANGLES}")
    ext = os.path.splitext(a.input)[1].lower()
    up = a.up if a.up != "auto" else ("y" if ext in (".gltf", ".glb") else "z")
    origin = (a.origin_x, a.origin_y, a.origin_z)
    if a.format == "ifc":
        # IFC keeps local coordinates; IfcMapConversion carries the origin.
        write_ifc(a.output, georeference(meshes, up, (0, 0, 0), a.scale), a.name, a.crs, origin, a.provenance, a.modules)
    else:
        write_wkt(a.output, georeference(meshes, up, origin, a.scale))
    print(f"{len(meshes)} meshes, {total} triangles", file=sys.stderr)
    progress(1)


if __name__ == "__main__":
    main()
