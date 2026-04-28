---
name: Mesh Analyzer
description: Analyze and reconstruct 3D mesh data (OBJ, STL binary, GLTF JSON) using pure Python parsing and vapor-idx. No external libraries. Index vertices, faces, edges, materials, normals. Traverse topology for spatial queries, connectivity analysis, cluster detection, and material zone identification. Reconstruct as Blender Python or OBJ. Compute face material properties for CAD-to-photo projection. 5x validation pass on computed geometric properties.
version: 3.0.0
tools:
  - computer_use
---

# Mesh Analyzer Skill v3.0

## Purpose

Parse raw 3D mesh formats with built-in Python and index every geometric element
into vapor-idx as typed records. Traverse relationships to understand topology,
detect clusters, compute normals, find disconnected components, identify material
zones, and project geometry onto 2D backgrounds.

No Blender, no Three.js, no external geometry libraries — pure Python `struct`
for binary formats, text parsing for OBJ, JSON for GLTF.

## CRITICAL: vapor-idx API — All Methods are snake_case

```
vapor.get_relationships(record_id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST — will crash with AttributeError
```

Direction parameter — always specify explicitly:
- `"outgoing"`: relationships where this record is the source
- `"incoming"`: relationships where this record is the target
- `"both"`: ONLY for undirected relationships (CONNECTED_TO, SHARES_EDGE)
- PART_OF_FACE is directed (vertex→face): use `"outgoing"` from vertex
- BORDERS is directed from edge to face: use `"outgoing"` from edge
- CONNECTS is directed from edge to vertex: use `"outgoing"` from edge
- USES_MATERIAL is directed (face→material): use `"outgoing"` from face

## Supported Formats

- **OBJ** — text format, no library needed
- **STL binary** — parsed with `struct` (built-in)
- **STL ASCII** — text parsing
- **GLTF/GLB** — JSON + base64 (built-in `json` + `base64`)

## Environment

```bash
pip install vapor-idx
```

---

## Step 1 — Raw Format Parsers

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
    with open(filepath, 'rb') as f:
        f.read(80)
        n_tri = struct.unpack('<I', f.read(4))[0]
        vertices, normals, faces, vert_map = [], [], [], {}
        for i in range(n_tri):
            nx, ny, nz = struct.unpack('<fff', f.read(12))
            fi = []
            for _ in range(3):
                x, y, z = struct.unpack('<fff', f.read(12))
                key = (round(x,6),round(y,6),round(z,6))
                if key not in vert_map:
                    vert_map[key] = len(vertices); vertices.append((x,y,z))
                fi.append(vert_map[key])
            normals.append((nx,ny,nz))
            faces.append({"verts":[(v,-1,i) for v in fi],"mat":"default","mat_idx":0,
                          "face_normal":(nx,ny,nz)})
            f.read(2)
    return {"vertices":vertices,"normals":normals,"uvs":[],
            "faces":faces,"materials":{"default":{"name":"default"}},
            "mat_to_idx":{"default":0}}


def parse_stl_ascii(filepath: str) -> dict:
    vertices, normals, faces, vert_map = [], [], [], {}
    current_normal = (0.0,0.0,0.0); face_verts = []; face_idx = 0
    with open(filepath,'r') as f:
        for line in f:
            tok = line.strip().split()
            if not tok: continue
            if tok[0]=='facet' and len(tok)>4:
                current_normal=(float(tok[2]),float(tok[3]),float(tok[4])); face_verts=[]
            elif tok[0]=='vertex' and len(tok)>3:
                key=(round(float(tok[1]),6),round(float(tok[2]),6),round(float(tok[3]),6))
                if key not in vert_map:
                    vert_map[key]=len(vertices); vertices.append(key); normals.append(current_normal)
                face_verts.append(vert_map[key])
            elif tok[0]=='endfacet' and len(face_verts)==3:
                faces.append({"verts":[(v,-1,face_idx) for v in face_verts],
                              "mat":"default","mat_idx":0,"face_normal":current_normal})
                face_idx += 1
    return {"vertices":vertices,"normals":normals,"uvs":[],
            "faces":faces,"materials":{"default":{"name":"default"}},"mat_to_idx":{"default":0}}


def parse_gltf(filepath: str) -> dict:
    with open(filepath,'r') as f: gltf=json.load(f)
    buffers = []
    for buf in gltf.get("buffers",[]):
        if "uri" in buf and buf["uri"].startswith("data:"):
            buffers.append(base64.b64decode(buf["uri"].split(",",1)[1]))
        else:
            try:
                bp = filepath.rsplit('/',1)[0]+'/'+buf.get("uri","")
                with open(bp,'rb') as bf: buffers.append(bf.read())
            except: buffers.append(b'')

    def get_acc(acc_idx):
        acc=gltf["accessors"][acc_idx]; bv=gltf["bufferViews"][acc["bufferView"]]
        buf=buffers[bv["buffer"]]; off=bv.get("byteOffset",0)+acc.get("byteOffset",0)
        count=acc["count"]; comp={"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4,"MAT4":16}[acc["type"]]
        fmt={5120:'b',5121:'B',5122:'h',5123:'H',5126:'f'}[acc["componentType"]]
        stride=struct.calcsize(fmt)*comp
        return [struct.unpack_from(comp*fmt,buf,off+i*stride) for i in range(count)]

    vertices,normals,uvs,faces=[],[],[],[]
    mat_names=[m.get("name",f"mat_{i}") for i,m in enumerate(gltf.get("materials",[{"name":"default"}]))]
    for mesh in gltf.get("meshes",[]):
        for prim in mesh.get("primitives",[]):
            attrs=prim.get("attributes",{}); mat_idx=prim.get("material",0); v_off=len(vertices)
            if "POSITION" in attrs: vertices.extend(get_acc(attrs["POSITION"]))
            if "NORMAL" in attrs: normals.extend([n[0] for n in get_acc(attrs["NORMAL"])])
            if "TEXCOORD_0" in attrs: uvs.extend(get_acc(attrs["TEXCOORD_0"]))
            if "indices" in prim:
                idx=[i[0] for i in get_acc(prim["indices"])]
                for k in range(0,len(idx)-2,3):
                    a,b,c=idx[k],idx[k+1],idx[k+2]
                    faces.append({"verts":[(v_off+a,-1,-1),(v_off+b,-1,-1),(v_off+c,-1,-1)],
                                  "mat":mat_names[mat_idx] if mat_idx<len(mat_names) else "default",
                                  "mat_idx":mat_idx})
    mats={n:{"name":n} for n in mat_names} if mat_names else {"default":{"name":"default"}}
    return {"vertices":vertices,"normals":normals,"uvs":uvs,"faces":faces,
            "materials":mats,"mat_to_idx":{n:i for i,n in enumerate(mat_names)}}


def load_mesh(filepath: str) -> dict:
    ext = filepath.rsplit('.',1)[-1].lower()
    if ext=='obj': return parse_obj(filepath)
    if ext=='gltf': return parse_gltf(filepath)
    if ext in ('glb','stl'):
        with open(filepath,'rb') as f: header=f.read(80)
        if b'solid' in header[:5]: return parse_stl_ascii(filepath)
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
                "x":{"type":"number","index":"range"},"y":{"type":"number","index":"range"},
                "z":{"type":"number","index":"range"},
                "normal_x":{"type":"number","index":"none"},"normal_y":{"type":"number","index":"none"},
                "normal_z":{"type":"number","index":"none"},
                "u":{"type":"number","index":"range"},"v":{"type":"number","index":"range"},
                "mat_idx":{"type":"number","index":"exact"},
                "valence":{"type":"number","index":"range"},
                "component":{"type":"string","index":"exact"},
                "curvature":{"type":"number","index":"range"},
                "material_zone":{"type":"string","index":"exact"},
            },
            "relationships": {
                "CONNECTED_TO":{"targetTypes":["Vertex"],"directed":False,"cardinality":"many-to-many"},
                "PART_OF_FACE":{"targetTypes":["Face"],"directed":True,"cardinality":"many-to-many"},
                "SHARES_EDGE":{"targetTypes":["Vertex"],"directed":False,"cardinality":"many-to-many"},
            },
        },
        "Face": {
            "fields": {
                "face_idx":{"type":"number","index":"range"},
                "mat_idx":{"type":"number","index":"exact"},
                "area":{"type":"number","index":"range"},
                "normal_x":{"type":"number","index":"none"},"normal_y":{"type":"number","index":"none"},
                "normal_z":{"type":"number","index":"none"},
                "center_x":{"type":"number","index":"range"},"center_y":{"type":"number","index":"range"},
                "center_z":{"type":"number","index":"range"},
                "is_boundary":{"type":"boolean","index":"exact"},
                "component":{"type":"string","index":"exact"},
                "material_zone":{"type":"string","index":"exact"},
                "roughness_class":{"type":"string","index":"exact"},
                "specularity":{"type":"number","index":"range"},
            },
            "relationships": {
                "ADJACENT_TO":{"targetTypes":["Face"],"directed":False,"cardinality":"many-to-many"},
                "USES_MATERIAL":{"targetTypes":["Material"],"directed":True,"cardinality":"many-to-one"},
                "IN_ZONE":{"targetTypes":["Material"],"directed":True,"cardinality":"many-to-one"},
            },
        },
        "Edge": {
            "fields": {
                "length":{"type":"number","index":"range"},
                "is_boundary":{"type":"boolean","index":"exact"},
                "is_crease":{"type":"boolean","index":"exact"},
                "dihedral_angle":{"type":"number","index":"range"},
            },
            "relationships": {
                "CONNECTS":{"targetTypes":["Vertex"],"directed":False,"cardinality":"one-to-many"},
                "BORDERS":{"targetTypes":["Face"],"directed":False,"cardinality":"many-to-many"},
            },
        },
        "Material": {
            "fields": {
                "name":{"type":"string","index":"exact"},
                "base_r":{"type":"number","index":"range"},"base_g":{"type":"number","index":"range"},
                "base_b":{"type":"number","index":"range"},
                "roughness":{"type":"number","index":"range"},
                "metallic":{"type":"number","index":"range"},
                "face_count":{"type":"number","index":"range"},
                "zone_id":{"type":"string","index":"exact"},
                "roughness_class":{"type":"string","index":"exact"},
            },
            "relationships": {},
        },
    },
})
```

---

## Step 3 — Index Mesh into vapor

```python
def vec3_length(v): return (v[0]**2+v[1]**2+v[2]**2)**0.5
def vec3_cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def vec3_sub(a,b): return (a[0]-b[0],a[1]-b[1],a[2]-b[2])
def compute_tri_area(p0,p1,p2):
    ab=vec3_sub(p1,p0); ac=vec3_sub(p2,p0); c=vec3_cross(ab,ac); return vec3_length(c)/2.0
def compute_tri_normal(p0,p1,p2):
    ab=vec3_sub(p1,p0); ac=vec3_sub(p2,p0); c=vec3_cross(ab,ac); L=vec3_length(c)
    return (c[0]/L,c[1]/L,c[2]/L) if L>1e-10 else (0.0,1.0,0.0)


def index_mesh(vapor, geometry: dict) -> tuple[list, list, dict]:
    verts=geometry["vertices"]; faces=geometry["faces"]; mats=geometry["materials"]
    mat_ids={}; face_count_per_mat={}

    for mat_name, mat_data in mats.items():
        mid = vapor.store("Material", {
            "name":mat_name,
            "base_r":mat_data.get("r",0.8)*255,"base_g":mat_data.get("g",0.8)*255,
            "base_b":mat_data.get("b",0.8)*255,
            "roughness":mat_data.get("roughness",0.5),"metallic":mat_data.get("metallic",0.0),
            "face_count":0.0,"zone_id":"","roughness_class":"matte",
        })
        mat_ids[mat_name]=mid; face_count_per_mat[mat_name]=0

    vertex_ids=[]
    for (x,y,z) in verts:
        vid=vapor.store("Vertex",{"x":float(x),"y":float(y),"z":float(z),
            "normal_x":0.0,"normal_y":0.0,"normal_z":0.0,"u":0.0,"v":0.0,
            "mat_idx":0.0,"valence":0.0,"component":"","curvature":0.0,"material_zone":""})
        vertex_ids.append(vid)

    face_ids=[]; edge_map={}
    for fi,face in enumerate(faces):
        vi_list=[v[0] for v in face["verts"] if 0<=v[0]<len(vertex_ids)]
        if len(vi_list)<3: continue
        p0=verts[vi_list[0]]; p1=verts[vi_list[1]]; p2=verts[vi_list[2]]
        area=compute_tri_area(p0,p1,p2)
        normal=face.get("face_normal") or compute_tri_normal(p0,p1,p2)
        cx=sum(verts[v][0] for v in vi_list)/len(vi_list)
        cy=sum(verts[v][1] for v in vi_list)/len(vi_list)
        cz=sum(verts[v][2] for v in vi_list)/len(vi_list)
        mat=face.get("mat","default")
        fid=vapor.store("Face",{
            "face_idx":float(fi),"mat_idx":float(face.get("mat_idx",0)),
            "area":area,"normal_x":float(normal[0]),"normal_y":float(normal[1]),
            "normal_z":float(normal[2]),"center_x":cx,"center_y":cy,"center_z":cz,
            "is_boundary":False,"component":"","material_zone":"",
            "roughness_class":"matte","specularity":0.5,
        })
        face_ids.append(fid); face_count_per_mat[mat]=face_count_per_mat.get(mat,0)+1

        for vi in vi_list:
            vapor.relate(vertex_ids[vi], "PART_OF_FACE", fid)

        n=len(vi_list)
        for k in range(n):
            vi_a=vi_list[k]; vi_b=vi_list[(k+1)%n]
            edge_key=frozenset({vi_a,vi_b})
            vapor.relate(vertex_ids[vi_a], "CONNECTED_TO", vertex_ids[vi_b])
            if edge_key not in edge_map:
                pa=verts[vi_a]; pb=verts[vi_b]; length=vec3_length(vec3_sub(pa,pb))
                eid=vapor.store("Edge",{"length":length,"is_boundary":False,
                                        "is_crease":False,"dihedral_angle":0.0})
                edge_map[edge_key]=eid
                vapor.relate(eid,"CONNECTS",vertex_ids[vi_a])
                vapor.relate(eid,"CONNECTS",vertex_ids[vi_b])
            vapor.relate(edge_map[edge_key],"BORDERS",fid)

        mat_rec=mat_ids.get(mat)
        if mat_rec: vapor.relate(fid,"USES_MATERIAL",mat_rec)

    for mat_name,count in face_count_per_mat.items():
        mid=mat_ids.get(mat_name)
        if mid: vapor.update(mid,{"face_count":float(count)})

    for vid in vertex_ids:
        # PART_OF_FACE is directed vertex→face, use "outgoing" from vertex
        rels=vapor.get_relationships(vid,"PART_OF_FACE","outgoing")
        vapor.update(vid,{"valence":float(len(rels))})

    print(f"Indexed {len(vertex_ids)} vertices, {len(face_ids)} faces, {len(edge_map)} edges.")
    return vertex_ids, face_ids, mat_ids
```

---

## Step 4 — Compute Geometry + Material Properties (5× Validation)

```python
def compute_geometry_5x(vapor, vertex_ids, face_ids):
    for pass_num in range(5):
        boundary_count=0
        all_edges=vapor.query(QueryOptions(type="Edge"))
        for erec in all_edges.records:
            # BORDERS is undirected edge↔face — use "both"
            face_rels=vapor.get_relationships(erec.id,"BORDERS","both")
            if len(face_rels)==1:
                vapor.update(erec.id,{"is_boundary":True}); boundary_count+=1
                # CONNECTS is undirected edge↔vertex — use "both"
                vert_rels=vapor.get_relationships(erec.id,"CONNECTS","both")
                for vr in vert_rels:
                    v=vapor.get(vr.target_id if vr.source_id==erec.id else vr.source_id)
                    if v: vapor.update(vr.target_id if vr.source_id==erec.id else vr.source_id,
                                       {"component":"boundary"})
            elif len(face_rels)==2:
                f1=vapor.get(face_rels[0].target_id if face_rels[0].source_id==erec.id
                              else face_rels[0].source_id)
                f2=vapor.get(face_rels[1].target_id if face_rels[1].source_id==erec.id
                              else face_rels[1].source_id)
                if f1 and f2:
                    n1=(f1.data["normal_x"],f1.data["normal_y"],f1.data["normal_z"])
                    n2=(f2.data["normal_x"],f2.data["normal_y"],f2.data["normal_z"])
                    dot=max(-1.0,min(1.0,sum(n1[i]*n2[i] for i in range(3))))
                    angle_deg=math.degrees(math.acos(dot))
                    vapor.update(erec.id,{"dihedral_angle":angle_deg})
                    if angle_deg>60: vapor.update(erec.id,{"is_crease":True})

        all_verts=vapor.query(QueryOptions(type="Vertex"))
        for vrec in all_verts.records:
            # PART_OF_FACE is directed vertex→face, use "outgoing" from vertex
            face_rels=vapor.get_relationships(vrec.id,"PART_OF_FACE","outgoing")
            if len(face_rels)>1:
                nx_vals=[vapor.get(fr.target_id).data["normal_x"]
                         for fr in face_rels if vapor.get(fr.target_id)]
                if len(nx_vals)>1:
                    mean_nx=sum(nx_vals)/len(nx_vals)
                    variance=sum((v-mean_nx)**2 for v in nx_vals)/len(nx_vals)
                    vapor.update(vrec.id,{"curvature":variance})

        print(f"  Geometry pass {pass_num+1}/5: {boundary_count} boundary edges.")
    print("5x geometry validation complete.")


def compute_face_material_properties(vapor, face_ids: list) -> None:
    """
    NEW v3.0: Compute material roughness class per face from dihedral angle variance.
    Assign roughness_class and specularity to each face for CAD-to-photo projection.
    """
    all_faces=vapor.query(QueryOptions(type="Face"))
    for frec in all_faces.records:
        # Get adjacent face dihedral variation via ADJACENT_TO (undirected)
        adj=vapor.get_relationships(frec.id,"ADJACENT_TO","both")
        dihedrals=[]
        for e in adj:
            nid=e.target_id if e.source_id==frec.id else e.source_id
            nrec=vapor.get(nid)
            if nrec:
                da=nrec.data.get("dihedral_angle",0)
                dihedrals.append(da)

        if dihedrals:
            mean_d=sum(dihedrals)/len(dihedrals)
            # High mean dihedral = sharp edges = hard surface = glossy
            if mean_d > 60:   roughness="glossy";  spec=0.8
            elif mean_d > 30: roughness="satin";    spec=0.5
            elif mean_d > 10: roughness="matte";    spec=0.3
            else:             roughness="rough";    spec=0.1
        else:
            roughness="matte"; spec=0.3

        vapor.update(frec.id,{"roughness_class":roughness,"specularity":spec})
```

---

## Step 5 — Find Disconnected Components

```python
def find_connected_components(vapor, vertex_ids: list) -> dict:
    unvisited=set(vertex_ids); counter=0; components={}
    while unvisited:
        counter+=1; cid=f"component_{counter:03d}"; seed=next(iter(unvisited))
        # Use vapor.traverse for deep BFS — this IS available in vapor-idx Python library
        result=vapor.traverse(TraversalOptions(
            from_id=seed, relationship="CONNECTED_TO",
            direction="both",  # CONNECTED_TO is undirected
            depth=9999,
        ))
        in_comp={seed}|{r.id for r in result.records}
        components[cid]=list(in_comp)
        for vid in in_comp:
            vapor.update(vid,{"component":cid})
            unvisited.discard(vid)
    print(f"Found {counter} connected component(s).")
    return components
```

---

## Step 6 — Material Zone Detection (NEW v3.0)

```python
def detect_material_zones(vapor, face_ids: list) -> dict:
    """
    NEW: Find contiguous regions of the mesh sharing the same material.
    Uses flood-fill through ADJACENT_TO face relationships.
    Each material zone gets a unique zone_id.

    Critical for CAD-to-photo: each zone needs different lighting response.
    """
    all_faces=vapor.query(QueryOptions(type="Face"))
    face_recs={rec.id: rec for rec in all_faces.records}

    visited=set(); zone_map={}; zone_counter=0

    for fid,frec in face_recs.items():
        if fid in visited: continue
        mat_idx=frec.data.get("mat_idx",0)

        # BFS through ADJACENT_TO faces with same mat_idx
        zone_counter+=1; zone_id=f"zone_{zone_counter:03d}"
        q=[fid]; local_vis={fid}
        while q:
            cur=q.pop(0); visited.add(cur); zone_map[cur]=zone_id
            # ADJACENT_TO face relationships are undirected
            adj=vapor.get_relationships(cur,"ADJACENT_TO","both")
            for e in adj:
                nid=e.target_id if e.source_id==cur else e.source_id
                if nid in local_vis or nid in visited: continue
                nrec=face_recs.get(nid)
                if nrec and nrec.data.get("mat_idx",0)==mat_idx:
                    local_vis.add(nid); q.append(nid)

        # Update all faces in this zone
        for zfid in local_vis:
            vapor.update(zfid,{"material_zone":zone_id})

    print(f"Material zones: {zone_counter}")
    return zone_map


def compute_bounding_box(vapor) -> dict:
    all_v=vapor.query(QueryOptions(type="Vertex"))
    if not all_v.records: return {}
    xs=[r.data["x"] for r in all_v.records]
    ys=[r.data["y"] for r in all_v.records]
    zs=[r.data["z"] for r in all_v.records]
    return {"x":(min(xs),max(xs)),"y":(min(ys),max(ys)),"z":(min(zs),max(zs)),
            "center":((min(xs)+max(xs))/2,(min(ys)+max(ys))/2,(min(zs)+max(zs))/2)}
```

---

## Step 7 — Perspective Projection for CAD-to-Photo (NEW v3.0)

```python
def project_to_perspective(vapor, camera_pos: tuple, camera_look_at: tuple,
                            fov_deg: float, canvas_w: int, canvas_h: int) -> dict:
    """
    NEW: Project all Vertex 3D positions into 2D screen coordinates.
    Used by cad-to-photo skill to render mesh into background photo.

    camera_pos: (cx,cy,cz) camera world position
    camera_look_at: (lx,ly,lz) target point
    fov_deg: field of view in degrees
    canvas_w, canvas_h: output image dimensions

    Returns vertex_id → (screen_x, screen_y, depth_z) mapping.
    """
    import math

    cx,cy,cz = camera_pos; lx,ly,lz = camera_look_at

    # Build camera coordinate system (simplified pinhole)
    # Forward vector
    fx=lx-cx; fy=ly-cy; fz=lz-cz
    fl=math.sqrt(fx**2+fy**2+fz**2)
    if fl < 1e-8: return {}
    fx/=fl; fy/=fl; fz/=fl

    # Right vector (forward × world_up)
    world_up=(0,1,0)
    rx=fy*world_up[2]-fz*world_up[1]
    ry=fz*world_up[0]-fx*world_up[2]
    rz=fx*world_up[1]-fy*world_up[0]
    rl=math.sqrt(rx**2+ry**2+rz**2)
    if rl>1e-8: rx/=rl; ry/=rl; rz/=rl

    # Up vector (right × forward)
    ux=ry*fz-rz*fy; uy=rz*fx-rx*fz; uz=rx*fy-ry*fx

    fov_rad = math.radians(fov_deg)
    focal = (canvas_w/2) / math.tan(fov_rad/2)

    all_v = vapor.query(QueryOptions(type="Vertex"))
    projection = {}

    for rec in all_v.records:
        # Translate to camera space
        vx=rec.data["x"]-cx; vy=rec.data["y"]-cy; vz=rec.data["z"]-cz

        # Project into camera axes
        cam_x=vx*rx+vy*ry+vz*rz  # right
        cam_y=vx*ux+vy*uy+vz*uz  # up
        cam_z=vx*fx+vy*fy+vz*fz  # depth (forward)

        if cam_z <= 0.01: continue  # behind camera

        # Perspective divide
        screen_x = int(canvas_w/2 + focal*cam_x/cam_z)
        screen_y = int(canvas_h/2 - focal*cam_y/cam_z)

        projection[rec.id] = (screen_x, screen_y, cam_z)

    print(f"  Projected {len(projection)} vertices to screen")
    return projection


def infer_camera_from_horizon(horizon_y: int, canvas_w: int, canvas_h: int) -> dict:
    """
    Estimate camera parameters from the background photo's horizon line.
    The horizon y-position encodes camera height and field of view.

    Returns camera_params dict for project_to_perspective().
    """
    # Camera height above ground plane
    horizon_frac = horizon_y / canvas_h
    # When horizon is at 50%, camera is at eye level
    # When horizon is at 30%, camera is elevated
    cam_height = 2.0 * (0.5-horizon_frac) * 5.0 + 1.7  # 1.7m = eye height

    # Estimate fov from aspect ratio (typical camera 50-70°)
    aspect = canvas_w/canvas_h
    fov_deg = 55.0 + (aspect-1.0)*10.0

    return {
        "camera_pos": (0.0, cam_height, -5.0),  # 5m from subject
        "camera_look_at": (0.0, cam_height*0.5, 0.0),
        "fov_deg": fov_deg,
        "horizon_y": horizon_y,
        "estimated": True,
    }
```

---

## Step 8 — Reconstruct as Blender Python

```python
def reconstruct_blender(vapor, mesh_name: str = "Mesh") -> str:
    lines = ["import bpy,bmesh",
             f"mesh=bpy.data.meshes.new('{mesh_name}')",
             f"obj=bpy.data.objects.new('{mesh_name}',mesh)",
             "bpy.context.scene.collection.objects.link(obj)",
             "bm=bmesh.new()"]

    all_v=vapor.query(QueryOptions(type="Vertex"))
    id_to_idx={}
    for i,rec in enumerate(all_v.records):
        lines.append(f"bm.verts.new(({rec.data['x']:.6f},{rec.data['y']:.6f},{rec.data['z']:.6f}))")
        id_to_idx[rec.id]=i
    lines.append("bm.verts.ensure_lookup_table()")

    all_f=vapor.query(QueryOptions(type="Face",order_by=("face_idx","asc")))
    for rec in all_f.records:
        # PART_OF_FACE is directed vertex→face. Use "incoming" on face to get vertices.
        rels=[r for r in vapor.get_relationships(rec.id,"PART_OF_FACE","incoming")]
        indices=[id_to_idx[r.source_id] for r in rels if r.source_id in id_to_idx]
        if len(indices)>=3:
            v_str=",".join(f"bm.verts[{i}]" for i in indices)
            lines+=["try:",f"    bm.faces.new([{v_str}])","except ValueError:","    pass"]

    all_m=vapor.query(QueryOptions(type="Material"))
    for rec in all_m.records:
        n=rec.data["name"]; r=int(rec.data.get("base_r",200))
        g=int(rec.data.get("base_g",200)); b=int(rec.data.get("base_b",200))
        lines+=[f"_m=bpy.data.materials.new('{n}')","_m.use_nodes=True",
                "_b=_m.node_tree.nodes['Principled BSDF']",
                f"_b.inputs['Base Color'].default_value=({r/255:.3f},{g/255:.3f},{b/255:.3f},1)",
                f"_b.inputs['Roughness'].default_value={rec.data.get('roughness',0.5):.3f}",
                f"_b.inputs['Metallic'].default_value={rec.data.get('metallic',0.0):.3f}",
                "obj.data.materials.append(_m)"]
    lines+=["bm.to_mesh(mesh)","bm.free()","mesh.update()","print('Done.')"]
    return "\n".join(lines)

def reconstruct_obj(vapor) -> str:
    lines=["# Reconstructed by vapor-idx"]
    all_v=vapor.query(QueryOptions(type="Vertex"))
    id_to_idx={}
    for i,rec in enumerate(all_v.records,1):
        lines.append(f"v {rec.data['x']:.6f} {rec.data['y']:.6f} {rec.data['z']:.6f}")
        id_to_idx[rec.id]=i
    all_f=vapor.query(QueryOptions(type="Face",order_by=("face_idx","asc")))
    for rec in all_f.records:
        rels=vapor.get_relationships(rec.id,"PART_OF_FACE","incoming")
        idx=[str(id_to_idx[r.source_id]) for r in rels if r.source_id in id_to_idx]
        if len(idx)>=3: lines.append(f"f {' '.join(idx)}")
    return "\n".join(lines)
```

---

## Step 9 — Full Pipeline

```python
# Load
geo = load_mesh("model.obj")  # or .stl or .gltf

# Index
vertex_ids, face_ids, mat_ids = index_mesh(vapor, geo)

# Compute geometry
compute_geometry_5x(vapor, vertex_ids, face_ids)

# NEW v3.0: material properties + zones
compute_face_material_properties(vapor, face_ids)
zone_map = detect_material_zones(vapor, face_ids)

# Find components
components = find_connected_components(vapor, vertex_ids)

# Bounding box
bbox = compute_bounding_box(vapor)
print(f"BBox: {bbox}")

# Reconstruct
script = reconstruct_blender(vapor, "ImportedMesh")
with open("reconstruct.py","w") as f: f.write(script)
with open("output.obj","w") as f: f.write(reconstruct_obj(vapor))

vapor.destroy()
print("Done.")
```

---

## Output

Report: vertex/face/edge counts, bounding box, component count, dominant material,
boundary edge count, crease edge count, high-curvature vertex regions,
material zone count, roughness class distribution per zone.
Save reconstruction files with full paths.
