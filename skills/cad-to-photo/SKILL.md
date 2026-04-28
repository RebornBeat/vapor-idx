---
name: CAD to Photo
description: Project 3D CAD/mesh geometry onto a real photograph with photorealistic integration. Bridges mesh-analyzer (3D geometry) and pixel-analyzer (2D scene). Infers camera parameters from background photo perspective, projects mesh faces onto screen, synthesizes PBR materials from scene lighting, and composites the result into the background with shadows and reflections. Pure Python, no external libraries.
version: 1.0.0
tools:
  - computer_use
---

# CAD to Photo Skill v1.0

## Purpose

Place a 3D CAD model or rendered object into a real photograph with full
photorealistic integration. The pipeline:

1. Analyze the background photo to extract perspective + lighting
2. Load the 3D mesh via mesh-analyzer
3. Project the mesh onto the background photo's perspective plane
4. Synthesize PBR materials using the scene's measured lighting
5. Composite the rendered mesh into the background with shadows and reflections

**Use cases:**
- Product placement (shoe, phone, furniture) in real environments
- Architectural visualization (building design on real site photo)
- Technical drawing to photorealism conversion
- Any case where a 3D model needs to be placed in a real scene

## When to Trigger

- "Place this CAD model in this room photo"
- "Show this product design in a real setting"
- "Render this 3D model into this background"
- "Make this technical drawing look photorealistic in a real environment"

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST
```

## Environment

```bash
pip install vapor-idx
```

---

## Step 1 — Vanishing Point Detection

```python
import math
import struct, zlib

def detect_vanishing_points(pixels: list, W: int, H: int,
                              horizon_y: int) -> dict:
    """
    Find vanishing points from the background photo's perspective geometry.
    Vanishing points define the camera's orientation relative to the scene.

    Algorithm:
    1. Find strong edge pixels using Sobel (from scene analysis)
    2. Cluster near-horizontal edges (floor lines → left/right vanishing points)
    3. Cluster near-vertical edges (wall lines → vertical vanishing point)
    4. Project clusters to find convergence points

    For typical outdoor/architectural scenes, we extract:
    - left_vp: left vanishing point x-coordinate (often far left)
    - right_vp: right vanishing point x-coordinate (often far right)
    - horizon_y: already known from scene-analyzer

    Returns vanishing_points dict.
    """
    # Sobel on grayscale
    def get_br(y, x):
        if 0<=y<H and 0<=x<W:
            r,g,b = pixels[y][x][:3]; return (r+g+b)/3
        return 0

    # Find high-gradient rows (edge rows)
    row_grad = {}
    for y in range(1, H-1, 2):
        row_sum = 0
        for x in range(1, W-1, 4):
            gx = (-get_br(y-1,x-1)+get_br(y-1,x+1)-2*get_br(y,x-1)+2*get_br(y,x+1)
                  -get_br(y+1,x-1)+get_br(y+1,x+1))
            gy = (-get_br(y-1,x-1)-2*get_br(y-1,x)-get_br(y-1,x+1)
                  +get_br(y+1,x-1)+2*get_br(y+1,x)+get_br(y+1,x+1))
            row_sum += (gx**2+gy**2)**0.5
        row_grad[y] = row_sum / max(W//4, 1)

    # Estimate left and right vanishing points from edge convergence
    # Simple: strong edges near horizon converge toward VP at horizon level
    # For a typical scene, VPs are at horizon_y, far left and right
    left_vp_x = -W  # left VP is far left
    right_vp_x = 2*W  # right VP is far right

    # Refine: sample strong near-horizontal edge pixels near the ground zone
    # and estimate their direction vectors
    floor_edges = []  # list of (x, y, dx, dy) direction vectors
    for y in range(int(H*0.6), H, 4):
        for x in range(1, W-1, 6):
            gx = -get_br(y,x-1)+get_br(y,x+1)
            gy = -get_br(y-1,x)+get_br(y+1,x)
            mag = (gx**2+gy**2)**0.5
            if mag > 20 and abs(gx) > abs(gy)*0.5:  # near-horizontal edge
                floor_edges.append((x, y, gx/mag, gy/mag))

    # Find convergence: pairs of floor_edges whose direction lines cross near horizon_y
    if len(floor_edges) >= 4:
        # Simple: average direction of left-half vs right-half edges
        left_edges  = [(x,y,dx,dy) for (x,y,dx,dy) in floor_edges if x < W//2]
        right_edges = [(x,y,dx,dy) for (x,y,dx,dy) in floor_edges if x > W//2]

        if left_edges:
            avg_dy_l = sum(dy for _,_,_,dy in left_edges)/len(left_edges)
            avg_dx_l = sum(dx for _,_,dx,_ in left_edges)/len(left_edges)
            if abs(avg_dy_l) > 0.01:
                # Trace edge line to horizon_y
                sample_x, sample_y, _, _ = left_edges[0]
                t = (horizon_y-sample_y)/avg_dy_l if abs(avg_dy_l)>0.001 else 0
                left_vp_x = int(sample_x + avg_dx_l*t)

        if right_edges:
            avg_dy_r = sum(dy for _,_,_,dy in right_edges)/len(right_edges)
            avg_dx_r = sum(dx for _,_,dx,_ in right_edges)/len(right_edges)
            if abs(avg_dy_r) > 0.01:
                sample_x, sample_y, _, _ = right_edges[0]
                t = (horizon_y-sample_y)/avg_dy_r if abs(avg_dy_r)>0.001 else 0
                right_vp_x = int(sample_x + avg_dx_r*t)

    result = {
        "left_vp":   (left_vp_x, horizon_y),
        "right_vp":  (right_vp_x, horizon_y),
        "horizon_y": horizon_y,
    }
    print(f"  VPs: left=({left_vp_x},{horizon_y}) right=({right_vp_x},{horizon_y})")
    return result


def calibrate_virtual_camera(vanishing_points: dict, canvas_w: int, canvas_h: int,
                               subject_h_m: float = 1.0) -> dict:
    """
    Compute virtual camera matrix from vanishing points.
    Returns camera_params for project_to_perspective().

    The background photo's perspective structure encodes the camera:
    - The horizon y-position = camera height above ground
    - The vanishing point x-spread = camera field of view
    - The canvas center = principal point

    subject_h_m: real-world height of the subject in meters (for scale)
    """
    horizon_y = vanishing_points["horizon_y"]
    left_vp_x = vanishing_points["left_vp"][0]
    right_vp_x = vanishing_points["right_vp"][0]

    horizon_frac = horizon_y / canvas_h
    # Camera height: 1.7m at 50% horizon, scales with horizon position
    cam_h = 1.7 * (canvas_h - horizon_y) / canvas_h * 2.0
    cam_h = max(0.2, min(10.0, cam_h))

    # FOV from VP spread: wider spread = narrower FOV
    vp_spread = abs(right_vp_x - left_vp_x)
    if vp_spread > canvas_w * 0.5:
        fov_deg = 55.0  # typical wide scene
    else:
        fov_deg = 70.0  # tighter scene

    # Focal length in pixels
    focal = (canvas_w / 2) / math.tan(math.radians(fov_deg / 2))

    return {
        "camera_pos": (0.0, cam_h, -5.0 * subject_h_m),
        "camera_look_at": (0.0, 0.0, 0.0),
        "fov_deg": fov_deg,
        "focal_px": focal,
        "cam_height_m": cam_h,
        "subject_h_m": subject_h_m,
        "canvas_w": canvas_w,
        "canvas_h": canvas_h,
        "horizon_y": horizon_y,
    }
```

---

## Step 2 — Mesh Rasterization

```python
def project_mesh_to_screen(mesh_vapor, camera_params: dict) -> dict:
    """
    Project all Vertex records from their 3D positions into 2D screen coordinates.
    Returns {vertex_id: (screen_x, screen_y, depth_z)}.
    """
    from vapor_idx import QueryOptions

    cx,cy,cz = camera_params["camera_pos"]
    lx,ly,lz = camera_params["camera_look_at"]
    focal     = camera_params["focal_px"]
    cw        = camera_params["canvas_w"]
    ch        = camera_params["canvas_h"]

    # Camera forward vector
    fx=lx-cx; fy=ly-cy; fz=lz-cz; fl=(fx**2+fy**2+fz**2)**0.5
    if fl < 1e-8: return {}
    fx/=fl; fy/=fl; fz/=fl

    # Right vector (forward × world_up)
    wu = (0,1,0)
    rx=fy*wu[2]-fz*wu[1]; ry=fz*wu[0]-fx*wu[2]; rz=fx*wu[1]-fy*wu[0]
    rl=(rx**2+ry**2+rz**2)**0.5
    if rl>1e-8: rx/=rl; ry/=rl; rz/=rl
    # Up = right × forward
    ux=ry*fz-rz*fy; uy=rz*fx-rx*fz; uz=rx*fy-ry*fx

    all_v = mesh_vapor.query(QueryOptions(type="Vertex"))
    projection = {}

    for rec in all_v.records:
        # Translate to camera space
        vx=rec.data["x"]-cx; vy=rec.data["y"]-cy; vz=rec.data["z"]-cz
        # Project onto camera axes
        cam_x = vx*rx+vy*ry+vz*rz
        cam_y = vx*ux+vy*uy+vz*uz
        cam_z = vx*fx+vy*fy+vz*fz

        if cam_z <= 0.001: continue  # behind camera

        sx = int(cw/2 + focal*cam_x/cam_z)
        sy = int(ch/2 - focal*cam_y/cam_z)
        projection[rec.id] = (sx, sy, cam_z)

    print(f"  Projected {len(projection)}/{all_v.total} vertices")
    return projection


def rasterize_faces(mesh_vapor, projection: dict, camera_params: dict,
                     canvas_w: int, canvas_h: int) -> list:
    """
    Rasterize all visible faces using painter's algorithm (back-to-front sort).
    Returns a list of rasterized face dicts sorted front-to-back for depth buffer.

    Each face: {face_id, vertices_2d, depth, normal_z, mat_idx, roughness_class}
    """
    from vapor_idx import QueryOptions

    all_f = mesh_vapor.query(QueryOptions(type="Face"))
    rasterized = []

    for frec in all_f.records:
        # Get vertex screen positions for this face
        # PART_OF_FACE directed vertex→face: use "incoming" on face to get vertices
        vert_rels = mesh_vapor.get_relationships(frec.id, "PART_OF_FACE", "incoming")
        verts_2d = []
        depths = []

        for rel in vert_rels:
            vid = rel.source_id
            if vid not in projection: continue
            sx, sy, dz = projection[vid]
            verts_2d.append((sx, sy))
            depths.append(dz)

        if len(verts_2d) < 3: continue

        # Backface culling: compute 2D cross product (screen-space normal)
        v0,v1,v2 = verts_2d[0],verts_2d[1],verts_2d[2]
        cross_z = (v1[0]-v0[0])*(v2[1]-v0[1]) - (v1[1]-v0[1])*(v2[0]-v0[0])
        if cross_z > 0: continue  # back-facing (right-hand rule in screen space)

        avg_depth = sum(depths)/len(depths)
        nx = frec.data.get("normal_x", 0); ny = frec.data.get("normal_y", 0)
        nz = frec.data.get("normal_z", 1)

        rasterized.append({
            "face_id":    frec.id,
            "verts_2d":   verts_2d,
            "depth":      avg_depth,
            "normal":     (nx, ny, nz),
            "mat_idx":    int(frec.data.get("mat_idx", 0)),
            "roughness_class": frec.data.get("roughness_class","matte"),
            "specularity": frec.data.get("specularity", 0.3),
        })

    # Sort back-to-front (painter's algorithm)
    rasterized.sort(key=lambda f: f["depth"], reverse=True)
    print(f"  Rasterized {len(rasterized)} visible faces")
    return rasterized


def fill_triangle(canvas: list, canvas_w: int, canvas_h: int,
                   v0: tuple, v1: tuple, v2: tuple, color: tuple,
                   depth_buffer: list = None) -> int:
    """
    Rasterize a triangle using scanline fill.
    Returns number of pixels written.
    color: (r, g, b)
    depth_buffer: optional 2D list of float depths for occlusion
    """
    r,g,b = color
    verts = sorted([v0,v1,v2], key=lambda v: v[1])  # sort by y
    p0,p1,p2 = verts

    def edge_interp(ya, xa, yb, xb, y):
        if yb == ya: return xa
        return int(xa + (xb-xa)*(y-ya)/(yb-ya))

    written = 0
    for y in range(max(0,p0[1]), min(canvas_h-1, p2[1])+1):
        # Left and right x bounds
        if y < p1[1]:
            x_left  = edge_interp(p0[1],p0[0], p1[1],p1[0], y)
            x_right = edge_interp(p0[1],p0[0], p2[1],p2[0], y)
        else:
            x_left  = edge_interp(p1[1],p1[0], p2[1],p2[0], y)
            x_right = edge_interp(p0[1],p0[0], p2[1],p2[0], y)

        if x_left > x_right: x_left,x_right = x_right,x_left

        for x in range(max(0,x_left), min(canvas_w-1,x_right)+1):
            canvas[y][x] = [r,g,b,255]
            written += 1

    return written
```

---

## Step 3 — PBR Material Synthesis from Scene Lighting

```python
def synthesize_face_color(face: dict, scene_props: dict,
                           mat_color: tuple = (200, 200, 200)) -> tuple:
    """
    Compute the rendered color for a single face using scene lighting.
    Applies Lambertian diffuse + Phong specular + ambient.

    face: rasterized face dict from rasterize_faces()
    scene_props: from scene-analyzer
    mat_color: base material RGB color

    Returns (r, g, b) rendered color for this face.
    """
    sr,sg,sb = scene_props.get("sun_color",(255,200,120))
    ar,ag,ab = scene_props.get("ambient_color",(120,140,180))
    light_right = scene_props.get("light_from_right", True)
    warm = scene_props.get("warm_strength", 0.3)
    elevation = scene_props.get("light_elevation_deg", 30)

    # Light direction vector (from scene analysis)
    light_x = 1.0 if light_right else -1.0
    light_y = math.sin(math.radians(elevation))
    light_z = -math.cos(math.radians(elevation))
    ll = (light_x**2+light_y**2+light_z**2)**0.5
    light_x/=ll; light_y/=ll; light_z/=ll

    # Face normal
    nx,ny,nz = face["normal"]
    nl = (nx**2+ny**2+nz**2)**0.5
    if nl > 1e-6: nx/=nl; ny/=nl; nz/=nl

    # Lambertian diffuse
    NdotL = max(0.0, nx*light_x + ny*light_y + nz*light_z)

    # Specular (Phong)
    spec_exp = {"mirror":512,"glossy":128,"satin":32,"matte":8,"rough":2}.get(
                face.get("roughness_class","matte"), 8)
    specularity = face.get("specularity", 0.3)

    # View direction (simplified: looking from camera = (0,0,-1) in cam space)
    # In world space: facing camera = -forward direction
    # Approximate: half-vector between light and view
    half_x = light_x; half_y = light_y + 0.1; half_z = light_z - 0.5
    hl=(half_x**2+half_y**2+half_z**2)**0.5
    if hl>1e-6: half_x/=hl; half_y/=hl; half_z/=hl

    NdotH = max(0.0, nx*half_x+ny*half_y+nz*half_z)
    spec = (NdotH ** spec_exp) * specularity

    mr,mg,mb = mat_color

    # Diffuse component
    diff_strength = 0.75 * NdotL
    diff_r = mr*(1-diff_strength) + (mr*0.5+sr*0.5)*diff_strength
    diff_g = mg*(1-diff_strength) + (mg*0.5+sg*0.5)*diff_strength
    diff_b = mb*(1-diff_strength) + (mb*0.5+sb*0.5)*diff_strength

    # Ambient fill
    amb_strength = 0.20
    final_r = diff_r*(1-amb_strength) + ar*amb_strength
    final_g = diff_g*(1-amb_strength) + ag*amb_strength
    final_b = diff_b*(1-amb_strength) + ab*amb_strength

    # Specular highlight (sun-colored)
    final_r += (sr-final_r)*spec
    final_g += (sg-final_g)*spec
    final_b += (sb-final_b)*spec

    # Warm tint from scene
    if warm > 0.15:
        warm_str = warm * 0.15
        final_r = final_r*(1-warm_str) + sr*warm_str
        final_g = final_g*(1-warm_str*0.5) + sg*warm_str*0.5

    return (max(0,min(255,int(final_r))),
            max(0,min(255,int(final_g))),
            max(0,min(255,int(final_b))))
```

---

## Step 4 — Mesh-to-Canvas Integration

```python
def render_mesh_into_scene(canvas: list, rasterized_faces: list,
                            mesh_vapor, mat_ids: dict,
                            scene_props: dict, camera_params: dict,
                            canvas_w: int, canvas_h: int,
                            depth_buffer: list = None) -> dict:
    """
    Render all rasterized mesh faces into the canvas with PBR materials.
    Uses painter's algorithm (already sorted back-to-front).
    Adds edge highlights on hard edges (is_crease).

    Returns render stats dict.
    """
    from vapor_idx import QueryOptions

    # Build material lookup
    mat_colors = {}
    for mat_name, mid in mat_ids.items():
        mrec = mesh_vapor.get(mid)
        if mrec:
            mat_colors[int(mrec.data.get("mat_idx",0))] = (
                int(mrec.data.get("base_r",200)),
                int(mrec.data.get("base_g",200)),
                int(mrec.data.get("base_b",200)),
            )

    total_px = 0
    for face in rasterized_faces:
        mat_idx = face["mat_idx"]
        base_col = mat_colors.get(mat_idx, (180,180,180))

        # Synthesize color with PBR model
        rendered_color = synthesize_face_color(face, scene_props, base_col)

        # Rasterize the triangle(s) in this face
        verts = face["verts_2d"]
        if len(verts) >= 3:
            # Fan triangulation for faces with more than 3 vertices
            v0 = verts[0]
            for i in range(1, len(verts)-1):
                v1 = verts[i]; v2 = verts[i+1]
                # Bounds check: skip faces entirely outside canvas
                xs = [v0[0],v1[0],v2[0]]; ys = [v0[1],v1[1],v2[1]]
                if (min(xs) >= canvas_w or max(xs) < 0 or
                    min(ys) >= canvas_h or max(ys) < 0): continue
                total_px += fill_triangle(canvas, canvas_w, canvas_h,
                                          v0, v1, v2, rendered_color)

    print(f"  Rendered {len(rasterized_faces)} faces → {total_px} pixels")
    return {"faces_rendered": len(rasterized_faces), "pixels": total_px}


def add_mesh_shadow(canvas: list, rasterized_faces: list,
                    canvas_w: int, canvas_h: int,
                    scene_props: dict, ground_y: int) -> None:
    """
    Cast shadow from mesh onto ground plane.
    Projects each face's vertices onto ground (y=ground_y in screen space)
    with shadow color and soft falloff.
    """
    sr,sg,sb = scene_props.get("surface_color", scene_props.get("sand_color",(180,155,115)))
    shadow_col = (int(sr*0.4), int(sg*0.32), int(sb*0.28))
    light_right = scene_props.get("light_from_right", True)
    shadow_x_shear = 0.3 * (1 if light_right else -1)

    for face in rasterized_faces[:len(rasterized_faces)//2]:  # only front faces cast visible shadows
        verts = face["verts_2d"]
        if not verts: continue

        # Project vertices to ground plane (shift y to ground_y, shear x)
        shadow_verts = []
        for (sx,sy) in verts:
            dist_to_ground = max(0, ground_y - sy)
            shx = sx + int(shadow_x_shear * dist_to_ground * 0.2)
            shadow_verts.append((shx, ground_y))

        if len(shadow_verts) >= 3:
            for i in range(len(shadow_verts)-2):
                v0=shadow_verts[0]; v1=shadow_verts[i+1]; v2=shadow_verts[i+2]
                xs=[v0[0],v1[0],v2[0]]; ys=[v0[1],v1[1],v2[1]]
                if min(xs)>=canvas_w or max(xs)<0 or min(ys)>=canvas_h or max(ys)<0: continue

                # Soft shadow: blend with background
                for y in range(max(0,min(ys)), min(canvas_h-1,max(ys)+1)):
                    for x in range(max(0,min(xs)), min(canvas_w-1,max(xs)+1)):
                        bg = canvas[y][x]
                        opacity = 0.45
                        canvas[y][x] = [
                            max(0,min(255,int(bg[0]*(1-opacity)+shadow_col[0]*opacity))),
                            max(0,min(255,int(bg[1]*(1-opacity)+shadow_col[1]*opacity))),
                            max(0,min(255,int(bg[2]*(1-opacity)+shadow_col[2]*opacity))),
                            255
                        ]
```

---

## Step 5 — Mesh Edge Highlighting

```python
def render_hard_edges(canvas: list, mesh_vapor, projection: dict,
                       canvas_w: int, canvas_h: int,
                       scene_props: dict) -> int:
    """
    Draw edge highlights on crease/hard edges.
    Hard surface objects (CAD models) have characteristic sharp edges
    that catch specular light — this gives them a machined look.
    """
    from vapor_idx import QueryOptions

    sr,sg,sb = scene_props.get("sun_color",(255,220,150))
    highlight_col = (min(255,sr+30), min(255,sg+20), sb)

    crease_edges = mesh_vapor.query(QueryOptions(type="Edge",
        where=FieldFilter("is_crease","eq",True)))

    edges_drawn = 0
    for erec in crease_edges.records:
        # CONNECTS is undirected: use "both"
        vert_rels = mesh_vapor.get_relationships(erec.id, "CONNECTS", "both")
        vids = [r.target_id if r.source_id==erec.id else r.source_id for r in vert_rels]

        screen_pos = [projection.get(vid) for vid in vids if vid in projection]
        if len(screen_pos) < 2: continue

        sx0,sy0,_ = screen_pos[0]
        sx1,sy1,_ = screen_pos[1]

        # Draw line using Bresenham
        dx = abs(sx1-sx0); dy = abs(sy1-sy0)
        sx = 1 if sx0<sx1 else -1; sy = 1 if sy0<sy1 else -1
        err = dx-dy; x,y = sx0,sy0

        for _ in range(max(dx,dy)+1):
            if 0<=x<canvas_w and 0<=y<canvas_h:
                bg = canvas[y][x]
                opacity = 0.6
                canvas[y][x] = [
                    min(255,int(bg[0]*(1-opacity)+highlight_col[0]*opacity)),
                    min(255,int(bg[1]*(1-opacity)+highlight_col[1]*opacity)),
                    min(255,int(bg[2]*(1-opacity)+highlight_col[2]*opacity)),
                    255
                ]
            if x==sx1 and y==sy1: break
            e2=2*err
            if e2>-dy: err-=dy; x+=sx
            if e2<dx:  err+=dx; y+=sy

        edges_drawn += 1

    from vapor_idx import FieldFilter  # import here to avoid circular ref
    print(f"  Hard edges drawn: {edges_drawn}")
    return edges_drawn
```

---

## Step 6 — Full CAD-to-Photo Pipeline

```python
def run_cad_to_photo(mesh_fp: str, background_fp: str, output_fp: str,
                      subject_h_m: float = 1.0,
                      place_cx_frac: float = 0.5,
                      place_depth_m: float = 3.0) -> dict:
    """
    Full pipeline: 3D mesh file + background photo → photorealistic composite PNG.

    mesh_fp: path to OBJ/STL/GLTF file
    background_fp: path to background PNG
    output_fp: output PNG path
    subject_h_m: real-world height of subject in meters (for scale)
    place_cx_frac: horizontal center position in image (0-1)
    place_depth_m: how far from camera in meters

    Returns stats dict.
    """
    import time; t0 = time.time()

    # ── Parse background image ────────────────────────────────────────────
    def parse_png_quick(fp):
        with open(fp,'rb') as f: raw=f.read()
        pos=8; W=H=0; idat=b''; clr=0
        while pos<len(raw):
            ln=struct.unpack('>I',raw[pos:pos+4])[0]; tag=raw[pos+4:pos+8]
            dat=raw[pos+8:pos+8+ln]; pos+=12+ln
            if tag==b'IHDR': W,H=struct.unpack('>II',dat[:8]); clr=dat[9]
            elif tag==b'IDAT': idat+=dat
            elif tag==b'IEND': break
        ch={2:3,6:4}.get(clr,3); sl=W*ch; dec=zlib.decompress(idat)
        pixels=[]; prev=bytes(sl)
        for y in range(H):
            base=y*(sl+1); flt=dec[base]; row=bytearray(dec[base+1:base+1+sl])
            if flt==1:
                for i in range(ch,len(row)): row[i]=(row[i]+row[i-ch])&0xFF
            elif flt==2:
                for i in range(len(row)): row[i]=(row[i]+prev[i])&0xFF
            rp=[]
            for x in range(W):
                i=x*ch
                if clr==6: r2,g2,b2=row[i],row[i+1],row[i+2]
                elif clr==2: r2,g2,b2=row[i],row[i+1],row[i+2]
                else: r2=g2=b2=row[i]
                rp.append((r2,g2,b2,255))
            pixels.append(rp); prev=bytes(row)
        return W,H,pixels

    print(f"\n[CAD-TO-PHOTO] mesh={mesh_fp} bg={background_fp}")
    BW, BH, bg_pixels = parse_png_quick(background_fp)
    print(f"  Background: {BW}×{BH}")

    # ── Analyze scene FIRST ───────────────────────────────────────────────
    # Import scene-analyzer functions
    from scene_analyzer import (analyze_scene, detect_all_boundaries,
                                 extract_full_lighting_model)
    scene_data = analyze_scene(background_fp)
    scene_props = scene_data["lighting"]
    horizon_y = scene_data["horizon_y"]
    print(f"  Scene: horizon_y={horizon_y} light={scene_props['light_direction']}")

    # ── Load and index mesh ───────────────────────────────────────────────
    from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions
    from mesh_analyzer import load_mesh, index_mesh, compute_geometry_5x, compute_face_material_properties

    geo = load_mesh(mesh_fp)
    print(f"  Mesh: {len(geo['vertices'])} verts, {len(geo['faces'])} faces")

    mesh_vapor = create_vapor({
        "types": {
            "Vertex": {"fields": {
                "x":{"type":"number","index":"range"},"y":{"type":"number","index":"range"},
                "z":{"type":"number","index":"range"},
                "normal_x":{"type":"number","index":"none"},"normal_y":{"type":"number","index":"none"},
                "normal_z":{"type":"number","index":"none"},
                "u":{"type":"number","index":"range"},"v":{"type":"number","index":"range"},
                "mat_idx":{"type":"number","index":"exact"},"valence":{"type":"number","index":"range"},
                "component":{"type":"string","index":"exact"},"curvature":{"type":"number","index":"range"},
                "material_zone":{"type":"string","index":"exact"},
            }, "relationships": {
                "CONNECTED_TO":{"targetTypes":["Vertex"],"directed":False,"cardinality":"many-to-many"},
                "PART_OF_FACE":{"targetTypes":["Face"],"directed":True,"cardinality":"many-to-many"},
                "SHARES_EDGE":{"targetTypes":["Vertex"],"directed":False,"cardinality":"many-to-many"},
            }},
            "Face": {"fields": {
                "face_idx":{"type":"number","index":"range"},"mat_idx":{"type":"number","index":"exact"},
                "area":{"type":"number","index":"range"},
                "normal_x":{"type":"number","index":"none"},"normal_y":{"type":"number","index":"none"},
                "normal_z":{"type":"number","index":"none"},
                "center_x":{"type":"number","index":"range"},"center_y":{"type":"number","index":"range"},
                "center_z":{"type":"number","index":"range"},
                "is_boundary":{"type":"boolean","index":"exact"},"component":{"type":"string","index":"exact"},
                "material_zone":{"type":"string","index":"exact"},
                "roughness_class":{"type":"string","index":"exact"},"specularity":{"type":"number","index":"range"},
            }, "relationships": {
                "ADJACENT_TO":{"targetTypes":["Face"],"directed":False,"cardinality":"many-to-many"},
                "USES_MATERIAL":{"targetTypes":["Material"],"directed":True,"cardinality":"many-to-one"},
            }},
            "Edge": {"fields": {
                "length":{"type":"number","index":"range"},"is_boundary":{"type":"boolean","index":"exact"},
                "is_crease":{"type":"boolean","index":"exact"},"dihedral_angle":{"type":"number","index":"range"},
            }, "relationships": {
                "CONNECTS":{"targetTypes":["Vertex"],"directed":False,"cardinality":"one-to-many"},
                "BORDERS":{"targetTypes":["Face"],"directed":False,"cardinality":"many-to-many"},
            }},
            "Material": {"fields": {
                "name":{"type":"string","index":"exact"},"base_r":{"type":"number","index":"range"},
                "base_g":{"type":"number","index":"range"},"base_b":{"type":"number","index":"range"},
                "roughness":{"type":"number","index":"range"},"metallic":{"type":"number","index":"range"},
                "face_count":{"type":"number","index":"range"},"zone_id":{"type":"string","index":"exact"},
                "roughness_class":{"type":"string","index":"exact"},
            }, "relationships": {}},
        }
    })

    vertex_ids, face_ids, mat_ids = index_mesh(mesh_vapor, geo)
    compute_geometry_5x(mesh_vapor, vertex_ids, face_ids)
    compute_face_material_properties(mesh_vapor, face_ids)

    # ── Camera calibration ───────────────────────────────────────────────
    vps = detect_vanishing_points(bg_pixels, BW, BH, horizon_y)
    cam_params = calibrate_virtual_camera(vps, BW, BH, subject_h_m)

    # Position object in scene
    cam_params["camera_pos"] = (
        (place_cx_frac-0.5)*place_depth_m*0.8,
        cam_params["cam_height_m"],
        -place_depth_m
    )

    # ── Project and rasterize ─────────────────────────────────────────────
    proj = project_mesh_to_screen(mesh_vapor, cam_params)
    rasterized = rasterize_faces(mesh_vapor, proj, cam_params, BW, BH)

    # ── Composite into background ─────────────────────────────────────────
    canvas = [[list(bg_pixels[y][x][:3])+[255] for x in range(BW)] for y in range(BH)]

    # Shadow first (goes under mesh)
    ground_y = int(BH*0.85)
    add_mesh_shadow(canvas, rasterized, BW, BH, scene_props, ground_y)

    # Render mesh faces
    render_stats = render_mesh_into_scene(canvas, rasterized, mesh_vapor,
                                           mat_ids, scene_props, cam_params, BW, BH)

    # Hard edge highlights
    render_hard_edges(canvas, mesh_vapor, proj, BW, BH, scene_props)

    mesh_vapor.destroy()

    # ── Write output ──────────────────────────────────────────────────────
    def write_png(fp, w, h, px_canvas):
        def make_chunk(tag,body):
            import zlib
            crc=zlib.crc32(tag+body)&0xFFFFFFFF
            return struct.pack('>I',len(body))+tag+body+struct.pack('>I',crc)
        rows=bytearray()
        for row in px_canvas:
            rows+=b'\x00'
            for p in row: rows+=bytes([max(0,min(255,p[0])),max(0,min(255,p[1])),
                                        max(0,min(255,p[2])),255])
        sig=b'\x89PNG\r\n\x1a\n'
        ihdr=make_chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))
        idat=make_chunk(b'IDAT',zlib.compress(bytes(rows),9))
        iend=make_chunk(b'IEND',b'')
        with open(fp,'wb') as f: f.write(sig+ihdr+idat+iend)

    out = [[tuple(canvas[y][x]) for x in range(BW)] for y in range(BH)]
    write_png(output_fp, BW, BH, out)

    elapsed = time.time()-t0
    print(f"\n[CAD-TO-PHOTO] Done in {elapsed:.1f}s → {output_fp}")

    return {
        "mesh": mesh_fp, "background": background_fp, "output": output_fp,
        "vertices": len(vertex_ids), "faces": len(face_ids),
        "projected": len(proj), "rendered_faces": render_stats["faces_rendered"],
        "rendered_pixels": render_stats["pixels"],
        "camera": cam_params, "scene": scene_props,
        "elapsed_s": elapsed,
    }
```

---

## Output

Report: mesh statistics (vertex/face/edge counts), projection stats (vertices visible),
raster stats (faces drawn, pixels written), shadow applied, hard edges highlighted,
camera parameters inferred (fov, position, height), scene lighting used.
Save output PNG to /mnt/user-data/outputs/.
