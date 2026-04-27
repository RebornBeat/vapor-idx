# Pixel Analyzer Skill

## Purpose

Use this skill when asked to analyze, transform, understand, or reconstruct image
data without ML dependencies. This skill uses vapor-idx to index pixels as typed
records and applies semantic reasoning over the indexed structure.

## When to trigger

- "Analyze this image and describe the regions"
- "Find all red areas in this image"
- "Convert this image to a greyscale version"
- "Detect the edges in this image"
- "Reconstruct this image with colour inversion"
- "Extract the dominant colour regions as SVG shapes"
- Any task involving understanding or transforming image pixels without YOLO/ML

## Environment

This skill runs in the Python computer-use environment.

Install vapor-idx if not present:
```bash
pip install vapor-idx
```

## Step-by-step instructions

### Step 1 — Declare the pixel schema

Always start with this schema. Adjust field definitions if the task needs
additional properties (e.g., `hue`, `saturation` for HSL queries).

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

vapor = create_vapor({
    "types": {
        "Pixel": {
            "fields": {
                "x":          {"type": "number", "index": "range"},
                "y":          {"type": "number", "index": "range"},
                "r":          {"type": "number", "index": "range"},
                "g":          {"type": "number", "index": "range"},
                "b":          {"type": "number", "index": "range"},
                "a":          {"type": "number", "index": "range"},
                "brightness": {"type": "number", "index": "range"},
                "edge_score": {"type": "number", "index": "range"},
                "region":     {"type": "string", "index": "exact"},
            },
            "relationships": {
                "ADJACENT_TO": {
                    "targetTypes": ["Pixel"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
                "BELONGS_TO": {
                    "targetTypes": ["Region"],
                    "directed":    True,
                    "cardinality": "many-to-one",
                },
            },
        },
        "Region": {
            "fields": {
                "label":     {"type": "string", "index": "keyword"},
                "area":      {"type": "number", "index": "range"},
                "center_x":  {"type": "number", "index": "range"},
                "center_y":  {"type": "number", "index": "range"},
                "avg_r":     {"type": "number", "index": "range"},
                "avg_g":     {"type": "number", "index": "range"},
                "avg_b":     {"type": "number", "index": "range"},
            },
            "relationships": {
                "BORDERS": {
                    "targetTypes": ["Region"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
            },
        },
    },
})
```

### Step 2 — Load and index the image

Load the image using PIL/Pillow (pre-installed in computer-use):

```python
from PIL import Image

img = Image.open("input.png").convert("RGBA")
pixels_pil = img.load()
width, height = img.size

# For large images, downsample first to stay within memory budget:
# img = img.resize((min(width, 256), min(height, 256)), Image.LANCZOS)
# pixels_pil = img.load()
# width, height = img.size

id_grid: dict[tuple[int, int], str] = {}

for y in range(height):
    for x in range(width):
        r, g, b, a = pixels_pil[x, y]
        brightness = (r + g + b) / 3
        record_id = vapor.store("Pixel", {
            "x": x, "y": y,
            "r": r, "g": g, "b": b, "a": a,
            "brightness": brightness,
            "edge_score": 0.0,
            "region": "",
        })
        id_grid[(x, y)] = record_id

# Build 4-connectivity adjacency relationships
for y in range(height):
    for x in range(width):
        pid = id_grid[(x, y)]
        if x + 1 < width:
            vapor.relate(pid, "ADJACENT_TO", id_grid[(x + 1, y)])
        if y + 1 < height:
            vapor.relate(pid, "ADJACENT_TO", id_grid[(x, y + 1)])

print(f"Indexed {width * height} pixels. Stats: {vapor.stats()}")
```

### Step 3 — Query and analyse

Use semantic queries to find pixels of interest. Apply your own reasoning to
interpret the results.

**Find dark regions (potential shadows or dark objects):**
```python
dark = vapor.query(QueryOptions(
    type="Pixel",
    where=FieldFilter(field="brightness", op="lt", value=80),
))
print(f"Dark pixels: {dark.total}")
```

**Find red pixels (e.g., detecting red objects):**
```python
red = vapor.query(QueryOptions(
    type="Pixel",
    where=[
        FieldFilter(field="r", op="gt", value=180),
        FieldFilter(field="g", op="lt", value=100),
        FieldFilter(field="b", op="lt", value=100),
    ],
))
```

**Find pixels in the upper-left quadrant:**
```python
top_left = vapor.query(QueryOptions(
    type="Pixel",
    where=[
        FieldFilter(field="x", op="lt", value=width // 2),
        FieldFilter(field="y", op="lt", value=height // 2),
    ],
))
```

### Step 4 — Compute edge scores (optional)

```python
for y in range(1, height - 1):
    for x in range(1, width - 1):
        def b(dx, dy):
            rec = vapor.get(id_grid[(x + dx, y + dy)])
            return rec.data['brightness'] if rec else 0
        gx = -b(-1,-1) + b(1,-1) - 2*b(-1,0) + 2*b(1,0) - b(-1,1) + b(1,1)
        gy = -b(-1,-1) - 2*b(0,-1) - b(1,-1) + b(-1,1) + 2*b(0,1) + b(1,1)
        edge_score = (gx**2 + gy**2) ** 0.5
        if edge_score > 10:
            vapor.update(id_grid[(x, y)], {"edge_score": edge_score})
```

### Step 5 — Apply transformations

Update pixel values in the index before reconstructing:

```python
# Invert colours
all_pixels = vapor.query(QueryOptions(type="Pixel"))
for rec in all_pixels.records:
    vapor.update(rec.id, {
        "r": 255 - int(rec.data["r"]),
        "g": 255 - int(rec.data["g"]),
        "b": 255 - int(rec.data["b"]),
    })
```

### Step 6 — Reconstruct and save

```python
out = Image.new("RGBA", (width, height))
out_pixels = out.load()
all_pixels = vapor.query(QueryOptions(type="Pixel"))
for rec in all_pixels.records:
    x, y = int(rec.data["x"]), int(rec.data["y"])
    r, g, b, a = int(rec.data["r"]), int(rec.data["g"]), int(rec.data["b"]), int(rec.data["a"])
    out_pixels[x, y] = (r, g, b, a)
out.save("output.png")
print("Saved output.png")
```

### Step 7 — Destroy when done

```python
vapor.destroy()
```

## Memory guidelines

- A 256×256 image: ~16M pixels × ~1KB each → ~16 MB ✓ comfortable
- A 512×512 image: ~262K pixels → ~250 MB, OK for most systems
- A 1024×1024 image: ~1M pixels → ~1 GB, consider downsampling to 256×256 first

Always call `vapor.stats()` after indexing and check `memoryEstimateBytes`.

## Output

Describe what you found in natural language, then save the output image if a
transformation was requested. Provide the filename of the saved output.
