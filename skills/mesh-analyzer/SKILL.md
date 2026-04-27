# Mesh Analyzer Skill

## Purpose

Use this skill to analyze, understand, or reconstruct 3D mesh data using
vapor-idx. Vertices, faces, and materials are indexed as typed records; Claude
traverses the topology and can reconstruct a Blender Python script or OBJ file
with no render engine required.

## When to trigger

- "Analyze this OBJ/STL/GLTF model and describe its structure"
- "Find all vertices above the midpoint of this mesh"
- "Which material is used by the most faces?"
- "Reconstruct this model as a Blender Python script"
- "Find all isolated vertex clusters"
- Any task involving understanding or reconstructing 3D geometry

## Environment

Python computer-use. Install if needed:
```bash
pip install vapor-idx
```

## Step-by-step instructions

### Step 1 — Declare the mesh schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

vapor = create_vapor({
    "types": {
        "Vertex": {
            "fields": {
                "x":        {"type": "number", "index": "range"},
                "y":        {"type": "number", "index": "range"},
                "z":        {"type": "number", "index": "range"},
                "normal_x": {"type": "number", "index": "none"},
                "normal_y": {"type": "number", "index": "none"},
                "normal_z": {"type": "number", "index": "none"},
                "u":        {"type": "number", "index": "range"},
                "v":        {"type": "number", "index": "range"},
                "mat_idx":  {"type": "number", "index": "exact"},
            },
            "relationships": {
                "CONNECTED_TO": {
                    "targetTypes": ["Vertex"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
                "PART_OF_FACE": {
                    "targetTypes": ["Face"],
                    "directed":    True,
                    "cardinality": "many-to-many",
                },
            },
        },
        "Face": {
            "fields": {
                "face_idx":  {"type": "number", "index": "range"},
                "mat_idx":   {"type": "number", "index": "exact"},
                "area":      {"type": "number", "index": "range"},
                "normal_x":  {"type": "number", "index": "none"},
                "normal_y":  {"type": "number", "index": "none"},
                "normal_z":  {"type": "number", "index": "none"},
            },
            "relationships": {
                "ADJACENT_TO": {
                    "targetTypes": ["Face"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
            },
        },
        "Material": {
            "fields": {
                "name":      {"type": "string", "index": "exact"},
                "base_r":    {"type": "number", "index": "range"},
                "base_g":    {"type": "number", "index": "range"},
                "base_b":    {"type": "number", "index": "range"},
                "roughness": {"type": "number", "index": "range"},
                "metallic":  {"type": "number", "index": "range"},
            },
            "relationships": {},
        },
    },
})
```

### Step 2 — Parse and index an OBJ file

```python
def index_obj(vapor, obj_text: str) -> tuple[list[str], list[str]]:
    """
    Parse OBJ text and index into vapor.
    Returns (vertex_ids, face_ids) lists indexed by position.
    """
    vertices: list[tuple[float,float,float]] = []
    normals:  list[tuple[float,float,float]] = []
    uvs:      list[tuple[float,float]]       = []
    mat_names: list[str]                     = []
    current_mat_idx = 0
    vertex_ids: list[str] = []
    face_ids:   list[str] = []

    for line in obj_text.splitlines():
        p = line.strip().split()
        if not p or p[0].startswith('#'):
            continue
        if p[0] == 'v':
            vertices.append((float(p[1]), float(p[2]), float(p[3])))
        elif p[0] == 'vn':
            normals.append((float(p[1]), float(p[2]), float(p[3])))
        elif p[0] == 'vt':
            uvs.append((float(p[1]), float(p[2])))
        elif p[0] == 'usemtl':
            name = p[1]
            if name not in mat_names:
                mat_names.append(name)
                vapor.store("Material", {
                    "name": name, "base_r": 0.8, "base_g": 0.8, "base_b": 0.8,
                    "roughness": 0.5, "metallic": 0.0,
                })
            current_mat_idx = mat_names.index(name)
        elif p[0] == 'f':
            face_verts = []
            for tok in p[1:]:
                parts = tok.split('/')
                vi = int(parts[0]) - 1
                vt = int(parts[1]) - 1 if (len(parts) > 1 and parts[1]) else -1
                vn = int(parts[2]) - 1 if (len(parts) > 2 and parts[2]) else -1
                face_verts.append((vi, vt, vn))

            # Store face
            fid = vapor.store("Face", {
                "face_idx": len(face_ids),
                "mat_idx":  current_mat_idx,
                "area":     0.0,
                "normal_x": 0.0, "normal_y": 0.0, "normal_z": 0.0,
            })
            face_ids.append(fid)

            # Store any vertices not yet indexed, then link
            vert_ids_in_face: list[str] = []
            for vi, vt, vn in face_verts:
                # Extend list if needed
                while len(vertex_ids) <= vi:
                    vertex_ids.append("")
                if not vertex_ids[vi]:
                    x, y, z = vertices[vi]
                    nx = ny = nz = 0.0
                    if 0 <= vn < len(normals):
                        nx, ny, nz = normals[vn]
                    u = v_coord = 0.0
                    if 0 <= vt < len(uvs):
                        u, v_coord = uvs[vt]
                    vertex_ids[vi] = vapor.store("Vertex", {
                        "x": x, "y": y, "z": z,
                        "normal_x": nx, "normal_y": ny, "normal_z": nz,
                        "u": u, "v": v_coord, "mat_idx": current_mat_idx,
                    })
                vert_ids_in_face.append(vertex_ids[vi])

            # Relate vertices to face and to each other
            for vid in vert_ids_in_face:
                vapor.relate(vid, "PART_OF_FACE", fid)
            n = len(vert_ids_in_face)
            for j in range(n):
                vapor.relate(vert_ids_in_face[j], "CONNECTED_TO",
                             vert_ids_in_face[(j + 1) % n])

    return vertex_ids, face_ids

# Usage:
obj_text = open("model.obj").read()
vertex_ids, face_ids = index_obj(vapor, obj_text)
print(vapor.stats())
```

### Step 3 — Query and analyse

```python
# Vertices in the upper half of the model (positive Y)
upper = vapor.query(QueryOptions(
    type="Vertex",
    where=FieldFilter(field="y", op="gt", value=0.0),
))
print(f"Upper-half vertices: {upper.total}")

# All faces using material index 2
metal_faces = vapor.query(QueryOptions(
    type="Face",
    where=FieldFilter(field="mat_idx", op="eq", value=2),
))
print(f"Metal faces: {metal_faces.total}")

# Large faces (area > threshold)
large_faces = vapor.query(QueryOptions(
    type="Face",
    where=FieldFilter(field="area", op="gt", value=0.5),
    order_by=("area", "desc"),
))

# Vertices within a spatial bounding box
in_box = vapor.query(QueryOptions(
    type="Vertex",
    where=[
        FieldFilter(field="x", op="gte", value=-1.0),
        FieldFilter(field="x", op="lte", value=1.0),
        FieldFilter(field="y", op="gte", value=-1.0),
        FieldFilter(field="y", op="lte", value=1.0),
    ],
))
```

### Step 4 — Traverse topology

```python
# Find all vertices connected to a specific vertex (neighbourhood)
seed_id = vertex_ids[0]
neighbours = vapor.traverse(TraversalOptions(
    from_id=seed_id,
    relationship="CONNECTED_TO",
    direction="both",
    depth=3,
))
print(f"Within 3 edges of vertex 0: {len(neighbours.records)} vertices")

# Find path between two vertices
from vapor_idx import PathOptions
path = vapor.find_path(PathOptions(
    from_id=vertex_ids[0],
    to_id=vertex_ids[-1],
    relationship="CONNECTED_TO",
    max_depth=20,
))
if path:
    print(f"Shortest path length: {len(path) - 1} edges")
```

### Step 5 — Reconstruct as Blender Python script

```python
def reconstruct_blender(vapor, mesh_name: str = "Mesh") -> str:
    lines = [
        "import bpy, bmesh",
        f"mesh = bpy.data.meshes.new('{mesh_name}')",
        f"obj  = bpy.data.objects.new('{mesh_name}', mesh)",
        "bpy.context.scene.collection.objects.link(obj)",
        "bm = bmesh.new()",
    ]

    all_verts = vapor.query(QueryOptions(type="Vertex"))
    id_to_idx: dict[str, int] = {}
    for i, rec in enumerate(all_verts.records):
        x, y, z = rec.data["x"], rec.data["y"], rec.data["z"]
        lines.append(f"bm.verts.new(({x:.6f}, {y:.6f}, {z:.6f}))")
        id_to_idx[rec.id] = i

    lines.append("bm.verts.ensure_lookup_table()")

    all_faces = vapor.query(QueryOptions(type="Face", order_by=("face_idx","asc")))
    for rec in all_faces.records:
        rels = vapor.get_relationships(rec.id)
        part_of_rels = [r for r in rels if r.relationship_type == "PART_OF_FACE"]
        vert_indices = [
            id_to_idx[r.source_id]
            for r in part_of_rels
            if r.source_id in id_to_idx
        ]
        if len(vert_indices) >= 3:
            verts_str = ", ".join(f"bm.verts[{i}]" for i in vert_indices)
            lines.extend([
                "try:",
                f"    bm.faces.new([{verts_str}])",
                "except ValueError:",
                "    pass  # duplicate face",
            ])

    all_mats = vapor.query(QueryOptions(type="Material"))
    for rec in all_mats.records:
        name = rec.data["name"]
        r    = rec.data.get("base_r", 0.8)
        g    = rec.data.get("base_g", 0.8)
        b    = rec.data.get("base_b", 0.8)
        rough = rec.data.get("roughness", 0.5)
        metal = rec.data.get("metallic", 0.0)
        lines += [
            f"_mat = bpy.data.materials.new('{name}')",
            "_mat.use_nodes = True",
            "_bsdf = _mat.node_tree.nodes['Principled BSDF']",
            f"_bsdf.inputs['Base Color'].default_value = ({r}, {g}, {b}, 1.0)",
            f"_bsdf.inputs['Roughness'].default_value = {rough}",
            f"_bsdf.inputs['Metallic'].default_value = {metal}",
            "obj.data.materials.append(_mat)",
        ]

    lines += [
        "bm.to_mesh(mesh)",
        "bm.free()",
        "mesh.update()",
        "print('Reconstruction complete.')",
    ]
    return "\n".join(lines)

script = reconstruct_blender(vapor, "ImportedMesh")
with open("reconstruct.py", "w") as f:
    f.write(script)
print("Saved reconstruct.py — run with: blender --background --python reconstruct.py")
```

### Step 6 — Reconstruct as OBJ

```python
def reconstruct_obj(vapor) -> str:
    lines = ["# Reconstructed by vapor-idx"]
    all_verts = vapor.query(QueryOptions(type="Vertex"))
    id_to_idx: dict[str, int] = {}
    for i, rec in enumerate(all_verts.records, start=1):
        x, y, z = rec.data["x"], rec.data["y"], rec.data["z"]
        lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")
        id_to_idx[rec.id] = i
    all_faces = vapor.query(QueryOptions(type="Face", order_by=("face_idx","asc")))
    for rec in all_faces.records:
        rels = [r for r in vapor.get_relationships(rec.id)
                if r.relationship_type == "PART_OF_FACE"]
        indices = [str(id_to_idx[r.source_id]) for r in rels
                   if r.source_id in id_to_idx]
        if len(indices) >= 3:
            lines.append(f"f {' '.join(indices)}")
    return "\n".join(lines)

obj_output = reconstruct_obj(vapor)
with open("output.obj", "w") as f:
    f.write(obj_output)
print("Saved output.obj")
```

### Step 7 — Destroy when done

```python
vapor.destroy()
```

## Output

Report on the mesh structure (vertex count, face count, materials, bounding box).
Save any reconstruction files and provide their filenames.
