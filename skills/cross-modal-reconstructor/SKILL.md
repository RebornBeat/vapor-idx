---
name: Cross Modal Reconstructor
description: Convert data from one modality into another using vapor-idx as the indexed bridge. Supported transformations include SVG→CSS, pixel→SVG, OBJ→Blender, image+image→composite, image→skeleton, mesh→photo-projection, code→dependency-graph, audio→MIDI. The three-step pattern always applies — Decompose, Traverse, Reconstruct. Pure Python, no external libraries beyond vapor-idx.
version: 3.0.0
tools:
  - computer_use
---

# Cross-Modal Reconstructor Skill v3.0

## Purpose

Bridge two data modalities using vapor-idx as the semantic middle layer.
The source modality is decomposed into vapor records, Claude traverses the index
to understand structure and relationships, and the target modality is emitted
from the index.

Every transformation follows the same three-step pattern:
1. **Decompose** — index source into vapor-idx
2. **Traverse** — query and traverse; apply semantic reasoning
3. **Reconstruct** — emit target modality from index

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct snake_case
vapor.getRelationships(...)  ← DOES NOT EXIST, will crash
```

Direction for each relationship type:
- Undirected (ADJACENT_TO, SYMMETRICAL_WITH): use "both"
- Directed (PART_OF, CONTAINS, SPATIALLY_ABOVE): use explicit "outgoing"/"incoming"
- SAME_CLUSTER: "outgoing" from pixel (pixel→cluster), "incoming" from cluster

## When to Trigger

- "Convert this SVG into a CSS layout"
- "Turn this pixel data into a vector graphic"
- "Convert this 3D mesh into a Blender script"
- "Place this person in this environment" (image+image → composite)
- "Detect skeleton from this image and apply riding pose"
- "Project this CAD model onto this photo"
- "Turn this code call graph into a dependency report"
- Any task that bridges two different data modalities

## Environment

```bash
pip install vapor-idx
```

---

## Transformation 1 — Image + Image → Composite (Core Use Case)

This is the most important transformation class and was missing from v2.0.

```python
"""
COMPOSITE: subject_image + environment_image → placed_subject_in_environment

Pipeline:
  1. scene-analyzer skill → analyze environment (FIRST)
  2. pixel-analyzer skill → extract subject
  3. lighting-engine skill → re-light subject to match scene
  4. pixel-analyzer → composite with physical interactions
  5. material-engine → apply materials + footprints
  6. output final PNG

Call order:
"""
from skills.scene_analyzer import analyze_scene
from skills.pixel_analyzer import (
    load_image, make_vapor_schema, index_pixels, compute_sobel_edges,
    detect_clusters, build_cluster_relationships, semantic_label_clusters_5x,
    infer_objects, isolate_foreground_halosafe, classify_motion_artifacts,
    extract_scene_lighting, detect_structural_boundary, segment_environment_zones,
    apply_scene_lighting_to_mask, generate_contact_zone, generate_ground_reflection,
    render_horizon_glow, apply_depth_fog, scale_mask_to_target,
    paint_mask_onto_canvas, compute_perspective_scale, write_png_raw
)

# Example invocation:
SUBJECT_FP  = "/home/claude/subject.png"
ENVIRON_FP  = "/home/claude/background.png"
OUTPUT_FP   = "/home/claude/composite.png"

# Step 1: analyze scene FIRST
scene_data = analyze_scene(ENVIRON_FP)
scene_props = scene_data["lighting"]
horizon_y = scene_data["horizon_y"]
BW = scene_data["width"]; BH = scene_data["height"]

# Step 2: extract subject
SW,SH,subj_pix = load_image(SUBJECT_FP)
v_subj = make_vapor_schema()
grid_s,_ = index_pixels(v_subj, SW, SH, subj_pix, step=2, label="SUBJ")
compute_sobel_edges(v_subj, grid_s, SW, SH, step=2, label="SUBJ")
cids_s,_ = detect_clusters(v_subj, grid_s, SW, SH, step=2, label="SUBJ")
build_cluster_relationships(v_subj, cids_s, label="SUBJ")
semantic_label_clusters_5x(v_subj, cids_s, image_type="person", label="SUBJ")
infer_objects(v_subj, image_type="person")
subj_mask,_ = isolate_foreground_halosafe(
    v_subj, grid_s, SW, SH,
    bg_label_keywords=["sky","sand","water","background","white_background"],
    step=2, label="SUBJ"
)
artifacts = classify_motion_artifacts(v_subj, subj_mask, step=2)
subj_mask.update({(x,y): subj_pix[y][x][:3]+(255,) for (x,y) in artifacts})

# Step 3: re-light subject
subj_lit = apply_scene_lighting_to_mask(subj_mask, scene_props, BH)

# Step 4: scale + composite
feet_y = int(BH * 0.88)
scale_f = compute_perspective_scale(horizon_y, feet_y, BH)
target_h = int(scale_f * (BH-horizon_y) * 1.1)
scaled_mask,_ = scale_mask_to_target(subj_lit, target_h, step=2)
BW2,BH2,bg_pix = load_image(ENVIRON_FP)
canvas = [[list(bg_pix[y][x][:3])+[255] for x in range(BW2)] for y in range(BH2)]
placement = paint_mask_onto_canvas(canvas, scaled_mask, BW2, BH2,
                                    cx_frac=0.52, feet_y=feet_y,
                                    scene_props=scene_props)
if placement:
    generate_contact_zone(canvas, BW2, BH2,
                          placement["cx2"], feet_y,
                          placement["tgt_w"], scene_props)
    generate_ground_reflection(canvas, scaled_mask, BW2, BH2, feet_y, scene_props)
render_horizon_glow(canvas, BW2, BH2, horizon_y, scene_props)
apply_depth_fog(canvas, BW2, BH2, scene_props)
v_subj.destroy()
out = [[tuple(canvas[y][x]) for x in range(BW2)] for y in range(BH2)]
write_png_raw(OUTPUT_FP, BW2, BH2, out)
print(f"Composite saved: {OUTPUT_FP}")
```

---

## Transformation 2 — SVG → CSS Layout

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter
import xml.etree.ElementTree as ET

vapor = create_vapor({
    "types": {
        "Element": {
            "fields": {
                "tag":    {"type":"string","index":"exact"},
                "eid":    {"type":"string","index":"exact"},
                "x":      {"type":"number","index":"range"},
                "y":      {"type":"number","index":"range"},
                "width":  {"type":"number","index":"range"},
                "height": {"type":"number","index":"range"},
                "fill":   {"type":"string","index":"exact"},
                "z":      {"type":"number","index":"range"},
            },
            "relationships": {
                "CONTAINS": {"targetTypes":["Element"],"directed":True,"cardinality":"one-to-many"},
            },
        },
    },
})

# DECOMPOSE
root = ET.fromstring(open("input.svg").read())
z = [0]
def index_el(el, parent_id):
    tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
    if tag in ("defs","style","script"): return
    z[0] += 1
    def fl(v, d=0.0):
        try: return float(str(v).rstrip("px%"))
        except: return d
    vid = vapor.store("Element", {
        "tag": tag, "eid": el.get("id",""),
        "x": fl(el.get("x",el.get("cx","0"))),
        "y": fl(el.get("y",el.get("cy","0"))),
        "width":  fl(el.get("width",  el.get("r","0"))),
        "height": fl(el.get("height", el.get("r","0"))),
        "fill": el.get("fill","none"), "z": float(z[0]),
    })
    if parent_id: vapor.relate(parent_id, "CONTAINS", vid)
    for child in el: index_el(child, vid)

for child in root: index_el(child, None)

# TRAVERSE + RECONSTRUCT
all_els = vapor.query(QueryOptions(type="Element", order_by=("z","asc")))
css = ["/* SVG→CSS by vapor-idx */", ".root { position: relative; }"]
for rec in all_els.records:
    d = rec.data; eid = d.get("eid") or f"e{rec.id[:6]}"
    fill = d.get("fill","transparent") or "transparent"
    css.append(f"#{eid} {{ position:absolute; left:{d['x']:.1f}px; top:{d['y']:.1f}px; "
               f"width:{d['width']:.1f}px; height:{d['height']:.1f}px; "
               f"background:{fill}; z-index:{int(d['z'])}; }}")

open("output.css","w").write("\n".join(css))
vapor.destroy()
print("Saved output.css")
```

---

## Transformation 3 — Pixel Index → SVG Regions

```python
"""
Analyzes a pixel image via vapor-idx and emits an SVG representation
of its detected semantic regions. Uses pixel-analyzer pipeline internally.
"""
# Step 1: Run full pixel-analyzer pipeline (see pixel-analyzer skill)
# Step 2: Query cluster records from vapor
# Step 3: Emit SVG with one rect per cluster, colored by cluster avg color

from vapor_idx import create_vapor, QueryOptions

# After running pixel-analyzer pipeline on source image...
all_clusters = vapor.query(QueryOptions(type="Cluster",
                            order_by=("avg_brightness","desc")))
svg_lines = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg">']

for rec in all_clusters.records:
    d = rec.data
    if d["size"] < 30: continue
    r = int(d["avg_r"]); g = int(d["avg_g"]); b = int(d["avg_b"])
    lbl = d.get("semantic_class","?")
    svg_lines.append(
        f'  <rect x="{d["min_x"]:.0f}" y="{d["min_y"]:.0f}" '
        f'width="{d["width_span"]:.0f}" height="{d["height_span"]:.0f}" '
        f'fill="rgb({r},{g},{b})" opacity="0.75">'
        f'<title>{lbl} ({int(d["size"])}px)</title></rect>'
    )

svg_lines.append("</svg>")
open("output.svg","w").write("\n".join(svg_lines))
print("Saved output.svg")
```

---

## Transformation 4 — OBJ/GLTF Mesh → Blender Python Script

```python
"""
Uses mesh-analyzer skill internally.
Reads any OBJ/STL/GLTF file, indexes into vapor, reconstructs as Blender script.
"""
# Step 1: Use mesh-analyzer skill's load_mesh() + index_mesh()
# Step 2: Use reconstruct_blender() from that skill

from vapor_idx import create_vapor, QueryOptions

# Quick vertex-only version:
vapor2 = create_vapor({"types":{"Vertex":{"fields":{
    "x":{"type":"number","index":"range"},
    "y":{"type":"number","index":"range"},
    "z":{"type":"number","index":"range"}
},"relationships":{}}}})

for line in open("model.obj"):
    p = line.strip().split()
    if p and p[0]=='v':
        vapor2.store("Vertex",{"x":float(p[1]),"y":float(p[2]),"z":float(p[3])})

lines = ["import bpy,bmesh",
         "mesh=bpy.data.meshes.new('Imported')",
         "obj=bpy.data.objects.new('Imported',mesh)",
         "bpy.context.scene.collection.objects.link(obj)",
         "bm=bmesh.new()"]
for rec in vapor2.query(QueryOptions(type="Vertex")).records:
    lines.append(f"bm.verts.new(({rec.data['x']:.6f},{rec.data['y']:.6f},{rec.data['z']:.6f}))")
lines += ["bm.to_mesh(mesh)","bm.free()","mesh.update()"]
open("imported.py","w").write("\n".join(lines))
vapor2.destroy()
print("Run: blender --background --python imported.py")
```

---

## Transformation 5 — Image → 2D Skeleton (Pose Detection)

```python
"""
Extract a 2D skeleton from a person/animal image for pose manipulation.
Prerequisite: pixel-analyzer pipeline already run on the image.
Uses skeleton-2d skill.
"""
from skills.skeleton_2d import (
    detect_joints_from_clusters, build_skeleton_graph,
    validate_skeleton_5x, apply_pose_transform,
    POSE_RIDING, POSE_SITTING
)

# After pixel-analyzer has run and produced vapor instance with semantic labels:
joint_positions = detect_joints_from_clusters(vapor, cluster_ids, image_h=SH)
joint_ids = build_skeleton_graph(vapor, joint_positions)
validation = validate_skeleton_5x(vapor, joint_ids, joint_positions)

if validation["plausibility"] > 0.4:
    # Apply target pose
    posed_mask = apply_pose_transform(fg_mask, joint_positions,
                                       POSE_RIDING, joint_ids, vapor)
    print(f"Pose applied: {len(posed_mask)} pixels in riding position")
else:
    print(f"Low skeleton confidence ({validation['plausibility']:.2f}) — using original pose")
    posed_mask = fg_mask
```

---

## Transformation 6 — Code Dependency Graph → Markdown Report

```python
"""
Parse Python source files, build a call graph in vapor-idx,
traverse to find clusters of related functions, emit Markdown dependency report.
"""
import ast
from vapor_idx import create_vapor, QueryOptions, TraversalOptions

vapor3 = create_vapor({
    "types": {
        "Function": {
            "fields": {
                "name":     {"type":"string","index":"exact"},
                "module":   {"type":"string","index":"exact"},
                "lineno":   {"type":"number","index":"range"},
                "complexity":{"type":"number","index":"range"},
            },
            "relationships": {
                "CALLS":    {"targetTypes":["Function"],"directed":True,"cardinality":"many-to-many"},
                "DEFINED_IN":{"targetTypes":["Function"],"directed":True,"cardinality":"many-to-one"},
            },
        },
    },
})

def index_python_file(vapor_inst, filepath: str) -> dict:
    func_ids = {}
    with open(filepath) as f:
        tree = ast.parse(f.read())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            fid = vapor_inst.store("Function", {
                "name": node.name, "module": filepath,
                "lineno": float(node.lineno), "complexity": 1.0,
            })
            func_ids[node.name] = fid
    return func_ids

func_ids = index_python_file(vapor3, "source.py")

# Resolve calls (simplified)
all_funcs = vapor3.query(QueryOptions(type="Function"))
for rec in all_funcs.records:
    for other in all_funcs.records:
        if rec.id == other.id: continue
        # If function name appears in function body (crude but works for demo)
        if other.data["name"] in rec.data.get("name",""):
            try: vapor3.relate(rec.id, "CALLS", other.id)
            except: pass

# Emit Markdown
md = ["# Dependency Report\n"]
for rec in vapor3.query(QueryOptions(type="Function")).records:
    calls = vapor3.get_relationships(rec.id, "CALLS", "outgoing")
    callee_names = [vapor3.get(e.target_id).data["name"] for e in calls if vapor3.get(e.target_id)]
    md.append(f"## `{rec.data['name']}` ({rec.data['module']}:{int(rec.data['lineno'])})")
    if callee_names:
        md.append(f"Calls: {', '.join(f'`{n}`' for n in callee_names)}")
    md.append("")

open("dependency_report.md","w").write("\n".join(md))
vapor3.destroy()
print("Saved dependency_report.md")
```

---

## Checkpoint Pattern

For complex multi-step transformations, snapshot between phases to allow rollback:

```python
# After decomposition — save baseline
snap_decomposed = vapor.snapshot()

# After semantic analysis — save analysis results
snap_analyzed = vapor.snapshot()

# If reconstruction fails, restore to analysis state
try:
    # ... complex reconstruction ...
    pass
except Exception as e:
    print(f"Reconstruction failed: {e} — restoring to analyzed state")
    vapor_restored = vapor.restore(snap_analyzed)
    # Try alternative reconstruction strategy
```

---

## Transformation Selection Guide

| Input | Output | Transformation Name | Key Skills Used |
|-------|--------|---------------------|-----------------|
| Subject PNG + Background PNG | Composite PNG | `image_composite` | pixel-analyzer, scene-analyzer, lighting-engine |
| Person PNG + Pose name | Posed PNG | `image_skeleton_pose` | pixel-analyzer, skeleton-2d |
| OBJ/STL/GLTF | Blender .py | `mesh_to_blender` | mesh-analyzer |
| CAD mesh + Photo | Integrated PNG | `cad_to_photo` | mesh-analyzer, cad-to-photo, pixel-analyzer |
| SVG | CSS | `svg_to_css` | design-indexer |
| HTML | SVG | `html_to_svg` | design-indexer |
| Image | SVG regions | `pixel_to_svg` | pixel-analyzer |
| Python files | Markdown | `code_to_report` | custom vapor graph |
| Background PNG | Modified PNG | `environment_modify` | scene-analyzer, environment-modifier |
| Subject with color | Recolored subject | `color_swap` | color-reconstructor |

---

## Output

Report: source modality record count, transformation name, output file(s) saved
with full paths. For compositing: include all vapor stats from all instances,
placement info, lighting values applied, contact zone info.
