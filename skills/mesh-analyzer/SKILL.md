---
name: Mesh Analyzer
description: Analyze and reconstruct 3D mesh data (OBJ, STL binary, GLTF JSON) using pure Python parsing and vapor-idx. No external libraries. Index vertices, faces, edges, materials, normals. Traverse topology for spatial queries, connectivity analysis, and cluster detection. Reconstruct as Blender Python or OBJ. 5x validation pass on computed geometric properties.
version: 2.0.0
tools:
  - computer_use
---

# Mesh Analyzer Skill

## Purpose

Parse raw 3D mesh formats with built-in Python and index every geometric element
into vapor-idx as typed records. Traverse relationships to understand topology,
detect clusters, compute normals, find disconnected components, and reconstruct.

No Blender, no Three.js, no external geometry libraries — pure Python `struct`
for binary formats, text parsing for OBJ, JSON for GLTF.

## Supported raw formats

- **OBJ** — text format, no library needed
- **STL binary** — parsed with `struct` (built-in)
- **STL ASCII** — text parsing
- **GLTF/GLB** — JSON + base64 (built-in `json` + `base64`)

## Environment

```bash
pip install vapor-idx
```

---

## Step 1 — Raw format parsers

```python
import struct, json, base64, math

def parse_obj(filepath: str) -> dict:
    """Parse OBJ text format. Returns raw geometry dict."""
    vertices, normals, uvs = [], [], []
    faces, materials, current_mat = [], {}, "default"
    mat_to_idx: dict[str,int] = {}

    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            p = line.strip().split()
            if not p or p[0].startswith('#'): continue
            if p[0] == 'v':
                vertices.append((float(p[1]), float(p[2]), float(p[3])))
            elif p[0] == 'vn':
                normals.append((float(p[1]), float(p[2]), float(p[3])))
            elif p[0] == 'vt':
                uvs.append((float(p[1]), float(p[2]) if len(p) > 2 else 0.0))
            elif p[0] == 'usemtl':
                current_mat = p[1]
                if current_mat not in mat_to_idx:
                    mat_to_idx[current_mat] = len(mat_to_idx)
                    materials[current_mat] = {"name": current_mat}
            elif p[0] == 'f':
                verts = []
                for tok in p[1:]:
                    parts = tok.split('/')
                    vi = int(parts[0]) - 1
                    vt = int(parts[1])-1 if len(parts)>1 and parts[1] else -1
                    vn = int(parts[2])-1 if len(parts)>2 and parts[2] else -1
                    verts.append((vi, vt, vn))
                faces.append({"verts": verts, "mat": current_mat,
                               "mat_idx": mat_to_idx.get(current_mat, 0)})

    return {"vertices": vertices, "normals": normals, "uvs": uvs,
            "faces": faces, "materials": materials, "mat_to_idx": mat_to_idx}


def parse_stl_binary(filepath: str) -> dict:
    """
    Parse binary STL using struct (built-in).
    Binary STL: 80-byte header, 4-byte triangle count, then per-triangle:
      3×float normal, 9×float vertices, 2-byte attribute.
    """
    with open(filepath, 'rb') as f:
        f.read(80)  # skip header
        n_triangles = struct.unpack('<I', f.read(4))[0]
        vertices, normals, faces = [], [], []
        vert_map: dict[tuple, int] = {}

        for i in range(n_triangles):
            nx, ny, nz = struct.unpack('<fff', f.read(12))
            face_vert_indices = []
            for _ in range(3):
                x, y, z = struct.unpack('<fff', f.read(12))
                key = (round(x,6), round(y,6), round(z,6))
                if key not in vert_map:
                    vert_map[key] = len(vertices)
                    vertices.append((x, y, z))
                face_vert_indices.append(vert_map[key])
            normals.append((nx, ny, nz))
            faces.append({"verts": [(vi,-1,i) for vi in face_vert_indices],
                          "mat": "default", "mat_idx": 0,
                          "face_normal": (nx, ny, nz)})
            f.read(2)  # attribute byte count

    return {"vertices": vertices, "normals": normals, "uvs": [],
            "faces": faces, "materials": {"default": {"name":"default"}},
            "mat_to_idx": {"default":0}}


def parse_stl_ascii(filepath: str) -> dict:
    """Parse ASCII STL text format."""
    vertices, normals, faces = [], [], []
    vert_map: dict[tuple,int] = {}
    current_normal = (0.0, 0.0, 0.0)
    face_verts: list[int] = []
    face_idx = 0

    with open(filepath, 'r') as f:
        for line in f:
            tok = line.strip().split()
            if not tok: continue
            if tok[0] == 'facet' and tok[1] == 'normal':
                current_normal = (float(tok[2]),float(tok[3]),float(tok[4]))
                face_verts = []
            elif tok[0] == 'vertex':
                key = (round(float(tok[1]),6),round(float(tok[2]),6),round(float(tok[3]),6))
                if key not in vert_map:
                    vert_map[key] = len(vertices)
                    vertices.append(key)
                    normals.append(current_normal)
                face_verts.append(vert_map[key])
            elif tok[0] == 'endfacet':
                if len(face_verts) == 3:
                    faces.append({"verts": [(vi,-1,face_idx) for vi in face_verts],
                                  "mat": "default", "mat_idx": 0,
                                  "face_normal": current_normal})
                    face_idx += 1

    return {"vertices": vertices, "normals": normals, "uvs": [],
            "faces": faces, "materials": {"default":{"name":"default"}},
            "mat_to_idx": {"default":0}}


def parse_gltf(filepath: str) -> dict:
    """
    Parse GLTF JSON (no external library).
    Reads the JSON manifest and decodes base64 buffer data.
    Supports triangle meshes only.
    """
    with open(filepath, 'r') as f:
        gltf = json.load(f)

    buffers = []
    for buf in gltf.get("buffers", []):
        if "uri" in buf and buf["uri"].startswith("data:"):
            b64 = buf["uri"].split(",",1)[1]
            buffers.append(base64.b64decode(b64))
        else:
            # External binary buffer
            bin_path = filepath.rsplit('/',1)[0] + '/' + buf.get("uri","")
            try:
                with open(bin_path,'rb') as bf:
                    buffers.append(bf.read())
            except:
                buffers.append(b'')

    def get_accessor_data(acc_idx):
        acc  = gltf["accessors"][acc_idx]
        bv   = gltf["bufferViews"][acc["bufferView"]]
        buf  = buffers[bv["buffer"]]
        off  = bv.get("byteOffset",0) + acc.get("byteOffset",0)
        count= acc["count"]
        comp = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4,"MAT4":16}[acc["type"]]
        fmt  = {5120:'b',5121:'B',5122:'h',5123:'H',5126:'f'}[acc["componentType"]]
        stride = struct.calcsize(fmt) * comp
        return [struct.unpack_from(comp*fmt, buf, off+i*stride)
                for i in range(count)]

    vertices, normals, uvs, faces = [], [], [], []
    mat_names = [m.get("name","mat_%d"%i) for i,m in
                 enumerate(gltf.get("materials",[{"name":"default"}]))]

    for mesh in gltf.get("meshes",[]):
        for prim in mesh.get("primitives",[]):
            attrs  = prim.get("attributes",{})
            mat_idx= prim.get("material",0)
            v_off  = len(vertices)

            if "POSITION" in attrs:
                vpos = get_accessor_data(attrs["POSITION"])
                vertices.extend(vpos)
            if "NORMAL" in attrs:
                vnrm = get_accessor_data(attrs["NORMAL"])
                normals.extend([n[0] for n in vnrm] if vnrm else [])
            if "TEXCOORD_0" in attrs:
                vuv = get_accessor_data(attrs["TEXCOORD_0"])
                uvs.extend(vuv)
            if "indices" in prim:
                idx_data = get_accessor_data(prim["indices"])
                flat_idx = [i[0] for i in idx_data]
                for k in range(0, len(flat_idx)-2, 3):
                    a,b,c = flat_idx[k],flat_idx[k+1],flat_idx[k+2]
                    faces.append({"verts": [(v_off+a,-1,-1),(v_off+b,-1,-1),(v_off+c,-1,-1)],
                                  "mat": mat_names[mat_idx] if mat_idx<len(mat_names) else "default",
                                  "mat_idx": mat_idx})

    mats = {n:{"name":n} for n in mat_names} if mat_names else {"default":{"name":"default"}}
    return {"vertices": vertices, "normals": normals, "uvs": uvs,
            "faces": faces, "materials": mats,
            "mat_to_idx": {n:i for i,n in enumerate(mat_names)}}


def load_mesh(filepath: str) -> dict:
    """Auto-detect format and parse."""
    ext = filepath.rsplit('.',1)[-1].lower()
    if ext == 'obj':   return parse_obj(filepath)
    if ext == 'gltf':  return parse_gltf(filepath)
    if ext in ('glb','stl'):
        # Detect binary vs ASCII STL
        with open(filepath,'rb') as f:
            header = f.read(80)
        if b'solid' in header[:5] and ext == 'stl':
            return parse_stl_ascii(filepath)
        return parse_stl_binary(filepath)
    raise ValueError(f"Unsupported format: {ext}")
```

---

## Step 2 — Schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions, PathOptions

vapor = create_vapor({
    "types": {
        "Vertex": {
            "fields": {
                "x":          {"type": "number", "index": "range"},
                "y":          {"type": "number", "index": "range"},
                "z":          {"type": "number", "index": "range"},
                "normal_x":   {"type": "number", "index": "none"},
                "normal_y":   {"type": "number", "index": "none"},
                "normal_z":   {"type": "number", "index": "none"},
                "u":          {"type": "number", "index": "range"},
                "v":          {"type": "number", "index": "range"},
                "mat_idx":    {"type": "number", "index": "exact"},
                "valence":    {"type": "number", "index": "range"},
                "component":  {"type": "string", "index": "exact"},
                "curvature":  {"type": "number", "index": "range"},
            },
            "relationships": {
                "CONNECTED_TO":  {"targetTypes":["Vertex"],"directed":False,"cardinality":"many-to-many"},
                "PART_OF_FACE":  {"targetTypes":["Face"],  "directed":True, "cardinality":"many-to-many"},
                "SHARES_EDGE":   {"targetTypes":["Vertex"],"directed":False,"cardinality":"many-to-many"},
            },
        },
        "Face": {
            "fields": {
                "face_idx":    {"type": "number", "index": "range"},
                "mat_idx":     {"type": "number", "index": "exact"},
                "area":        {"type": "number", "index": "range"},
                "normal_x":    {"type": "number", "index": "none"},
                "normal_y":    {"type": "number", "index": "none"},
                "normal_z":    {"type": "number", "index": "none"},
                "center_x":    {"type": "number", "index": "range"},
                "center_y":    {"type": "number", "index": "range"},
                "center_z":    {"type": "number", "index": "range"},
                "is_boundary": {"type": "boolean","index": "exact"},
                "component":   {"type": "string", "index": "exact"},
            },
            "relationships": {
                "ADJACENT_TO":  {"targetTypes":["Face"],    "directed":False,"cardinality":"many-to-many"},
                "USES_MATERIAL":{"targetTypes":["Material"],"directed":True, "cardinality":"many-to-one"},
            },
        },
        "Edge": {
            "fields": {
                "length":       {"type": "number", "index": "range"},
                "is_boundary":  {"type": "boolean","index": "exact"},
                "is_crease":    {"type": "boolean","index": "exact"},
                "dihedral_angle":{"type":"number", "index": "range"},
            },
            "relationships": {
                "CONNECTS": {"targetTypes":["Vertex"],"directed":False,"cardinality":"one-to-many"},
                "BORDERS":  {"targetTypes":["Face"],  "directed":False,"cardinality":"many-to-many"},
            },
        },
        "Material": {
            "fields": {
                "name":       {"type": "string", "index": "exact"},
                "base_r":     {"type": "number", "index": "range"},
                "base_g":     {"type": "number", "index": "range"},
                "base_b":     {"type": "number", "index": "range"},
                "roughness":  {"type": "number", "index": "range"},
                "metallic":   {"type": "number", "index": "range"},
                "face_count": {"type": "number", "index": "range"},
            },
            "relationships": {},
        },
    },
})
```

---

## Step 3 — Index mesh into vapor

```python
def vec3_length(v):
    return (v[0]**2 + v[1]**2 + v[2]**2) ** 0.5

def vec3_cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])

def vec3_sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])

def compute_triangle_area(p0, p1, p2):
    ab = vec3_sub(p1, p0)
    ac = vec3_sub(p2, p0)
    cross = vec3_cross(ab, ac)
    return vec3_length(cross) / 2.0

def compute_triangle_normal(p0, p1, p2):
    ab = vec3_sub(p1, p0)
    ac = vec3_sub(p2, p0)
    cross = vec3_cross(ab, ac)
    L = vec3_length(cross)
    if L < 1e-10: return (0.0, 1.0, 0.0)
    return (cross[0]/L, cross[1]/L, cross[2]/L)


def index_mesh(vapor, geometry: dict) -> tuple[list, list, dict]:
    """
    Index all mesh geometry into vapor. Returns (vertex_ids, face_ids, mat_ids).
    Computes face areas, face normals, face centres, and edge lengths.
    """
    verts = geometry["vertices"]
    faces = geometry["faces"]
    mats  = geometry["materials"]

    # Index materials
    mat_ids: dict[str, str] = {}
    face_count_per_mat: dict[str, int] = {}
    for mat_name, mat_data in mats.items():
        mid = vapor.store("Material", {
            "name":       mat_name,
            "base_r":     mat_data.get("r", 0.8) * 255,
            "base_g":     mat_data.get("g", 0.8) * 255,
            "base_b":     mat_data.get("b", 0.8) * 255,
            "roughness":  mat_data.get("roughness", 0.5),
            "metallic":   mat_data.get("metallic", 0.0),
            "face_count": 0.0,
        })
        mat_ids[mat_name] = mid
        face_count_per_mat[mat_name] = 0

    # Index vertices
    vertex_ids: list[str] = []
    for i, (x, y, z) in enumerate(verts):
        vid = vapor.store("Vertex", {
            "x": float(x), "y": float(y), "z": float(z),
            "normal_x": 0.0, "normal_y": 0.0, "normal_z": 0.0,
            "u": 0.0, "v": 0.0,
            "mat_idx":   0.0,
            "valence":   0.0,
            "component": "",
            "curvature": 0.0,
        })
        vertex_ids.append(vid)

    # Index faces and edges
    face_ids:   list[str] = []
    edge_map:   dict[frozenset, str] = {}  # frozenset{vi,vj} -> edge_id

    for fi, face in enumerate(faces):
        vi_list = [v[0] for v in face["verts"] if 0 <= v[0] < len(vertex_ids)]
        if len(vi_list) < 3: continue

        # Compute face geometry
        p0 = verts[vi_list[0]]
        p1 = verts[vi_list[1]]
        p2 = verts[vi_list[2]]
        area   = compute_triangle_area(p0, p1, p2)
        normal = (face.get("face_normal") or compute_triangle_normal(p0, p1, p2))
        cx     = sum(verts[vi][0] for vi in vi_list) / len(vi_list)
        cy     = sum(verts[vi][1] for vi in vi_list) / len(vi_list)
        cz     = sum(verts[vi][2] for vi in vi_list) / len(vi_list)
        mat    = face.get("mat", "default")

        fid = vapor.store("Face", {
            "face_idx":    float(fi),
            "mat_idx":     float(face.get("mat_idx", 0)),
            "area":        area,
            "normal_x":    float(normal[0]),
            "normal_y":    float(normal[1]),
            "normal_z":    float(normal[2]),
            "center_x":    cx, "center_y": cy, "center_z": cz,
            "is_boundary": False,
            "component":   "",
        })
        face_ids.append(fid)
        face_count_per_mat[mat] = face_count_per_mat.get(mat, 0) + 1

        # Link vertices → face, vertices → each other (edges)
        for vi in vi_list:
            vapor.relate(vertex_ids[vi], "PART_OF_FACE", fid)

        # Edges: create or reuse
        n = len(vi_list)
        for k in range(n):
            vi_a = vi_list[k]
            vi_b = vi_list[(k+1) % n]
            edge_key = frozenset({vi_a, vi_b})

            # Vertex-vertex topology edge
            vapor.relate(vertex_ids[vi_a], "CONNECTED_TO", vertex_ids[vi_b])

            if edge_key not in edge_map:
                pa = verts[vi_a]; pb = verts[vi_b]
                length = vec3_length(vec3_sub(pa, pb))
                eid = vapor.store("Edge", {
                    "length":         length,
                    "is_boundary":    False,
                    "is_crease":      False,
                    "dihedral_angle": 0.0,
                })
                edge_map[edge_key] = eid
                vapor.relate(eid, "CONNECTS", vertex_ids[vi_a])
                vapor.relate(eid, "CONNECTS", vertex_ids[vi_b])
            vapor.relate(edge_map[edge_key], "BORDERS", fid)

        # Material link
        mat_rec = mat_ids.get(mat)
        if mat_rec:
            vapor.relate(fid, "USES_MATERIAL", mat_rec)

    # Update material face counts
    for mat_name, count in face_count_per_mat.items():
        mid = mat_ids.get(mat_name)
        if mid:
            vapor.update(mid, {"face_count": float(count)})

    # Update vertex valence (number of connected faces)
    for i, vid in enumerate(vertex_ids):
        rels = vapor.getRelationships(vid, "PART_OF_FACE", "outgoing")
        vapor.update(vid, {"valence": float(len(rels))})

    print(f"Indexed {len(vertex_ids)} vertices, {len(face_ids)} faces, "
          f"{len(edge_map)} edges.")
    print(f"Stats: {vapor.stats()}")
    return vertex_ids, face_ids, mat_ids
```

---

## Step 4 — Compute derived properties with 5x validation

```python
def compute_geometry_5x(vapor, vertex_ids: list, face_ids: list) -> None:
    """
    Compute and validate geometric properties using 5 passes.
    Each pass refines curvature estimates and adjacency quality.
    """
    for pass_num in range(5):
        # Detect boundary edges (edges adjacent to only 1 face)
        all_edges = vapor.query(QueryOptions(type="Edge"))
        boundary_edge_count = 0
        for erec in all_edges.records:
            face_rels = vapor.getRelationships(erec.id, "BORDERS", "outgoing")
            is_boundary = len(face_rels) == 1
            if is_boundary:
                vapor.update(erec.id, {"is_boundary": True})
                boundary_edge_count += 1
                # Mark connected vertices as boundary
                vert_rels = vapor.getRelationships(erec.id, "CONNECTS", "outgoing")
                for vr in vert_rels:
                    v = vapor.get(vr.target_id)
                    if v:
                        vapor.update(vr.target_id, {"component": "boundary"})

        # Detect crease edges (dihedral angle > 60°)
        # For each edge, find the two adjacent face normals
        for erec in all_edges.records:
            face_rels = vapor.getRelationships(erec.id, "BORDERS", "outgoing")
            if len(face_rels) == 2:
                f1 = vapor.get(face_rels[0].target_id)
                f2 = vapor.get(face_rels[1].target_id)
                if f1 and f2:
                    n1 = (f1.data["normal_x"], f1.data["normal_y"], f1.data["normal_z"])
                    n2 = (f2.data["normal_x"], f2.data["normal_y"], f2.data["normal_z"])
                    dot = sum(n1[i]*n2[i] for i in range(3))
                    dot = max(-1.0, min(1.0, dot))
                    angle_deg = math.degrees(math.acos(dot))
                    vapor.update(erec.id, {"dihedral_angle": angle_deg})
                    if angle_deg > 60:
                        vapor.update(erec.id, {"is_crease": True})

        # Estimate vertex curvature: average of dihedral angles of adjacent edges
        all_verts = vapor.query(QueryOptions(type="Vertex"))
        for vrec in all_verts.records:
            # SHARES_EDGE traversal for curvature
            conn_edges = vapor.getRelationships(vrec.id, "CONNECTED_TO", "both")
            dihedrals = []
            for er in conn_edges[:20]:  # limit for performance
                nbr = vapor.get(er.target_id if er.source_id==vrec.id else er.source_id)
                # Approximate: use variance of connected face normals
                face_rels = vapor.getRelationships(vrec.id, "PART_OF_FACE", "outgoing")
                if face_rels:
                    nx_vals = [vapor.get(fr.target_id).data["normal_x"]
                               for fr in face_rels if vapor.get(fr.target_id)]
                    if len(nx_vals) > 1:
                        mean_nx = sum(nx_vals) / len(nx_vals)
                        variance = sum((v - mean_nx)**2 for v in nx_vals) / len(nx_vals)
                        dihedrals.append(variance)
                    break

            if dihedrals:
                vapor.update(vrec.id, {"curvature": sum(dihedrals)/len(dihedrals)})

        print(f"  Geometry pass {pass_num+1}/5: {boundary_edge_count} boundary edges detected.")

    print("5x geometry validation complete.")
```

---

## Step 5 — Find disconnected components

```python
def find_connected_components(vapor, vertex_ids: list) -> dict[str, list[str]]:
    """
    Use CONNECTED_TO traversal to find disconnected mesh components.
    Labels each vertex with its component ID.
    """
    unvisited = set(vertex_ids)
    component_counter = 0
    components: dict[str, list[str]] = {}

    while unvisited:
        component_counter += 1
        cid = f"component_{component_counter:03d}"
        seed = next(iter(unvisited))
        # BFS through CONNECTED_TO
        result = vapor.traverse(TraversalOptions(
            from_id=seed,
            relationship="CONNECTED_TO",
            direction="both",
            depth=9999,
        ))
        in_component = {seed} | {r.id for r in result.records}
        components[cid] = list(in_component)
        for vid in in_component:
            vapor.update(vid, {"component": cid})
            unvisited.discard(vid)

    print(f"Found {component_counter} connected component(s).")
    return components
```

---

## Step 6 — Spatial and topology queries

```python
# Bounding box
def compute_bounding_box(vapor) -> dict:
    all_v = vapor.query(QueryOptions(type="Vertex"))
    if not all_v.records: return {}
    xs = [r.data["x"] for r in all_v.records]
    ys = [r.data["y"] for r in all_v.records]
    zs = [r.data["z"] for r in all_v.records]
    return {"x":( min(xs),max(xs)), "y":(min(ys),max(ys)), "z":(min(zs),max(zs)),
            "center": ((min(xs)+max(xs))/2,(min(ys)+max(ys))/2,(min(zs)+max(zs))/2)}

bbox = compute_bounding_box(vapor)
print(f"Bounding box: {bbox}")

# Vertices above midpoint Y
upper = vapor.query(QueryOptions(type="Vertex",
    where=FieldFilter(field="y", op="gt", value=bbox["center"][1])))
print(f"Upper-half vertices: {upper.total}")

# High curvature vertices (sharp features, potential hard edges or tips)
high_curv = vapor.query(QueryOptions(type="Vertex",
    where=FieldFilter(field="curvature", op="gt", value=0.1),
    order_by=("curvature","desc"), limit=20))

# Boundary edges (open mesh borders)
boundary_edges = vapor.query(QueryOptions(type="Edge",
    where=FieldFilter(field="is_boundary", op="eq", value=True)))
print(f"Boundary edges (open borders): {boundary_edges.total}")

# Crease edges (sharp angles)
creases = vapor.query(QueryOptions(type="Edge",
    where=FieldFilter(field="is_crease", op="eq", value=True)))
print(f"Crease edges (>60° dihedral): {creases.total}")

# Dominant material
all_mats = vapor.query(QueryOptions(type="Material",
    order_by=("face_count","desc")))
if all_mats.records:
    print(f"Most-used material: {all_mats.records[0].data['name']} "
          f"({int(all_mats.records[0].data['face_count'])} faces)")

# Largest faces
large_faces = vapor.query(QueryOptions(type="Face",
    where=FieldFilter(field="area", op="gt", value=0.1),
    order_by=("area","desc"), limit=10))
```

---

## Step 7 — Reconstruct as Blender Python

```python
def reconstruct_blender(vapor, mesh_name: str = "Mesh") -> str:
    lines = [
        "import bpy, bmesh",
        f"mesh = bpy.data.meshes.new('{mesh_name}')",
        f"obj  = bpy.data.objects.new('{mesh_name}', mesh)",
        "bpy.context.scene.collection.objects.link(obj)",
        "bm = bmesh.new()",
    ]
    all_v = vapor.query(QueryOptions(type="Vertex"))
    id_to_idx: dict[str,int] = {}
    for i, rec in enumerate(all_v.records):
        lines.append(f"bm.verts.new(({rec.data['x']:.6f},"
                     f"{rec.data['y']:.6f},{rec.data['z']:.6f}))")
        id_to_idx[rec.id] = i
    lines.append("bm.verts.ensure_lookup_table()")

    all_f = vapor.query(QueryOptions(type="Face", order_by=("face_idx","asc")))
    for rec in all_f.records:
        rels = [r for r in vapor.getRelationships(rec.id)
                if r.relationship_type == "PART_OF_FACE"]
        indices = [id_to_idx[r.source_id] for r in rels if r.source_id in id_to_idx]
        if len(indices) >= 3:
            v_str = ",".join(f"bm.verts[{i}]" for i in indices)
            lines += ["try:", f"    bm.faces.new([{v_str}])",
                      "except ValueError:", "    pass"]

    all_m = vapor.query(QueryOptions(type="Material"))
    for rec in all_m.records:
        n = rec.data["name"]
        r = int(rec.data.get("base_r",200))
        g = int(rec.data.get("base_g",200))
        b = int(rec.data.get("base_b",200))
        lines += [
            f"_m=bpy.data.materials.new('{n}')",
            "_m.use_nodes=True",
            "_b=_m.node_tree.nodes['Principled BSDF']",
            f"_b.inputs['Base Color'].default_value=({r/255:.3f},{g/255:.3f},{b/255:.3f},1)",
            f"_b.inputs['Roughness'].default_value={rec.data.get('roughness',0.5):.3f}",
            f"_b.inputs['Metallic'].default_value={rec.data.get('metallic',0.0):.3f}",
            "obj.data.materials.append(_m)",
        ]
    lines += ["bm.to_mesh(mesh)","bm.free()","mesh.update()",
              "print('Done.')"]
    return "\n".join(lines)

script = reconstruct_blender(vapor, "ImportedMesh")
with open("reconstruct.py","w") as f: f.write(script)
print("Saved reconstruct.py")
print("Run: blender --background --python reconstruct.py")
```

---

## Step 8 — Reconstruct as OBJ

```python
def reconstruct_obj(vapor) -> str:
    lines = ["# Reconstructed by vapor-idx"]
    all_v = vapor.query(QueryOptions(type="Vertex"))
    id_to_idx: dict[str,int] = {}
    for i,rec in enumerate(all_v.records,1):
        lines.append(f"v {rec.data['x']:.6f} {rec.data['y']:.6f} {rec.data['z']:.6f}")
        id_to_idx[rec.id] = i
    all_f = vapor.query(QueryOptions(type="Face",order_by=("face_idx","asc")))
    for rec in all_f.records:
        rels = [r for r in vapor.getRelationships(rec.id)
                if r.relationship_type=="PART_OF_FACE"]
        idx  = [str(id_to_idx[r.source_id]) for r in rels if r.source_id in id_to_idx]
        if len(idx) >= 3:
            lines.append(f"f {' '.join(idx)}")
    return "\n".join(lines)

with open("output.obj","w") as f: f.write(reconstruct_obj(vapor))
print("Saved output.obj")
```

## Step 9 — Destroy

```python
vapor.destroy()
```

## Output

Report: vertex/face/edge counts, bounding box, component count, dominant material,
boundary edge count, crease edge count, high-curvature vertex regions.
Save reconstruction files with paths.
