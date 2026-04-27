# vapor-idx — 3D Mesh Indexing Guide

## Overview

vapor-idx can index 3D mesh data at the vertex, edge, face, bone, and material
level — the same hierarchy that Blender uses internally. Once indexed, Claude can
traverse the mesh topology, query by spatial position or material, and reconstruct
the mesh as a Blender Python script, OBJ file, or any other format.

This is 3D understanding without a render engine. The index is the scene graph.

---

## The mesh schema

```typescript
import { createVapor } from 'vapor-idx';

const vapor = createVapor({
  types: {
    Vertex: {
      fields: {
        // Spatial position — range-indexed for spatial queries
        x:             { type: 'number', index: 'range' },
        y:             { type: 'number', index: 'range' },
        z:             { type: 'number', index: 'range' },
        // Surface normal — stored but not queried directly
        normalX:       { type: 'number', index: 'none' },
        normalY:       { type: 'number', index: 'none' },
        normalZ:       { type: 'number', index: 'none' },
        // UV coordinates — range-indexed for texture queries
        u:             { type: 'number', index: 'range' },
        v:             { type: 'number', index: 'range' },
        // Material assignment — exact-indexed for material queries
        materialIndex: { type: 'number', index: 'exact' },
        // Weight sum for skinned meshes
        weightSum:     { type: 'number', index: 'range' },
      },
      relationships: {
        CONNECTED_TO: {
          targetTypes: ['Vertex'],
          directed:    false,
          cardinality: 'many-to-many',
        },
        PART_OF_FACE: {
          targetTypes: ['Face'],
          directed:    true,
          cardinality: 'many-to-many',
        },
      },
    },

    Face: {
      fields: {
        // Face index in the original mesh
        faceIndex:     { type: 'number', index: 'range' },
        materialIndex: { type: 'number', index: 'exact' },
        // Face area (computed from vertices)
        area:          { type: 'number', index: 'range' },
        // Smooth shading group (0 = flat)
        smoothGroup:   { type: 'number', index: 'exact' },
        // Face normal components
        normalX:       { type: 'number', index: 'none'  },
        normalY:       { type: 'number', index: 'none'  },
        normalZ:       { type: 'number', index: 'none'  },
      },
      relationships: {
        ADJACENT_TO: {
          targetTypes: ['Face'],
          directed:    false,
          cardinality: 'many-to-many',
        },
        USES_MATERIAL: {
          targetTypes: ['Material'],
          directed:    true,
          cardinality: 'many-to-one',
        },
      },
    },

    Material: {
      fields: {
        name:         { type: 'string', index: 'exact'  },
        // PBR properties
        baseColorR:   { type: 'number', index: 'range'  },
        baseColorG:   { type: 'number', index: 'range'  },
        baseColorB:   { type: 'number', index: 'range'  },
        roughness:    { type: 'number', index: 'range'  },
        metallic:     { type: 'number', index: 'range'  },
        emission:     { type: 'number', index: 'range'  },
        // Texture file references
        diffuseMap:   { type: 'string', index: 'exact'  },
        normalMap:    { type: 'string', index: 'exact'  },
        roughnessMap: { type: 'string', index: 'exact'  },
      },
      relationships: {},
    },

    Bone: {
      fields: {
        name:     { type: 'string', index: 'exact'  },
        headX:    { type: 'number', index: 'range'  },
        headY:    { type: 'number', index: 'range'  },
        headZ:    { type: 'number', index: 'range'  },
        tailX:    { type: 'number', index: 'range'  },
        tailY:    { type: 'number', index: 'range'  },
        tailZ:    { type: 'number', index: 'range'  },
        roll:     { type: 'number', index: 'range'  },
        length:   { type: 'number', index: 'range'  },
      },
      relationships: {
        PARENT_OF: {
          targetTypes: ['Bone'],
          directed:    true,
          cardinality: 'one-to-many',
        },
        INFLUENCES: {
          targetTypes: ['Vertex'],
          directed:    true,
          cardinality: 'many-to-many',
        },
      },
    },
  },
});
```

---

## Indexing from OBJ format

OBJ is the simplest 3D format to parse. No external library needed.

```python
from vapor_idx import create_vapor, QueryOptions

def index_obj(vapor, obj_text: str) -> dict:
    """
    Parse and index an OBJ file from its text content.
    Returns dicts of vertex and face IDs.
    """
    vertices = []   # list of (x, y, z)
    normals  = []   # list of (nx, ny, nz)
    uvs      = []   # list of (u, v)
    faces    = []   # list of [(v, vt, vn), ...]
    materials: dict[str, str] = {}  # material name → vapor ID

    current_material_idx = 0
    vertex_ids: list[str] = []
    face_ids:   list[str] = []

    for line in obj_text.splitlines():
        parts = line.strip().split()
        if not parts or parts[0].startswith('#'):
            continue
        if parts[0] == 'v':
            vertices.append(tuple(map(float, parts[1:4])))
        elif parts[0] == 'vn':
            normals.append(tuple(map(float, parts[1:4])))
        elif parts[0] == 'vt':
            uvs.append(tuple(map(float, parts[1:3])))
        elif parts[0] == 'usemtl':
            mat_name = parts[1]
            if mat_name not in materials:
                mat_id = vapor.store('Material', {'name': mat_name, 'roughness': 0.5, 'metallic': 0.0, 'baseColorR': 0.8, 'baseColorG': 0.8, 'baseColorB': 0.8, 'emission': 0.0, 'diffuseMap': '', 'normalMap': '', 'roughnessMap': ''})
                materials[mat_name] = mat_id
                current_material_idx = len(materials) - 1
        elif parts[0] == 'f':
            face_verts = []
            for vert_str in parts[1:]:
                indices = vert_str.split('/')
                vi = int(indices[0]) - 1
                vt = int(indices[1]) - 1 if len(indices) > 1 and indices[1] else -1
                vn = int(indices[2]) - 1 if len(indices) > 2 and indices[2] else -1
                face_verts.append((vi, vt, vn))
            faces.append((face_verts, current_material_idx))

    # Store vertices
    for i, (x, y, z) in enumerate(vertices):
        nx = ny = nz = 0.0
        vid = vapor.store('Vertex', {
            'x': x, 'y': y, 'z': z,
            'normalX': nx, 'normalY': ny, 'normalZ': nz,
            'u': 0.0, 'v': 0.0,
            'materialIndex': 0, 'weightSum': 1.0,
        })
        vertex_ids.append(vid)

    # Store faces and link vertices
    for face_idx, (face_verts, mat_idx) in enumerate(faces):
        fid = vapor.store('Face', {
            'faceIndex': face_idx,
            'materialIndex': mat_idx,
            'area': 0.0,  # computed separately
            'smoothGroup': 0,
            'normalX': 0.0, 'normalY': 0.0, 'normalZ': 0.0,
        })
        face_ids.append(fid)

        # Link vertices to face and to each other (edges)
        vert_ids_for_face = [vertex_ids[vi] for vi, _, _ in face_verts]
        for vid in vert_ids_for_face:
            vapor.relate(vid, 'PART_OF_FACE', fid)
        for j in range(len(vert_ids_for_face)):
            v1 = vert_ids_for_face[j]
            v2 = vert_ids_for_face[(j + 1) % len(vert_ids_for_face)]
            vapor.relate(v1, 'CONNECTED_TO', v2)

    return {'vertex_ids': vertex_ids, 'face_ids': face_ids, 'material_ids': materials}
```

---

## Querying mesh data

### Find all vertices in a spatial bounding box

```typescript
const verticesInBox = vapor.query({
  type:  'Vertex',
  where: [
    { field: 'x', op: 'gte', value: -1.0 },
    { field: 'x', op: 'lte', value:  1.0 },
    { field: 'y', op: 'gte', value: -1.0 },
    { field: 'y', op: 'lte', value:  1.0 },
    { field: 'z', op: 'gte', value:  0.0 },
  ],
  logic: 'AND',
});
```

### Find all faces using a specific material

```typescript
const metalFaces = vapor.query({
  type:  'Face',
  where: { field: 'materialIndex', op: 'eq', value: 2 },
});
```

### Find highly metallic materials

```typescript
const metallicMaterials = vapor.query({
  type:  'Material',
  where: { field: 'metallic', op: 'gt', value: 0.8 },
  orderBy: { field: 'metallic', direction: 'desc' },
});
```

### Traverse the bone hierarchy

```typescript
const boneChain = vapor.traverse({
  from:         rootBoneId,
  relationship: 'PARENT_OF',
  direction:    'outgoing',
  depth:        10,
});
```

---

## Reconstructing Blender Python from the index

This is the cross-modal reconstruction step: from an indexed mesh, emit a Blender
Python script that recreates the mesh exactly.

```python
def reconstruct_as_blender_python(vapor, mesh_name: str = "ImportedMesh") -> str:
    """
    Emit a Blender Python script from the indexed mesh.
    The script creates the mesh when run inside Blender (or headless via bpy).
    """
    from vapor_idx import QueryOptions
    
    lines = [
        "import bpy",
        "import bmesh",
        "from mathutils import Vector",
        "",
        f"# Reconstructed by vapor-idx from indexed mesh data",
        f"mesh = bpy.data.meshes.new('{mesh_name}')",
        f"obj  = bpy.data.objects.new('{mesh_name}', mesh)",
        "bpy.context.scene.collection.objects.link(obj)",
        "bm = bmesh.new()",
        "",
    ]

    # Collect all vertices ordered by their index
    all_verts = vapor.query(QueryOptions(type='Vertex'))
    id_to_idx: dict[str, int] = {}
    
    lines.append("# Vertices")
    for i, rec in enumerate(all_verts.records):
        x, y, z = rec.data['x'], rec.data['y'], rec.data['z']
        lines.append(f"bm.verts.new(({x}, {y}, {z}))")
        id_to_idx[rec.id] = i

    lines.extend([
        "bm.verts.ensure_lookup_table()",
        "",
        "# Faces",
    ])

    all_faces = vapor.query(QueryOptions(type='Face'))
    for rec in all_faces.records:
        # Get vertices for this face via relationships
        face_verts = vapor.get_relationships(rec.id, direction='incoming')
        # Filter to PART_OF_FACE relationships
        vert_rels = [r for r in vapor.get_relationships(rec.id) if r.relationship_type == 'PART_OF_FACE']
        vert_indices = []
        for rel in vert_rels:
            source_idx = id_to_idx.get(rel.source_id)
            if source_idx is not None:
                vert_indices.append(source_idx)
        if len(vert_indices) >= 3:
            verts_str = ', '.join(f"bm.verts[{i}]" for i in vert_indices)
            lines.append(f"bm.faces.new([{verts_str}])")

    lines.extend([
        "",
        "bm.to_mesh(mesh)",
        "bm.free()",
        "mesh.update()",
        "",
        "# Materials",
    ])

    all_mats = vapor.query(QueryOptions(type='Material'))
    for rec in all_mats.records:
        name = rec.data['name']
        r = rec.data.get('baseColorR', 0.8)
        g = rec.data.get('baseColorG', 0.8)
        b = rec.data.get('baseColorB', 0.8)
        roughness = rec.data.get('roughness', 0.5)
        metallic  = rec.data.get('metallic', 0.0)
        lines.extend([
            f"mat_{name} = bpy.data.materials.new(name='{name}')",
            f"mat_{name}.use_nodes = True",
            f"bsdf = mat_{name}.node_tree.nodes['Principled BSDF']",
            f"bsdf.inputs['Base Color'].default_value = ({r}, {g}, {b}, 1.0)",
            f"bsdf.inputs['Roughness'].default_value = {roughness}",
            f"bsdf.inputs['Metallic'].default_value = {metallic}",
            f"obj.data.materials.append(mat_{name})",
        ])

    lines.extend([
        "",
        "print('Mesh reconstructed from vapor-idx.')",
    ])

    return '\n'.join(lines)
```

---

## Reconstructing OBJ from the index

```python
def reconstruct_as_obj(vapor) -> str:
    """Emit a Wavefront OBJ file from the indexed mesh."""
    from vapor_idx import QueryOptions
    
    lines = ["# Reconstructed by vapor-idx"]

    # Materials
    all_mats = vapor.query(QueryOptions(type='Material'))
    for rec in all_mats.records:
        lines.append(f"mtllib {rec.data['name']}.mtl")

    # Vertices
    all_verts = vapor.query(QueryOptions(type='Vertex', order_by=('x', 'asc')))
    id_to_idx: dict[str, int] = {}
    for i, rec in enumerate(all_verts.records, start=1):
        x, y, z = rec.data['x'], rec.data['y'], rec.data['z']
        lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")
        id_to_idx[rec.id] = i

    # Faces  
    all_faces = vapor.query(QueryOptions(type='Face', order_by=('faceIndex', 'asc')))
    for rec in all_faces.records:
        vert_rels = [
            r for r in vapor.get_relationships(rec.id)
            if r.relationship_type == 'PART_OF_FACE'
        ]
        indices = [str(id_to_idx[r.source_id]) for r in vert_rels if r.source_id in id_to_idx]
        if len(indices) >= 3:
            lines.append(f"f {' '.join(indices)}")

    return '\n'.join(lines)
```

---

## Memory guidance for large meshes

A 50,000 vertex mesh with 100,000 faces:

- Vertices: 50,000 × (~500 bytes record + 4 × ~48 bytes range) = ~50,000 × 692 = ~34 MB
- Faces: 100,000 × (~300 bytes) = ~30 MB
- Relationships: ~300,000 edges × ~200 bytes = ~60 MB

Total: roughly **~124 MB** for a medium-complexity mesh.

For large meshes (500K+ vertices), consider:
- Indexing only a coarse Level of Detail (LOD) for analysis
- Processing in spatial tiles (octree subdivision)
- Using `index: 'none'` on normal vector fields if not querying by normal
- Processing one mesh object at a time and destroying/rebuilding per object

Blender's own offload scripts (pure `bpy` + `foreach_get`) can extract mesh data
into NumPy arrays for fast iteration before feeding into vapor-idx.
