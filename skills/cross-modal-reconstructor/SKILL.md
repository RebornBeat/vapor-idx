# Cross-Modal Reconstructor Skill

## Purpose

Use this skill when asked to convert data from one modality into another using
vapor-idx as the indexed bridge. The source is decomposed into typed records,
Claude traverses the index semantically, and the target modality is emitted as
a file or structured output.

## When to trigger

- "Convert this SVG into a CSS layout"
- "Turn this pixel data into a vector graphic"
- "Convert this 3D mesh into a Blender script"
- "Extract the structure of this HTML and emit it as an OBJ scene graph"
- "Take this audio waveform data and emit MIDI note events"
- "Turn this code call graph into a Markdown dependency report"
- Any task that bridges two different data modalities

## Environment

Python computer-use. Install if needed:
```bash
pip install vapor-idx
```

## The three-step pattern

Every cross-modal reconstruction follows the same structure:

1. **Decompose** — index the source modality into vapor-idx
2. **Traverse** — query and traverse the index; apply semantic reasoning
3. **Reconstruct** — emit the target modality from the index

## Common transformations

### SVG → CSS layout

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter
import xml.etree.ElementTree as ET

vapor = create_vapor({
    "types": {
        "Element": {
            "fields": {
                "tag":    {"type": "string", "index": "exact"},
                "eid":    {"type": "string", "index": "exact"},
                "x":      {"type": "number", "index": "range"},
                "y":      {"type": "number", "index": "range"},
                "width":  {"type": "number", "index": "range"},
                "height": {"type": "number", "index": "range"},
                "fill":   {"type": "string", "index": "exact"},
                "z":      {"type": "number", "index": "range"},
            },
            "relationships": {
                "CONTAINS": {"targetTypes": ["Element"], "directed": True, "cardinality": "one-to-many"},
            },
        },
    },
})

# --- DECOMPOSE ---
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
        "tag": tag,
        "eid": el.get("id",""),
        "x": fl(el.get("x", el.get("cx","0"))),
        "y": fl(el.get("y", el.get("cy","0"))),
        "width":  fl(el.get("width",  el.get("r","0"))),
        "height": fl(el.get("height", el.get("r","0"))),
        "fill": el.get("fill","none"),
        "z": z[0],
    })
    if parent_id: vapor.relate(parent_id, "CONTAINS", vid)
    for child in el: index_el(child, vid)

for child in root: index_el(child, None)

# --- TRAVERSE + RECONSTRUCT ---
all_els = vapor.query(QueryOptions(type="Element", order_by=("z","asc")))
css_lines = ["/* Cross-modal: SVG → CSS by vapor-idx */", ".root { position: relative; }"]
for rec in all_els.records:
    d = rec.data
    eid = d.get("eid") or f"e{rec.id[:6]}"
    fill = d.get("fill","transparent") or "transparent"
    css_lines.append(f"#{eid} {{ position:absolute; left:{d['x']:.1f}px; top:{d['y']:.1f}px; width:{d['width']:.1f}px; height:{d['height']:.1f}px; background:{fill}; z-index:{int(d['z'])}; }}")

open("output.css","w").write("\n".join(css_lines))
vapor.destroy()
print("Saved output.css")
```

### Pixel index → SVG regions

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

vapor = create_vapor({
    "types": {
        "Pixel": {
            "fields": {
                "x": {"type":"number","index":"range"},
                "y": {"type":"number","index":"range"},
                "r": {"type":"number","index":"range"},
                "g": {"type":"number","index":"range"},
                "b": {"type":"number","index":"range"},
                "brightness": {"type":"number","index":"range"},
                "region": {"type":"string","index":"exact"},
            },
            "relationships": {
                "ADJACENT_TO": {"targetTypes":["Pixel"],"directed":False,"cardinality":"many-to-many"},
            },
        },
        "Region": {
            "fields": {
                "label": {"type":"string","index":"keyword"},
                "area":  {"type":"number","index":"range"},
                "cx":    {"type":"number","index":"range"},
                "cy":    {"type":"number","index":"range"},
                "avg_r": {"type":"number","index":"range"},
                "avg_g": {"type":"number","index":"range"},
                "avg_b": {"type":"number","index":"range"},
            },
            "relationships": {},
        },
    },
})

from PIL import Image
img = Image.open("input.png").convert("RGB").resize((128, 128))
pix = img.load()
w, h = img.size
id_grid: dict[tuple,str] = {}

for y in range(h):
    for x in range(w):
        r, g, b = pix[x, y]
        pid = vapor.store("Pixel", {
            "x": x, "y": y, "r": r, "g": g, "b": b,
            "brightness": (r+g+b)/3, "region": "",
        })
        id_grid[(x, y)] = pid

for y in range(h):
    for x in range(w):
        if x + 1 < w: vapor.relate(id_grid[(x,y)], "ADJACENT_TO", id_grid[(x+1,y)])
        if y + 1 < h: vapor.relate(id_grid[(x,y)], "ADJACENT_TO", id_grid[(x,y+1)])

# Detect dark vs light regions by brightness threshold
# Claude applies semantic reasoning: dark = shadow/background, light = foreground
dark_pixels  = vapor.query(QueryOptions(type="Pixel", where=FieldFilter(field="brightness",op="lt",value=100)))
light_pixels = vapor.query(QueryOptions(type="Pixel", where=FieldFilter(field="brightness",op="gte",value=100)))

def make_region(vapor, pixels, label):
    if not pixels.records: return
    xs = [r.data["x"] for r in pixels.records]
    ys = [r.data["y"] for r in pixels.records]
    avg_r = sum(r.data["r"] for r in pixels.records) / len(pixels.records)
    avg_g = sum(r.data["g"] for r in pixels.records) / len(pixels.records)
    avg_b = sum(r.data["b"] for r in pixels.records) / len(pixels.records)
    rid = vapor.store("Region", {
        "label": label, "area": len(pixels.records),
        "cx": sum(xs)/len(xs), "cy": sum(ys)/len(ys),
        "avg_r": avg_r, "avg_g": avg_g, "avg_b": avg_b,
    })
    return rid

make_region(vapor, dark_pixels,  "dark-region")
make_region(vapor, light_pixels, "light-region")

# Reconstruct as SVG
regions = vapor.query(QueryOptions(type="Region"))
svg_lines = [f'<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">']
for rec in regions.records:
    d = rec.data
    area = d["area"]
    size = area ** 0.5
    cx, cy = d["cx"], d["cy"]
    r = int(d["avg_r"]); g = int(d["avg_g"]); b = int(d["avg_b"])
    svg_lines.append(
        f'  <rect x="{cx-size/2:.1f}" y="{cy-size/2:.1f}" '
        f'width="{size:.1f}" height="{size:.1f}" '
        f'fill="rgb({r},{g},{b})" opacity="0.7">'
        f'<title>{d["label"]} ({int(area)}px)</title></rect>'
    )
svg_lines.append("</svg>")
open("output.svg","w").write("\n".join(svg_lines))
vapor.destroy()
print("Saved output.svg")
```

### OBJ mesh → Blender Python script

```python
# Step 1: Use mesh-analyzer skill to index the OBJ
# Step 2: Call reconstruct_blender() from that skill
# Step 3: Save and report

# Quick version:
from vapor_idx import create_vapor, QueryOptions
vapor = create_vapor({ "types": { "Vertex": { "fields": { "x": {"type":"number","index":"range"}, "y": {"type":"number","index":"range"}, "z": {"type":"number","index":"range"} }, "relationships": {} } } })

obj_text = open("model.obj").read()
id_list = []
for line in obj_text.splitlines():
    p = line.strip().split()
    if p and p[0] == 'v':
        vid = vapor.store("Vertex", {"x":float(p[1]),"y":float(p[2]),"z":float(p[3])})
        id_list.append(vid)

all_v = vapor.query(QueryOptions(type="Vertex"))
lines = ["import bpy, bmesh",
         "mesh = bpy.data.meshes.new('Imported')",
         "obj  = bpy.data.objects.new('Imported', mesh)",
         "bpy.context.scene.collection.objects.link(obj)",
         "bm = bmesh.new()"]
for rec in all_v.records:
    lines.append(f"bm.verts.new(({rec.data['x']:.6f},{rec.data['y']:.6f},{rec.data['z']:.6f}))")
lines += ["bm.to_mesh(mesh)","bm.free()","mesh.update()"]
open("imported.py","w").write("\n".join(lines))
vapor.destroy()
print("Run: blender --background --python imported.py")
```

## Checkpoint pattern

For complex transformations, snapshot between phases:

```python
# After decomposition — safe to checkpoint
snap_decomposed = vapor.snapshot()

# After traversal — save analysis results
snap_analysed = vapor.snapshot()

# If reconstruction fails, restore to analysis state
# and try a different reconstruction strategy
vapor2 = vapor.restore(snap_analysed)
```

## Output

Report the source modality element count, the transformation applied, and the
output file(s) saved with their full paths.
