---
name: Pixel Analyzer
description: Analyze, understand, and reconstruct images by indexing raw pixel data into vapor-idx. No PIL, no YOLO, no ML. Parse PNG/PPM/BMP directly with built-in Python. Build semantic understanding bottom-up through relationship traversal — pixel clusters become regions, regions become features, features become objects. Generalized for any compositing scenario: subject-into-environment, color transformation, style unification, identity preservation, environment modification. Geometric transforms applied through the index. 5x validation pass on all semantic conclusions. All operations occur at cluster or sub-cluster level — no full-image filters.
version: 3.0.0
tools:
  - computer_use
---

# Pixel Analyzer Skill v3.0

## Purpose

Index raw image pixels into vapor-idx and reason over the structured index using
Claude's built-in semantic knowledge — no ML models, no PIL, no external libraries.
Parse image formats directly with Python's built-in `struct` and `zlib`.

Build understanding **bottom up**: individual pixels → connected clusters →
geometric shapes → features → semantic parts → identified objects.

Claude traverses relationships in the index rather than running top-down
object detection.

## CRITICAL: vapor-idx Python API Reference

**Always use these exact method names. The Python library uses snake_case, not camelCase.**

```
vapor.store(type_name, data)                               → str (record_id)
vapor.get(record_id)                                       → VaporRecord | None
vapor.update(record_id, partial_dict)                      → None
vapor.delete(record_id)                                    → None
vapor.relate(source_id, relationship_type, target_id)      → str (edge_id)
vapor.unrelate(edge_id)                                    → None
vapor.get_relationships(record_id, rel_type=None, direction="both") → list[VaporRelationship]
vapor.query(QueryOptions(...))                             → QueryResult
vapor.traverse(TraversalOptions(...))                      → TraversalResult
vapor.find_path(PathOptions(...))                          → list[str] | None
vapor.stats()                                              → VaporStats
vapor.snapshot()                                           → VaporSnapshot
vapor.restore(snapshot)                                    → VaporInstance
vapor.destroy()                                            → None
```

**NEVER use `vapor.getRelationships()` — this does not exist and will crash.**

**Direction parameter for `get_relationships()`:**
- `"outgoing"` — edges where this record is the source
- `"incoming"` — edges where this record is the target
- `"both"` — ONLY use for undirected relationships: ADJACENT_TO, SYMMETRICAL_WITH
- For PART_OF (directed): use `"outgoing"` from child, `"incoming"` from parent
- For SPATIALLY_ABOVE (directed): `"outgoing"` = clusters this one is above; `"incoming"` = clusters above this one
- For SAME_CLUSTER (directed pixel→cluster): `"outgoing"` from pixel, `"incoming"` from cluster

## When to Trigger

- Any image analysis, understanding, or transformation task
- Subject extraction from any background (people, animals, objects, vehicles)
- Compositing: subject into new environment
- Color transformation (swap, remap, style)
- Environment modification (waves, weather, lighting change)
- Material realism reconstruction
- Identity preservation across images
- Background removal from any image type

## Supported Raw Formats (No External Libraries)

- **PNG** — parsed with `struct` + `zlib` (built-in)
- **PPM/PGM/PBM** — plain text pixel format
- **BMP** — parsed with `struct` (built-in)
- **JPEG** — convert to PNG first via `convert input.jpg input.png` (imagemagick/ffmpeg)
- **Raw RGBA dumps** — if provided as bytes

## Environment

```bash
pip install vapor-idx
# For JPEG input:
# convert input.jpg input.png   (uses system imagemagick)
# ffmpeg -i input.jpg input.png (alternative)
```

---

## Step 1 — Raw Format Parsers

```python
import struct, zlib, math
from collections import Counter, deque

def parse_png(filepath: str) -> tuple[int, int, list]:
    """
    Parse PNG using only built-in Python (struct + zlib).
    Returns (width, height, pixels) where pixels[y][x] = (r, g, b, a).
    Handles filter types 0-4. Supports colour types 0, 2, 4, 6.
    """
    with open(filepath, 'rb') as f:
        raw = f.read()

    assert raw[:8] == b'\x89PNG\r\n\x1a\n', f"Not a PNG: {filepath}"

    pos = 8; width = 0; height = 0; bit_depth = 0; clr_type = 0; idat = b''

    while pos < len(raw):
        length = struct.unpack('>I', raw[pos:pos+4])[0]
        chunk_type = raw[pos+4:pos+8]
        chunk_data = raw[pos+8:pos+8+length]
        pos += 12 + length

        if chunk_type == b'IHDR':
            width, height = struct.unpack('>II', chunk_data[:8])
            bit_depth = chunk_data[8]; clr_type = chunk_data[9]
        elif chunk_type == b'IDAT':
            idat += chunk_data
        elif chunk_type == b'IEND':
            break

    channels = {0:1, 2:3, 4:2, 6:4}.get(clr_type, 3)
    scanline_len = width * channels
    decompressed = zlib.decompress(idat)
    pixels = []; prev = bytes(scanline_len)

    for y in range(height):
        base = y * (scanline_len + 1)
        flt = decompressed[base]
        row = bytearray(decompressed[base+1 : base+1+scanline_len])

        if flt == 1:
            for i in range(channels, len(row)):
                row[i] = (row[i] + row[i-channels]) & 0xFF
        elif flt == 2:
            for i in range(len(row)):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif flt == 3:
            for i in range(len(row)):
                a = row[i-channels] if i >= channels else 0
                row[i] = (row[i] + (a + prev[i]) // 2) & 0xFF
        elif flt == 4:
            for i in range(len(row)):
                a = row[i-channels] if i >= channels else 0
                b2 = prev[i]; c = prev[i-channels] if i >= channels else 0
                p = a + b2 - c
                pr = a if abs(p-a) <= abs(p-b2) and abs(p-a) <= abs(p-c) \
                     else (b2 if abs(p-b2) <= abs(p-c) else c)
                row[i] = (row[i] + pr) & 0xFF

        row_pixels = []
        for x in range(width):
            i = x * channels
            if clr_type == 6:   r,g,b,a = row[i],row[i+1],row[i+2],row[i+3]
            elif clr_type == 2: r,g,b,a = row[i],row[i+1],row[i+2],255
            elif clr_type == 0: r=g=b=row[i]; a=255
            elif clr_type == 4: v=row[i]; r=g=b=v; a=row[i+1]
            else:               r=g=b=row[i]; a=255
            row_pixels.append((r, g, b, a))

        pixels.append(row_pixels); prev = bytes(row)

    return width, height, pixels


def parse_ppm(filepath: str) -> tuple[int, int, list]:
    """Parse PPM/PGM (P3/P6) — no external libraries."""
    with open(filepath, 'rb') as f:
        data = f.read()

    lines = data.split(b'\n')
    magic = lines[0].strip()
    header_lines = [l for l in lines if not l.startswith(b'#')]
    dims = header_lines[1].split()
    width, height = int(dims[0]), int(dims[1])

    if magic == b'P3':
        vals = [int(v) for line in header_lines[3:] for v in line.split()]
        pixels = []; idx = 0
        for y in range(height):
            row = []
            for x in range(width):
                r,g,b = vals[idx],vals[idx+1],vals[idx+2]
                row.append((r,g,b,255)); idx += 3
            pixels.append(row)
    elif magic == b'P6':
        header_end = data.index(b'\n', data.index(b'\n', data.index(b'\n')+1)+1) + 1
        binary = data[header_end:]; pixels = []; pos = 0
        for y in range(height):
            row = []
            for x in range(width):
                r,g,b = binary[pos],binary[pos+1],binary[pos+2]
                row.append((r,g,b,255)); pos += 3
            pixels.append(row)
    else:
        raise ValueError(f"Unsupported PPM magic: {magic}")

    return width, height, pixels


def parse_bmp(filepath: str) -> tuple[int, int, list]:
    """Parse BMP using only struct (built-in). Supports 24-bit and 32-bit."""
    with open(filepath, 'rb') as f:
        data = f.read()

    assert data[:2] == b'BM', "Not a BMP file"
    pixel_offset = struct.unpack_from('<I', data, 10)[0]
    width = struct.unpack_from('<i', data, 18)[0]
    height = struct.unpack_from('<i', data, 22)[0]
    bpp = struct.unpack_from('<H', data, 28)[0]
    flipped = height > 0; height = abs(height)
    bytes_per_pixel = bpp // 8
    row_size = (width * bytes_per_pixel + 3) & ~3

    raw_pixels = []
    for y in range(height):
        row_y = (height - 1 - y) if flipped else y
        row_off = pixel_offset + row_y * row_size; row = []
        for x in range(width):
            off = row_off + x * bytes_per_pixel
            if bytes_per_pixel == 4:
                b,g,r,a = data[off],data[off+1],data[off+2],data[off+3]
            else:
                b,g,r = data[off],data[off+1],data[off+2]; a = 255
            row.append((r,g,b,a))
        raw_pixels.append(row)

    return width, height, raw_pixels


def write_png_raw(filepath: str, width: int, height: int, pixels: list) -> None:
    """Write PNG using only struct + zlib (built-in). pixels[y][x] = (r,g,b,a)."""
    def make_chunk(tag: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(tag + body) & 0xFFFFFFFF
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', crc)

    rows = bytearray()
    for row in pixels:
        rows += b'\x00'
        for r,g,b,a in row:
            rows += bytes([max(0,min(255,int(r))),max(0,min(255,int(g))),
                          max(0,min(255,int(b))),max(0,min(255,int(a)))])

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = make_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    idat = make_chunk(b'IDAT', zlib.compress(bytes(rows), 9))
    iend = make_chunk(b'IEND', b'')
    with open(filepath, 'wb') as f:
        f.write(sig + ihdr + idat + iend)
    print(f"Saved {filepath} ({width}×{height})")


def load_image(filepath: str) -> tuple[int, int, list]:
    """Auto-detect format and parse. Returns (w, h, pixels[y][x]=(r,g,b,a))."""
    ext = filepath.rsplit('.', 1)[-1].lower()
    if ext == 'png':             return parse_png(filepath)
    if ext in ('ppm','pgm','pbm'): return parse_ppm(filepath)
    if ext == 'bmp':             return parse_bmp(filepath)
    raise ValueError(f"Unsupported: {ext}. Convert JPEG via: convert input.jpg input.png")
```

---

## Step 2 — Color Utilities (No Libraries)

```python
def rgb_to_hsv(r, g, b) -> tuple[float, float, float]:
    """RGB 0-255 → HSV (h: 0-360, s: 0-1, v: 0-1). Pure Python."""
    r,g,b = r/255, g/255, b/255
    mx,mn = max(r,g,b), min(r,g,b); delta = mx - mn; v = mx
    s = (delta / mx) if mx > 0 else 0
    if delta == 0: h = 0.0
    elif mx == r:  h = 60 * (((g-b)/delta) % 6)
    elif mx == g:  h = 60 * ((b-r)/delta + 2)
    else:          h = 60 * ((r-g)/delta + 4)
    return h, s, v


def hsv_to_rgb(h, s, v) -> tuple[int, int, int]:
    """HSV → RGB 0-255. Pure Python."""
    if s == 0: c = int(v*255); return c,c,c
    h /= 60; i = int(h); f = h - i
    p,q,t = v*(1-s), v*(1-s*f), v*(1-s*(1-f))
    p,q,t,v = int(p*255),int(q*255),int(t*255),int(v*255)
    return [(v,t,p),(q,v,p),(p,v,t),(p,q,v),(t,p,v),(v,p,q)][i%6]


def clamp(v, lo=0, hi=255) -> float:
    return max(lo, min(hi, v))


def lerp(a, b, t) -> float:
    return a + (b - a) * t


def color_distance(r1,g1,b1, r2,g2,b2) -> float:
    return ((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2) ** 0.5


def brightness(r,g,b) -> float:
    return (r + g + b) / 3.0
```

---

## Step 3 — Schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions, PathOptions

def make_vapor_schema(include_skeleton=False, include_scene=False):
    """
    Build the vapor schema. Pass include_skeleton=True for pose deformation tasks.
    Pass include_scene=True to add Zone and BoundaryLine types for scene analysis.
    """
    types = {
        "Pixel": {
            "fields": {
                "x":           {"type":"number","index":"range"},
                "y":           {"type":"number","index":"range"},
                "r":           {"type":"number","index":"range"},
                "g":           {"type":"number","index":"range"},
                "b":           {"type":"number","index":"range"},
                "a":           {"type":"number","index":"range"},
                "brightness":  {"type":"number","index":"range"},
                "hue":         {"type":"number","index":"range"},
                "saturation":  {"type":"number","index":"range"},
                "edge_score":  {"type":"number","index":"range"},
                "cluster":     {"type":"string","index":"exact"},
                "feature":     {"type":"string","index":"keyword"},
                "layer":       {"type":"string","index":"exact"},
                "is_bg":       {"type":"boolean","index":"exact"},
                "is_motion_artifact": {"type":"boolean","index":"exact"},
            },
            "relationships": {
                "ADJACENT_TO": {"targetTypes":["Pixel"],"directed":False,"cardinality":"many-to-many"},
                "SAME_CLUSTER": {"targetTypes":["Cluster"],"directed":True,"cardinality":"many-to-one"},
            },
        },
        "Cluster": {
            "fields": {
                "cluster_id":       {"type":"string","index":"exact"},
                "label":            {"type":"string","index":"keyword"},
                "size":             {"type":"number","index":"range"},
                "center_x":         {"type":"number","index":"range"},
                "center_y":         {"type":"number","index":"range"},
                "min_x":            {"type":"number","index":"range"},
                "max_x":            {"type":"number","index":"range"},
                "min_y":            {"type":"number","index":"range"},
                "max_y":            {"type":"number","index":"range"},
                "width_span":       {"type":"number","index":"range"},
                "height_span":      {"type":"number","index":"range"},
                "aspect_ratio":     {"type":"number","index":"range"},
                "avg_r":            {"type":"number","index":"range"},
                "avg_g":            {"type":"number","index":"range"},
                "avg_b":            {"type":"number","index":"range"},
                "avg_brightness":   {"type":"number","index":"range"},
                "avg_hue":          {"type":"number","index":"range"},
                "avg_saturation":   {"type":"number","index":"range"},
                "is_edge":          {"type":"boolean","index":"exact"},
                "convexity":        {"type":"number","index":"range"},
                "perimeter":        {"type":"number","index":"range"},
                "texture_variance": {"type":"number","index":"range"},
                "edge_density":     {"type":"number","index":"range"},
                "reflectivity":     {"type":"number","index":"range"},
                "semantic_class":   {"type":"string","index":"keyword"},
                "confidence_passes":{"type":"number","index":"range"},
                "depth_estimate":   {"type":"number","index":"range"},
                "is_subject":       {"type":"boolean","index":"exact"},
                "is_background":    {"type":"boolean","index":"exact"},
                "is_motion_artifact":{"type":"boolean","index":"exact"},
            },
            "relationships": {
                "ADJACENT_TO":      {"targetTypes":["Cluster"],"directed":False,"cardinality":"many-to-many"},
                "PART_OF":          {"targetTypes":["Cluster"],"directed":True, "cardinality":"many-to-one"},
                "CONTAINS":         {"targetTypes":["Cluster"],"directed":True, "cardinality":"one-to-many"},
                "SPATIALLY_LEFT_OF":{"targetTypes":["Cluster"],"directed":True, "cardinality":"many-to-many"},
                "SPATIALLY_ABOVE":  {"targetTypes":["Cluster"],"directed":True, "cardinality":"many-to-many"},
                "SYMMETRICAL_WITH": {"targetTypes":["Cluster"],"directed":False,"cardinality":"many-to-many"},
                "MOTION_ARTIFACT_OF":{"targetTypes":["Cluster"],"directed":True,"cardinality":"many-to-one"},
            },
        },
    }

    if include_skeleton:
        types["Joint"] = {
            "fields": {
                "name":       {"type":"string","index":"exact"},
                "x":          {"type":"number","index":"range"},
                "y":          {"type":"number","index":"range"},
                "confidence": {"type":"number","index":"range"},
                "is_anchor":  {"type":"boolean","index":"exact"},
            },
            "relationships": {
                "PARENT_OF":   {"targetTypes":["Joint"],"directed":True,"cardinality":"one-to-many"},
                "CHILD_OF":    {"targetTypes":["Joint"],"directed":True,"cardinality":"many-to-one"},
                "OWNS_PIXELS": {"targetTypes":["Cluster"],"directed":True,"cardinality":"one-to-many"},
            },
        }
        types["Bone"] = {
            "fields": {
                "name":             {"type":"string","index":"exact"},
                "length_px":        {"type":"number","index":"range"},
                "angle_deg":        {"type":"number","index":"range"},
                "target_angle_deg": {"type":"number","index":"range"},
            },
            "relationships": {
                "FROM_JOINT":      {"targetTypes":["Joint"],"directed":True,"cardinality":"many-to-one"},
                "TO_JOINT":        {"targetTypes":["Joint"],"directed":True,"cardinality":"many-to-one"},
                "DEFORMS_CLUSTER": {"targetTypes":["Cluster"],"directed":True,"cardinality":"one-to-many"},
            },
        }

    if include_scene:
        types["Zone"] = {
            "fields": {
                "name":          {"type":"string","index":"exact"},
                "zone_type":     {"type":"string","index":"keyword"},
                "min_y":         {"type":"number","index":"range"},
                "max_y":         {"type":"number","index":"range"},
                "avg_r":         {"type":"number","index":"range"},
                "avg_g":         {"type":"number","index":"range"},
                "avg_b":         {"type":"number","index":"range"},
                "roughness":     {"type":"number","index":"range"},
                "reflectivity":  {"type":"number","index":"range"},
            },
            "relationships": {
                "CONTAINS_CLUSTER": {"targetTypes":["Cluster"],"directed":True,"cardinality":"one-to-many"},
            },
        }
        types["BoundaryLine"] = {
            "fields": {
                "y":                 {"type":"number","index":"range"},
                "confidence":        {"type":"number","index":"range"},
                "boundary_type":     {"type":"string","index":"exact"},
                "brightness_above":  {"type":"number","index":"range"},
                "brightness_below":  {"type":"number","index":"range"},
            },
            "relationships": {},
        }

    return create_vapor({"types": types})
```

---

## Step 4 — Pixel Indexing (Phase 1)

```python
def index_pixels(vapor, width: int, height: int, pixels: list,
                 step: int = 2, label: str = "IMG") -> tuple[dict, dict]:
    """
    Index all pixels into vapor with full ADJACENT_TO relationships.
    Returns (grid, stats) where grid[(x,y)] = record_id.

    Step=1 for small images (<256px), step=2 for medium, step=3 for large.
    Always use the same step for images you will composite together.
    """
    import time; t0 = time.time()
    grid = {}

    for y in range(0, height, step):
        for x in range(0, width, step):
            r,g,b,a = pixels[y][x]
            h,s,v = rgb_to_hsv(r,g,b)
            pid = vapor.store("Pixel", {
                "x": float(x), "y": float(y),
                "r": float(r), "g": float(g), "b": float(b), "a": float(a),
                "brightness": brightness(r,g,b),
                "hue": h, "saturation": s,
                "edge_score": 0.0, "cluster": "", "feature": "", "layer": "base",
                "is_bg": False, "is_motion_artifact": False,
            })
            grid[(x,y)] = pid

    # Full 4-connectivity ADJACENT_TO
    adj_count = 0
    for y in range(0, height, step):
        for x in range(0, width, step):
            pid = grid.get((x,y))
            if not pid: continue
            r = grid.get((x+step, y))
            d = grid.get((x, y+step))
            if r: vapor.relate(pid, "ADJACENT_TO", r); adj_count += 1
            if d: vapor.relate(pid, "ADJACENT_TO", d); adj_count += 1

    elapsed = time.time() - t0
    n = len(grid)
    print(f"  P1 [{label}] {n} pixels | {adj_count} ADJACENT_TO | {elapsed:.1f}s")
    return grid, {"pixels": n, "adj_rels": adj_count, "time_s": elapsed}
```

---

## Step 5 — Sobel Edge Detection (Phase 2)

```python
def compute_sobel_edges(vapor, grid: dict, width: int, height: int,
                        step: int = 2, threshold: float = 18.0,
                        label: str = "IMG") -> dict:
    """
    Compute Sobel gradient magnitude through vapor neighbor lookups.
    Updates edge_score in-place. Returns stats.
    """
    import time; t0 = time.time()

    def get_br(x, y):
        rec = vapor.get(grid.get((x,y), ""))
        return rec.data["brightness"] if rec else 0.0

    edge_pix = 0; edge_scores = []
    for y in range(step, height-step, step):
        for x in range(step, width-step, step):
            if (x,y) not in grid: continue
            gx = (-get_br(x-step,y-step) + get_br(x+step,y-step)
                  -2*get_br(x-step,y)    + 2*get_br(x+step,y)
                  -get_br(x-step,y+step) + get_br(x+step,y+step))
            gy = (-get_br(x-step,y-step) - 2*get_br(x,y-step) - get_br(x+step,y-step)
                  +get_br(x-step,y+step) + 2*get_br(x,y+step) + get_br(x+step,y+step))
            score = (gx**2 + gy**2) ** 0.5
            if score > threshold:
                vapor.update(grid[(x,y)], {"edge_score": score})
                edge_pix += 1; edge_scores.append(score)

    elapsed = time.time() - t0
    avg_sc = sum(edge_scores)/len(edge_scores) if edge_scores else 0
    max_sc = max(edge_scores) if edge_scores else 0
    print(f"  P2 [{label}] {edge_pix} edge pixels | avg={avg_sc:.1f} max={max_sc:.1f} | {elapsed:.1f}s")
    return {"edge_pixels": edge_pix, "avg_edge_score": avg_sc, "max_edge_score": max_sc, "time_s": elapsed}
```

---

## Step 6 — Flood-Fill Cluster Detection (Phase 3)

```python
def detect_clusters(vapor, grid: dict, width: int, height: int,
                    step: int = 2, colour_tolerance: float = 40.0,
                    min_cluster_size: int = 8, label: str = "IMG") -> tuple[dict, dict]:
    """
    BFS flood-fill through ADJACENT_TO relationships.
    Returns (cluster_ids dict: cid→record_id, stats dict).
    """
    import time; t0 = time.time()
    visited = set(); cluster_ids = {}; counter = 0
    all_pids = list({v for v in grid.values() if v})
    cluster_sizes = []

    def flood(start_pid):
        seed = vapor.get(start_pid)
        if not seed: return []
        result = []; q = deque([start_pid]); lv = {start_pid}
        while q:
            cur = q.popleft(); cr = vapor.get(cur)
            if not cr: continue
            result.append(cur)
            # Use "both" — ADJACENT_TO is undirected
            for e in vapor.get_relationships(cur, "ADJACENT_TO", "both"):
                nid = e.target_id if e.source_id == cur else e.source_id
                if nid in lv or nid in visited: continue
                nr = vapor.get(nid)
                if not nr: continue
                dist = color_distance(seed.data["r"],seed.data["g"],seed.data["b"],
                                      nr.data["r"],nr.data["g"],nr.data["b"])
                if dist <= colour_tolerance:
                    lv.add(nid); q.append(nid)
        return result

    for pid in all_pids:
        if pid in visited: continue
        cp = flood(pid); visited.update(cp)
        if len(cp) < min_cluster_size: continue

        counter += 1; cid = f"c{counter:04d}"
        recs = [vapor.get(p) for p in cp if vapor.get(p)]
        xs = [r.data["x"] for r in recs]; ys = [r.data["y"] for r in recs]
        rs = [r.data["r"] for r in recs]; gs = [r.data["g"] for r in recs]
        bs = [r.data["b"] for r in recs]; brs = [r.data["brightness"] for r in recs]
        hs = [r.data["hue"] for r in recs]; ss = [r.data["saturation"] for r in recs]

        mnx,mxx = min(xs),max(xs); mny,mxy = min(ys),max(ys)
        ws = mxx-mnx+1; hs2 = mxy-mny+1
        asp = ws/hs2 if hs2 > 0 else 1.0
        area = float(len(cp))
        conv = area/(ws*hs2) if ws*hs2 > 0 else 0.0
        is_edge = any(r.data["edge_score"] > 10 for r in recs)

        # Texture variance: mean of squared brightness deviations
        avg_br = sum(brs)/len(brs)
        tex_var = sum((b-avg_br)**2 for b in brs)/len(brs) if brs else 0.0

        # Edge density: fraction of pixels with edge_score > threshold
        edge_d = sum(1 for r in recs if r.data["edge_score"] > 10) / max(len(recs),1)

        # Perimeter sample (first 300 pixels)
        cp_set = set(cp); peri = 0
        for p in cp[:300]:
            edges = vapor.get_relationships(p, "ADJACENT_TO", "both")
            for e in edges:
                nid = e.target_id if e.source_id == p else e.source_id
                if nid not in cp_set: peri += 1; break

        crid = vapor.store("Cluster", {
            "cluster_id":   cid, "label": "", "size": area,
            "center_x":     sum(xs)/len(xs), "center_y": sum(ys)/len(ys),
            "min_x": float(mnx), "max_x": float(mxx),
            "min_y": float(mny), "max_y": float(mxy),
            "width_span": float(ws), "height_span": float(hs2),
            "aspect_ratio": asp,
            "avg_r": sum(rs)/len(rs), "avg_g": sum(gs)/len(gs), "avg_b": sum(bs)/len(bs),
            "avg_brightness": avg_br,
            "avg_hue": sum(hs)/len(hs), "avg_saturation": sum(ss)/len(ss),
            "is_edge": is_edge, "convexity": conv, "perimeter": float(peri),
            "texture_variance": tex_var, "edge_density": edge_d, "reflectivity": 0.0,
            "semantic_class": "", "confidence_passes": 0.0, "depth_estimate": 0.5,
            "is_subject": False, "is_background": False, "is_motion_artifact": False,
        })

        for p in cp:
            vapor.update(p, {"cluster": cid})
            # SAME_CLUSTER is directed: pixel → cluster (outgoing from pixel)
            vapor.relate(p, "SAME_CLUSTER", crid)

        cluster_ids[cid] = crid; cluster_sizes.append(area)

    elapsed = time.time() - t0
    avg_sz = sum(cluster_sizes)/len(cluster_sizes) if cluster_sizes else 0
    max_sz = max(cluster_sizes) if cluster_sizes else 0
    print(f"  P3 [{label}] {counter} clusters | avg_size={avg_sz:.0f} max={max_sz:.0f} | {elapsed:.1f}s")
    return cluster_ids, {"cluster_count": counter, "avg_cluster_size": avg_sz,
                         "max_cluster_size": max_sz, "time_s": elapsed}
```

---

## Step 7 — Cluster Graph: All Relationships (Phase 4)

```python
def build_cluster_relationships(vapor, cluster_ids: dict, label: str = "IMG") -> dict:
    """
    Build all cluster-level spatial relationships.
    Returns stats dict.
    IMPORTANT: Direction rules:
    - ADJACENT_TO: undirected → use "both" when querying
    - SPATIALLY_LEFT_OF: directed A→B means A is left of B
    - SPATIALLY_ABOVE: directed A→B means A is above B (lower y value)
    - PART_OF: directed child→parent
    - CONTAINS: directed parent→child (inverse of PART_OF)
    - SYMMETRICAL_WITH: undirected → use "both" when querying
    """
    import time; t0 = time.time()
    recs = vapor.query(QueryOptions(type="Cluster")).records
    n = len(recs)
    adj = sym = left = above = part = 0

    for i in range(n):
        for j in range(i+1, n):
            a = recs[i].data; b = recs[j].data

            horiz = (abs(a["max_x"]-b["min_x"]) < 10 or abs(b["max_x"]-a["min_x"]) < 10)
            vert  = (abs(a["max_y"]-b["min_y"]) < 10 or abs(b["max_y"]-a["min_y"]) < 10)
            overlap = not (a["max_x"]<b["min_x"] or b["max_x"]<a["min_x"] or
                           a["max_y"]<b["min_y"] or b["max_y"]<a["min_y"])

            if horiz or vert or overlap:
                vapor.relate(recs[i].id, "ADJACENT_TO", recs[j].id); adj += 1

            # SPATIALLY_LEFT_OF: directed
            if a["center_x"] < b["center_x"] - 10:
                vapor.relate(recs[i].id, "SPATIALLY_LEFT_OF", recs[j].id); left += 1
            elif b["center_x"] < a["center_x"] - 10:
                vapor.relate(recs[j].id, "SPATIALLY_LEFT_OF", recs[i].id); left += 1

            # SPATIALLY_ABOVE: directed (lower y = higher up in image)
            if a["center_y"] < b["center_y"] - 10:
                vapor.relate(recs[i].id, "SPATIALLY_ABOVE", recs[j].id); above += 1
            elif b["center_y"] < a["center_y"] - 10:
                vapor.relate(recs[j].id, "SPATIALLY_ABOVE", recs[i].id); above += 1

            # SYMMETRICAL_WITH: undirected, similar size+color
            ss = abs(a["size"]-b["size"])/max(a["size"],b["size"],1) < 0.3
            cc = color_distance(a["avg_r"],a["avg_g"],a["avg_b"],
                                b["avg_r"],b["avg_g"],b["avg_b"]) < 40
            if ss and cc:
                vapor.relate(recs[i].id, "SYMMETRICAL_WITH", recs[j].id); sym += 1

            # PART_OF / CONTAINS: directed, small cluster inside large cluster bbox
            if (a["size"] < b["size"]*0.15 and
                a["min_x"]>=b["min_x"] and a["max_x"]<=b["max_x"] and
                a["min_y"]>=b["min_y"] and a["max_y"]<=b["max_y"]):
                vapor.relate(recs[i].id, "PART_OF", recs[j].id)
                vapor.relate(recs[j].id, "CONTAINS", recs[i].id); part += 1
            elif (b["size"] < a["size"]*0.15 and
                  b["min_x"]>=a["min_x"] and b["max_x"]<=a["max_x"] and
                  b["min_y"]>=a["min_y"] and b["max_y"]<=a["max_y"]):
                vapor.relate(recs[j].id, "PART_OF", recs[i].id)
                vapor.relate(recs[i].id, "CONTAINS", recs[j].id); part += 1

    elapsed = time.time() - t0
    print(f"  P4 [{label}] ADJ={adj} LEFT={left} ABOVE={above} SYM={sym} PART={part} | {elapsed:.1f}s")
    return {"adjacent_rels":adj,"spatially_left_of":left,"spatially_above":above,
            "symmetrical_with":sym,"part_of":part,"time_s":elapsed}
```

---

## Step 8 — Semantic Labeling 5× (Phase 5)

```python
def classify_cluster(cd: dict, adj_data: list[dict],
                     image_type: str = "generic") -> str:
    """
    Classify a single cluster using geometry + color + adjacency context.
    image_type: "generic"|"outdoor_scene"|"person"|"animal"|"horse"|"frog"|
                "indoor"|"product"|"underwater"|"sky"
    This function encodes Claude's semantic knowledge. Called 5 times per cluster.
    """
    size  = cd["size"]; asp = cd["aspect_ratio"]; conv = cd["convexity"]
    is_e  = cd["is_edge"]; br = cd["avg_brightness"]
    r,g,b = cd["avg_r"],cd["avg_g"],cd["avg_b"]
    ws,hs = cd["width_span"],cd["height_span"]
    h,s,v = cd["avg_hue"],cd["avg_saturation"],br/255.0
    tex   = cd["texture_variance"]

    # Universal color profiles
    is_skin     = (r>120 and r>g and r>b and g>60 and b>40 and r-b>20 and r-g<90)
    is_white    = (r>215 and g>215 and b>215 and abs(r-g)<15 and abs(g-b)<15)
    is_dark     = br < 55
    is_clothing = (br<90 and not is_skin and not is_white)
    is_blue     = (b>r and b>g and b>80)
    is_brown    = (r>100 and g>60 and b<80 and r>g and r-b>40 and r<200)
    is_red_br   = (r>130 and g<130 and b<80 and r>g*1.3)
    is_gray     = (abs(r-g)<22 and abs(g-b)<22 and 60<br<210)
    is_sandy    = (r>155 and g>120 and b<130 and r>b and g>b)
    is_green    = (g>r and g>b and g>80)
    is_dk_green = (g>r and g>b and g>60 and br<120)
    is_water    = (b>r and b>g and b>80) or (abs(r-g)<30 and b>100 and br>120)
    is_sky_col  = (abs(r-g)<25 and abs(g-b)<25 and br>150)

    if is_e and br < 70:       return "contour_edge"
    if size < 25:              return "texture_grain"

    is_circ   = 0.7<=asp<=1.4 and conv>0.62
    is_vert   = asp < 0.48 and hs > ws*2.1
    is_horiz  = asp > 2.1 and ws > hs*2.1
    is_rect   = conv > 0.72 and (asp < 0.45 or asp > 2.2)

    if is_white and size > 800: return "white_background"

    # ── image_type specific rules ──────────────────────────────────────────
    if image_type in ("outdoor_scene", "horse", "beach", "nature"):
        if is_sandy and size > 300:    return "sand_surface"
        if is_sky_col and size > 400:  return "sky_region"
        if is_water and size > 200:    return "water_surface"
        if br > 230 and size > 100:    return "water_foam"
        if r>160 and g<130 and b<120:  return "sunset_sky"
        if r>200 and g>120 and b<100:  return "warm_sky_glow"

    if image_type == "horse":
        if is_red_br and size > 300:   return "horse_body"
        if is_brown and br < 120:      return "horse_body"
        if br < 40 and s < 0.3:        return "horse_mane"
        if is_clothing and size > 150: return "horse_leg"

    if image_type == "frog":
        if is_green and size > 200:    return "frog_body_green"
        if is_dk_green and size > 100: return "frog_body_dark"
        if br > 200 and size > 50:     return "frog_belly"
        if g > r and g > b and br > 120 and conv > 0.5: return "lily_pad_green"
        if is_water:                   return "water_surface"
        if br > 180 and is_gray:       return "water_foam"

    if image_type == "person":
        if is_white and size > 800:    return "white_background"
        if is_skin and size > 300:     return "skin_region"
        if is_clothing and size > 200: return "dark_clothing"
        if is_blue and br < 160:       return "jeans_region"

    if image_type == "indoor":
        if br > 220 and size > 500:    return "wall_surface"
        if is_brown and size > 300:    return "wood_surface"
        if is_gray and size > 400:     return "floor_surface"

    if image_type == "product":
        if br > 230:                   return "product_highlight"
        if is_dark and size > 200:     return "product_shadow"
        if is_gray and size > 300:     return "background_neutral"

    # ── Universal shape-based rules ────────────────────────────────────────
    if is_circ and size < 150:
        if is_skin: return "round_skin_blob"
        if br > 210: return "bright_circle"
        return "dark_circle"

    if is_circ and size >= 150:
        if is_skin: return "large_skin_oval"
        return "large_oval"

    if is_vert:
        if is_skin:     return "vertical_skin_strip"
        if is_blue:     return "leg_jeans"
        if is_clothing: return "dark_vert"
        if is_green:    return "vertical_green_strip"
        return "vert_bar"

    if is_horiz:
        if is_skin:     return "horiz_skin_strip"
        if is_clothing: return "dark_horiz"
        return "horiz_bar"

    if is_rect and size > 500:
        if is_white:    return "large_bright_rect"
        if is_dark:     return "large_dark_rect"
        if is_clothing: return "torso_region"
        return "large_rect"

    # ── Color-based fallbacks ──────────────────────────────────────────────
    if is_skin and size > 200:      return "skin_region"
    if is_green and size > 200:     return "green_region"
    if is_brown and size > 200:     return "brown_region"
    if is_sandy and size > 200:     return "sandy_region"
    if is_water:                    return "water_region"
    if br > 210:                    return "bright_blob"
    if br < 45:                     return "dark_blob"
    return "undefined_region"


def semantic_label_clusters_5x(vapor, cluster_ids: dict,
                                image_type: str = "generic",
                                label: str = "IMG") -> tuple[dict, dict]:
    """
    5-pass consensus semantic labeling. Each pass uses adjacent cluster labels
    from the previous pass to refine current labeling.
    Returns (label_history, stats).
    """
    import time; t0 = time.time()
    label_history = {cid: [] for cid in cluster_ids}

    for pass_num in range(5):
        all_c = vapor.query(QueryOptions(type="Cluster"))
        for rec in all_c.records:
            cid = rec.data["cluster_id"]
            # Get adjacent labels using "both" for undirected ADJACENT_TO
            adj_edges = vapor.get_relationships(rec.id, "ADJACENT_TO", "both")
            adj_recs  = [vapor.get(e.target_id if e.source_id==rec.id else e.source_id)
                         for e in adj_edges]
            adj_data   = [a.data for a in adj_recs if a]
            adj_labels = [a.get("semantic_class","") for a in adj_data]

            label2 = classify_cluster(rec.data, adj_data, image_type)

            # Context refinements using adjacency evidence
            skin_n  = sum(1 for l in adj_labels if "skin" in l)
            green_n = sum(1 for l in adj_labels if "green" in l or "frog" in l)
            horse_n = sum(1 for l in adj_labels if "horse" in l)

            if skin_n >= 2 and "skin" not in label2:
                if rec.data["aspect_ratio"] < 0.5: label2 = "finger_segment"
                elif rec.data["aspect_ratio"] > 2.0: label2 = "arm_segment"

            if green_n >= 2 and image_type == "frog" and "frog" not in label2:
                if rec.data["avg_brightness"] > 150: label2 = "frog_belly"
                else: label2 = "frog_body_dark"

            if horse_n >= 2 and image_type == "horse" and "horse" not in label2:
                if rec.data["avg_brightness"] < 60: label2 = "horse_mane"
                elif rec.data["avg_r"] > 100 and rec.data["avg_b"] < 80:
                    label2 = "horse_body"

            history = label_history.setdefault(cid, [])
            history.append(label2)

            # Consensus: stable if last 3 agree, else majority vote
            if len(history) >= 3 and len(set(history[-3:])) == 1:
                final = history[-1]
            else:
                final = Counter(history).most_common(1)[0][0]

            vapor.update(rec.id, {"semantic_class": final,
                                  "confidence_passes": float(len(history))})
        print(f"    Pass {pass_num+1}/5 done [{label}]")

    lbl_counts = Counter()
    for rec in vapor.query(QueryOptions(type="Cluster")).records:
        lbl_counts[rec.data.get("semantic_class","?")] += 1

    elapsed = time.time() - t0
    print(f"  P5 [{label}] Label distribution:")
    for lbl, cnt in lbl_counts.most_common(15):
        print(f"    {cnt:5d}  {lbl}")
    return label_history, {"label_distribution": dict(lbl_counts),
                           "total_clusters": sum(lbl_counts.values()),
                           "time_s": elapsed}
```

---

## Step 9 — Structural Boundary Detection (NEW)

```python
def detect_structural_boundary(vapor, grid: dict, W: int, H: int,
                                step: int = 2) -> dict:
    """
    Find the dominant structural boundary in any image.
    Generalizes: horizon line (outdoor), floor/wall junction (indoor),
    water surface, table edge, any dominant near-horizontal separator.

    Algorithm:
    1. Compute per-row mean Sobel score from vapor pixel data
    2. Find the row band (20-80% of height) with maximum mean edge score
       AND significant brightness gradient (above vs below)
    3. Classify boundary type from color characteristics

    Returns boundary_info dict with y, confidence, boundary_type.
    """
    # Collect brightness and edge_score per row
    row_edge_sum   = {}
    row_bright_sum = {}
    row_count      = {}

    for rec in vapor.query(QueryOptions(type="Pixel")).records:
        y = int(rec.data["y"]); row = (y // step) * step
        row_edge_sum[row]   = row_edge_sum.get(row,0)   + rec.data["edge_score"]
        row_bright_sum[row] = row_bright_sum.get(row,0) + rec.data["brightness"]
        row_count[row]      = row_count.get(row,0) + 1

    # Compute row means
    row_means = {}
    for row in row_edge_sum:
        c = max(row_count.get(row,1), 1)
        row_means[row] = (row_edge_sum[row]/c, row_bright_sum[row]/c)

    # Search the middle 20-80% of height for dominant edge row
    y_min = int(H * 0.20); y_max = int(H * 0.80)
    best_y = None; best_score = 0.0

    sorted_rows = sorted(row_means.keys())
    for y in sorted_rows:
        if y < y_min or y > y_max: continue
        edge_mean = row_means[y][0]

        # Brightness gradient: average brightness above vs below this row
        above_rows = [r for r in sorted_rows if r < y]
        below_rows = [r for r in sorted_rows if r > y]
        if len(above_rows) < 3 or len(below_rows) < 3: continue

        br_above = sum(row_means[r][1] for r in above_rows[-10:]) / min(10, len(above_rows))
        br_below = sum(row_means[r][1] for r in below_rows[:10])  / min(10, len(below_rows))
        br_gradient = abs(br_above - br_below)

        # Combined score: high edge activity + significant brightness change
        combined = edge_mean * 0.6 + br_gradient * 0.4
        if combined > best_score:
            best_score = combined; best_y = y

    if best_y is None:
        best_y = H // 2  # fallback

    # Classify boundary type from pixel colors around the boundary
    above_sample = [vapor.get(grid.get((x*step, max(0,best_y-2*step)), ""))
                    for x in range(0, W//step, 4)]
    below_sample = [vapor.get(grid.get((x*step, min(H-step,best_y+2*step)), ""))
                    for x in range(0, W//step, 4)]
    above_sample = [r for r in above_sample if r]
    below_sample = [r for r in below_sample if r]

    avg_above_b = sum(r.data["b"] for r in above_sample)/max(len(above_sample),1) if above_sample else 0
    avg_below_r = sum(r.data["r"] for r in below_sample)/max(len(below_sample),1) if below_sample else 0
    avg_below_g = sum(r.data["g"] for r in below_sample)/max(len(below_sample),1) if below_sample else 0

    # Classify
    if avg_above_b > 120 and avg_below_r > 150:
        boundary_type = "horizon_sky_sand"
    elif avg_above_b > 120 and avg_below_g > 100:
        boundary_type = "water_surface"
    else:
        boundary_type = "structural_edge"

    br_above = sum(row_means[r][1] for r in sorted_rows if r < best_y) / max(
               sum(1 for r in sorted_rows if r < best_y), 1)
    br_below = sum(row_means[r][1] for r in sorted_rows if r >= best_y) / max(
               sum(1 for r in sorted_rows if r >= best_y), 1)

    confidence = min(1.0, best_score / 2000.0)

    result = {
        "y": best_y, "confidence": confidence,
        "boundary_type": boundary_type,
        "brightness_above": br_above, "brightness_below": br_below
    }

    # Store in vapor if Zone type is available
    try:
        vapor.store("BoundaryLine", {
            "y": float(best_y), "confidence": confidence,
            "boundary_type": boundary_type,
            "brightness_above": br_above, "brightness_below": br_below
        })
    except Exception:
        pass  # BoundaryLine type not in schema — fine

    print(f"  Boundary: y={best_y} type={boundary_type} conf={confidence:.2f}")
    return result
```

---

## Step 10 — Environment Zone Segmentation (NEW)

```python
def segment_environment_zones(vapor, grid: dict, W: int, H: int,
                               boundary_y: int, step: int = 2,
                               scene_type: str = "outdoor") -> dict:
    """
    Divide the image into named semantic zones using the structural boundary.
    Returns zone_masks: dict of zone_name → set of (x,y) pixel coords.

    scene_type options: "outdoor"|"indoor"|"underwater"|"studio"|"urban"

    Zone classification per scene_type:

    outdoor: sky_upper, horizon_glow, water_zone, wet_surface, dry_surface,
             vegetation, shadow_zone
    indoor:  ceiling, wall_vertical, floor_horizontal, furniture_surface, shadow_zone
    underwater: deep_water, surface_water, light_column, substrate
    studio:  background_uniform, subject_region, shadow_zone
    urban:   sky_region, building_facade, road_surface, sidewalk, shadow_zone
    """
    zone_masks = {}

    def sample_zone(y_min, y_max, zone_name, color_filter=None):
        coords = set()
        for y in range(max(0,y_min), min(H,y_max), step):
            for x in range(0, W, step):
                rec = vapor.get(grid.get((x,y), ""))
                if not rec: continue
                if color_filter and not color_filter(rec.data): continue
                coords.add((x,y))
        zone_masks[zone_name] = coords

    if scene_type == "outdoor":
        # Sky: above boundary, high brightness
        sample_zone(0, boundary_y, "sky_upper",
                    lambda d: d["brightness"] > 140)

        # Horizon glow: narrow band around boundary (±20px), warm colors
        glow_top = max(0, boundary_y-20); glow_bot = min(H, boundary_y+20)
        sample_zone(glow_top, glow_bot, "horizon_glow",
                    lambda d: d["avg_r"] > 150 and d["avg_g"] > 80)

        # Water zone: below boundary, blue-ish or reflective
        water_bot = min(H, boundary_y + (H-boundary_y)//2)
        sample_zone(boundary_y, water_bot, "water_zone",
                    lambda d: d["b"] > d["r"] and d["b"] > 80)

        # Wet surface: below water zone, sandy + dark (wet sand)
        sample_zone(water_bot, H, "wet_surface",
                    lambda d: d["avg_r"]>100 and d["avg_g"]>80 and d["avg_brightness"]<160)

        # Dry surface: bottom, sandy + bright
        sample_zone(int(H*0.75), H, "dry_surface",
                    lambda d: d["avg_r"]>150 and d["avg_g"]>120 and d["avg_b"]<130)

    elif scene_type == "indoor":
        sample_zone(0, int(H*0.15), "ceiling",
                    lambda d: d["brightness"] > 180)
        sample_zone(int(H*0.10), int(H*0.80), "wall_vertical",
                    lambda d: d["brightness"] > 150)
        sample_zone(int(H*0.75), H, "floor_horizontal",
                    lambda d: True)

    elif scene_type == "underwater":
        sample_zone(0, int(H*0.15), "surface_water",
                    lambda d: d["brightness"] > 150)
        sample_zone(0, H, "deep_water",
                    lambda d: d["b"] > d["r"] and d["b"] > 60)
        sample_zone(int(H*0.80), H, "substrate",
                    lambda d: d["avg_r"] > 100 and d["brightness"] < 120)

    elif scene_type == "studio":
        sample_zone(0, H, "background_uniform",
                    lambda d: d["brightness"] > 200 and d["saturation"] < 0.1)

    print(f"  Zones: {list(zone_masks.keys())} ({[len(v) for v in zone_masks.values()]}px each)")
    return zone_masks
```

---

## Step 11 — Extract Real Segmented Region (NEW)

```python
def extract_segmented_region(vapor, label_keywords: list[str],
                              source_pixels: list, W: int, H: int,
                              step: int = 2) -> dict:
    """
    Extract REAL pixels from a vapor-analyzed image for specific semantic labels.
    Returns pixel_map: (x,y) → (r,g,b,a) containing only matching cluster pixels.

    USE THIS instead of procedural generation for surfaces, objects, textures.
    Example: extract real lily pad pixels from a pond reference image,
             extract real grass from a park image, real wood from a desk image.

    label_keywords: list of keywords to match against semantic_class
    e.g. ["lily_pad", "pad"] matches "lily_pad_green", "lily_pad_detail", etc.
    """
    # Find matching cluster records
    matching_cids = set()
    for rec in vapor.query(QueryOptions(type="Cluster")).records:
        lbl = rec.data.get("semantic_class","")
        if any(kw in lbl for kw in label_keywords):
            matching_cids.add(rec.data["cluster_id"])

    if not matching_cids:
        print(f"  extract_segmented_region: No clusters matching {label_keywords}")
        return {}

    # Get bounding box of all matching clusters
    all_c = vapor.query(QueryOptions(type="Cluster"))
    min_x = min_y = float('inf'); max_x = max_y = 0.0
    for rec in all_c.records:
        if rec.data["cluster_id"] in matching_cids:
            min_x = min(min_x, rec.data["min_x"]); max_x = max(max_x, rec.data["max_x"])
            min_y = min(min_y, rec.data["min_y"]); max_y = max(max_y, rec.data["max_y"])

    # Build pixel map from vapor pixel records belonging to matching clusters
    pixel_map = {}
    for rec in vapor.query(QueryOptions(type="Pixel")).records:
        if rec.data.get("cluster","") in matching_cids:
            x = int(rec.data["x"]); y = int(rec.data["y"])
            # Get actual pixel value from source_pixels array
            sy = min(y, H-1); sx = min(x, W-1)
            r,g,b,a = source_pixels[sy][sx]
            pixel_map[(x,y)] = (r,g,b,a)

    print(f"  extract_segmented_region: {len(pixel_map)} pixels "
          f"from {len(matching_cids)} clusters "
          f"bbox=({min_x:.0f},{min_y:.0f})→({max_x:.0f},{max_y:.0f})")
    return pixel_map
```

---

## Step 12 — Material Property Extraction (NEW)

```python
def extract_material_properties(vapor, cluster_record_id: str,
                                 source_pixels: list, W: int, H: int,
                                 step: int = 2) -> dict:
    """
    Extract full material properties for a single cluster.
    Returns comprehensive material descriptor beyond flat color averages.

    Output:
    {
      color_histogram: 8-bucket (r,g,b,count) histogram,
      texture_variance: local pixel variance (roughness proxy),
      edge_density: edge_pixels/total (surface detail),
      saturation_profile: (mean, std_dev),
      brightness_gradient: (dx, dy) directional brightness falloff,
      reflectivity: 0-1 estimate from specular highlights,
      dominant_hue_range: (min_h, max_h),
      roughness_class: 'mirror'|'glossy'|'satin'|'matte'|'rough',
    }
    """
    cid_rec = vapor.get(cluster_record_id)
    if not cid_rec: return {}

    cid = cid_rec.data["cluster_id"]
    pixel_recs = [vapor.get(e.source_id)
                  for e in vapor.get_relationships(cluster_record_id, "SAME_CLUSTER", "incoming")
                  if vapor.get(e.source_id)]

    if not pixel_recs:
        # Fallback: query pixels by cluster field
        pixel_recs = vapor.query(QueryOptions(
            type="Pixel", where=FieldFilter("cluster","eq",cid))).records

    if not pixel_recs:
        return {}

    # Color histogram (8 buckets per channel = 512 bins, simplified to mean+std per channel)
    r_vals = [p.data["r"] for p in pixel_recs]
    g_vals = [p.data["g"] for p in pixel_recs]
    b_vals = [p.data["b"] for p in pixel_recs]
    br_vals= [p.data["brightness"] for p in pixel_recs]
    h_vals = [p.data["hue"] for p in pixel_recs]
    s_vals = [p.data["saturation"] for p in pixel_recs]

    n = len(pixel_recs)

    def stats(vals):
        mean = sum(vals)/n
        std  = (sum((v-mean)**2 for v in vals)/n)**0.5
        return mean, std

    r_mean,r_std = stats(r_vals); g_mean,g_std = stats(g_vals); b_mean,b_std = stats(b_vals)
    br_mean,br_std = stats(br_vals); h_mean,h_std = stats(h_vals); s_mean,s_std = stats(s_vals)

    # Texture variance: local brightness variation = surface roughness
    tex_var = br_std**2

    # Edge density from cluster field
    edge_d = cid_rec.data.get("edge_density", 0.0)

    # Brightness gradient: how does brightness change across the cluster's width/height?
    xs = [p.data["x"] for p in pixel_recs]; ys = [p.data["y"] for p in pixel_recs]
    cx = sum(xs)/n; cy = sum(ys)/n

    # Split left vs right, top vs bottom
    left_br  = sum(p.data["brightness"] for p in pixel_recs if p.data["x"] < cx) / max(sum(1 for p in pixel_recs if p.data["x"] < cx), 1)
    right_br = sum(p.data["brightness"] for p in pixel_recs if p.data["x"] >= cx) / max(sum(1 for p in pixel_recs if p.data["x"] >= cx), 1)
    top_br   = sum(p.data["brightness"] for p in pixel_recs if p.data["y"] < cy) / max(sum(1 for p in pixel_recs if p.data["y"] < cy), 1)
    bot_br   = sum(p.data["brightness"] for p in pixel_recs if p.data["y"] >= cy) / max(sum(1 for p in pixel_recs if p.data["y"] >= cy), 1)

    dx = right_br - left_br; dy = bot_br - top_br

    # Reflectivity: fraction of pixels with very high brightness AND low saturation
    # (specular highlights = bright + desaturated)
    refl_count = sum(1 for p in pixel_recs if p.data["brightness"] > 220 and p.data["saturation"] < 0.15)
    reflectivity = min(1.0, refl_count / n * 10.0)

    # Roughness classification from texture variance + edge density
    if reflectivity > 0.6:          roughness_class = "mirror"
    elif tex_var < 50 and edge_d < 0.05: roughness_class = "glossy"
    elif tex_var < 200:             roughness_class = "satin"
    elif tex_var < 800:             roughness_class = "matte"
    else:                           roughness_class = "rough"

    # Update cluster record with computed properties
    vapor.update(cluster_record_id, {
        "texture_variance": tex_var,
        "edge_density": edge_d,
        "reflectivity": reflectivity,
    })

    return {
        "color_histogram": {
            "r": (r_mean, r_std), "g": (g_mean, g_std), "b": (b_mean, b_std)
        },
        "texture_variance": tex_var,
        "edge_density": edge_d,
        "saturation_profile": (s_mean, s_std),
        "brightness_gradient": (dx, dy),
        "reflectivity": reflectivity,
        "dominant_hue_range": (max(0, h_mean-h_std), min(360, h_mean+h_std)),
        "roughness_class": roughness_class,
        "pixel_count": n,
    }
```

---

## Step 13 — Halo-Free Background Removal (Phase 6) (IMPROVED)

```python
def isolate_foreground_halosafe(vapor, grid: dict, W: int, H: int,
                                 bg_label_keywords: list[str],
                                 corner_bright_thresh: float = 195.0,
                                 step: int = 2, label: str = "IMG") -> tuple[dict, dict]:
    """
    Remove background without halo artifacts.
    The KEY improvement over naive threshold removal:
    - Pixels ADJACENT_TO a confirmed subject cluster are NEVER removed,
      regardless of their own brightness or color.
    - BFS from corners stops at subject cluster boundaries.
    - Motion artifacts adjacent to subject boundary are preserved.

    bg_label_keywords: labels that indicate background e.g. ["background","sky","sand","water"]
    Returns (fg_mask: dict (x,y)→(r,g,b,a), stats).
    """
    import time; t0 = time.time()

    # Step 1: Mark confirmed background clusters from semantic labels
    bg_cids = set()
    for rec in vapor.query(QueryOptions(type="Cluster")).records:
        lbl = rec.data.get("semantic_class","")
        br  = rec.data.get("avg_brightness",0)
        r,g,b = rec.data.get("avg_r",0),rec.data.get("avg_g",0),rec.data.get("avg_b",0)
        if any(kw in lbl for kw in bg_label_keywords):
            bg_cids.add(rec.data["cluster_id"])
        # Also mark uniform white/neutral backgrounds
        if br > 218 and abs(r-g) < 15 and abs(g-b) < 15:
            bg_cids.add(rec.data["cluster_id"])

    # Step 2: Mark confirmed subject clusters (non-background, non-edge)
    subject_cids = set()
    for rec in vapor.query(QueryOptions(type="Cluster")).records:
        cid = rec.data["cluster_id"]
        if cid not in bg_cids:
            lbl = rec.data.get("semantic_class","")
            if "background" not in lbl and "sky" not in lbl and "sand" not in lbl:
                if rec.data["size"] > 50:  # ignore tiny noise clusters
                    subject_cids.add(cid)
                    vapor.update(rec.id, {"is_subject": True})

    # Build pixel → cluster map
    pix_map = {}
    for rec in vapor.query(QueryOptions(type="Pixel")).records:
        x,y = int(rec.data["x"]),int(rec.data["y"])
        pix_map[(x,y)] = (rec.id, rec.data["cluster"])

    # Step 3: Mark all pixels in bg_cids as background
    bg_pixels = set()
    for (x,y),(pid,cid) in pix_map.items():
        if cid in bg_cids:
            bg_pixels.add((x,y))

    # Step 4: BFS from corners for near-background stragglers
    # GUARD: never cross into a pixel whose cluster is in subject_cids
    corners = [(0,0),(W-step,0),(0,H-step),(W-step,H-step)]
    frontier = deque(); vset = set()
    for (cx,cy) in corners:
        cx = (cx//step)*step; cy = (cy//step)*step
        if (cx,cy) in pix_map:
            frontier.append((cx,cy)); vset.add((cx,cy))

    while frontier:
        (cx,cy) = frontier.popleft()
        bg_pixels.add((cx,cy))
        for dx2,dy2 in [(step,0),(-step,0),(0,step),(0,-step)]:
            nx,ny = cx+dx2,cy+dy2
            if (nx,ny) in pix_map and (nx,ny) not in vset:
                pid_n,cid_n = pix_map[(nx,ny)]
                # GUARD: don't cross subject cluster boundary
                if cid_n in subject_cids:
                    vset.add((nx,ny)); continue  # mark as visited but don't add to BG
                rec_n = vapor.get(pid_n)
                if rec_n:
                    r2,g2,b2 = rec_n.data["r"],rec_n.data["g"],rec_n.data["b"]
                    br2 = (r2+g2+b2)/3
                    if br2 > corner_bright_thresh and abs(r2-g2) < 22 and abs(g2-b2) < 22:
                        vset.add((nx,ny)); frontier.append((nx,ny))

    # Step 5: Build foreground mask
    fg = {}
    for rec in vapor.query(QueryOptions(type="Pixel")).records:
        x,y = int(rec.data["x"]),int(rec.data["y"])
        if (x,y) not in bg_pixels:
            fg[(x,y)] = (rec.data["r"],rec.data["g"],rec.data["b"],255)

    elapsed = time.time() - t0
    bg_pct = 100*len(bg_pixels)/(len(pix_map) or 1)
    print(f"  P6 [{label}] FG={len(fg)} BG_removed={len(bg_pixels)} ({bg_pct:.1f}%) | {elapsed:.1f}s")
    return fg, {"fg_pixels":len(fg),"bg_pixels":len(bg_pixels),"bg_pct":bg_pct,"time_s":elapsed}
```

---

## Step 14 — Motion Artifact Classification (NEW)

```python
def classify_motion_artifacts(vapor, subject_mask: dict,
                               step: int = 2) -> set:
    """
    Identify spray/dust/blur/splash pixels that belong to the subject's
    motion field even though they're geometrically adjacent to the background.

    Motion artifacts: sand spray at horse hooves, water splash at feet,
    hair wisps at boundary, frog tongue extension, smoke from object, etc.

    Algorithm:
    1. Find pixels adjacent to subject boundary with high edge scores but
       high color variance (spray = chaotic)
    2. Check if they form a directional cluster pointing AWAY from subject center
    3. If yes: include in subject mask

    Returns set of (x,y) coordinates to ADD to the foreground mask.
    """
    if not subject_mask: return set()

    # Compute subject centroid
    xs = [x for (x,y) in subject_mask]; ys = [y for (x,y) in subject_mask]
    cx = sum(xs)/len(xs); cy = sum(ys)/len(ys)

    # Find boundary pixels: in subject_mask AND have non-mask neighbors
    boundary_pixels = set()
    for (x,y) in subject_mask:
        for dx2,dy2 in [(step,0),(-step,0),(0,step),(0,-step)]:
            if (x+dx2,y+dy2) not in subject_mask:
                boundary_pixels.add((x,y)); break

    # Check pixels adjacent to boundary that are NOT in subject_mask
    artifact_candidates = {}  # (x,y) → score
    for (bx,by) in boundary_pixels:
        for dx2,dy2 in [(step,0),(-step,0),(0,step),(0,-step)]:
            nx,ny = bx+dx2,by+dy2
            if (nx,ny) in subject_mask: continue

            # Get pixel record
            pixel_recs = vapor.query(QueryOptions(type="Pixel", where=[
                FieldFilter("x","gte",float(nx)), FieldFilter("x","lte",float(nx)),
                FieldFilter("y","gte",float(ny)), FieldFilter("y","lte",float(ny))
            ])).records

            if not pixel_recs: continue
            rec = pixel_recs[0]

            edge_sc = rec.data["edge_score"]
            br = rec.data["brightness"]
            sat = rec.data["saturation"]

            # Spray criteria: medium edge score, variable color, not background-uniform
            is_spray_candidate = (
                edge_sc > 8 and           # some edge activity
                sat > 0.05 and            # not pure white/gray background
                br < 230                  # not background white
            )

            if is_spray_candidate:
                # Check direction: does the artifact point away from subject center?
                dir_x = nx - cx; dir_y = ny - cy
                dist_from_center = (dir_x**2 + dir_y**2) ** 0.5
                if dist_from_center > 0:
                    # Artifact is further from center than boundary pixel → outward direction
                    bdist = ((bx-cx)**2 + (by-cy)**2) ** 0.5
                    if dist_from_center > bdist:
                        artifact_candidates[(nx,ny)] = edge_sc

    # Only include artifacts that form clusters (at least 2 neighbors also are candidates)
    confirmed_artifacts = set()
    for (ax,ay) in artifact_candidates:
        neighbor_count = sum(1 for dx2,dy2 in [(step,0),(-step,0),(0,step),(0,-step)]
                            if (ax+dx2,ay+dy2) in artifact_candidates)
        if neighbor_count >= 1:
            confirmed_artifacts.add((ax,ay))

            # Tag in vapor
            pixel_recs = vapor.query(QueryOptions(type="Pixel", where=[
                FieldFilter("x","gte",float(ax)), FieldFilter("x","lte",float(ax)),
                FieldFilter("y","gte",float(ay)), FieldFilter("y","lte",float(ay))
            ])).records
            if pixel_recs:
                vapor.update(pixel_recs[0].id, {"is_motion_artifact": True})

    print(f"  Motion artifacts: {len(confirmed_artifacts)} pixels added to subject")
    return confirmed_artifacts
```

---

## Step 15 — Perspective Scale Computation (NEW)

```python
def compute_perspective_scale(horizon_y: int, anchor_y: int,
                               canvas_h: int,
                               reference_h_at_horizon: float = 0.0) -> float:
    """
    Compute the correct subject scale given its vertical position relative
    to the horizon line. Uses linear perspective projection.

    horizon_y: y-coordinate of structural boundary (horizon line)
    anchor_y: y-coordinate where subject's base (feet/hooves) will be placed
    canvas_h: total canvas height in pixels
    reference_h_at_horizon: what height the subject would be AT the horizon
                            (very small, near-0 for typical scenes)

    Returns scale factor: multiply subject pixel dimensions by this value.

    Physical basis:
    - Objects AT the horizon are infinitely far away (scale→0)
    - Objects at the BOTTOM of frame are closest (scale=1.0 or maximum)
    - Scale is linear in (anchor_y - horizon_y) / (canvas_h - horizon_y)
    """
    if anchor_y <= horizon_y:
        return 0.05  # nearly at horizon = very small

    sand_zone_h = canvas_h - horizon_y
    if sand_zone_h <= 0: return 1.0

    # Linear perspective: position in sand zone determines scale
    position_fraction = (anchor_y - horizon_y) / sand_zone_h

    # Scale: 0 at horizon, 1.0 at bottom of frame
    # For typical human/horse this means max height = ~75% of canvas_h - horizon_y
    scale = position_fraction * 0.92 + reference_h_at_horizon * (1.0 - position_fraction)
    return max(0.05, min(1.0, scale))


def compute_rider_scale(horse_mask: dict, horse_back_y: int) -> float:
    """
    Compute correct person scale for riding position.
    A rider's visible portion (hip to head) = 90% of horse back-to-ground distance.

    horse_mask: the horse foreground pixel mask dict
    horse_back_y: the y coordinate of the horse's back/saddle ridge

    Returns: target_h in pixels for the person (hip-to-head distance)
    """
    if not horse_mask: return 200.0

    ys = [y for (x,y) in horse_mask]
    horse_bottom_y = max(ys)  # hooves = bottom of horse

    back_to_ground = horse_bottom_y - horse_back_y
    rider_h = back_to_ground * 0.90  # rider visible portion = 90% of this distance

    print(f"  Rider scale: back_y={horse_back_y} bottom_y={horse_bottom_y} "
          f"back_to_ground={back_to_ground:.0f}px rider_h={rider_h:.0f}px")
    return max(50.0, rider_h)
```

---

## Step 16 — Subject Anchor Detection (NEW)

```python
def detect_subject_anchor(vapor, cluster_ids: dict,
                           subject_type: str = "horse") -> tuple[float, float]:
    """
    Find the correct mounting/contact point on a subject using semantic
    cluster traversal — NOT fixed percentage of bounding box.

    subject_type options: "horse"|"chair"|"surface"|"ground"|"any"

    For "horse": finds the back plateau by traversing horse_body clusters
                 via SPATIALLY_ABOVE to find the wide, flat back ridge
    For "chair": finds the seat surface (widest horizontal cluster in middle zone)
    For "ground": finds the lowest subject cluster centroid
    For "any": finds the topmost large cluster with wide horizontal span

    Returns (anchor_x, anchor_y) in image coordinates.
    """
    if subject_type == "horse":
        # Find all horse_body clusters
        body_clusters = []
        for rec in vapor.query(QueryOptions(type="Cluster")).records:
            lbl = rec.data.get("semantic_class","")
            if "horse_body" in lbl or "horse" in lbl:
                body_clusters.append(rec)

        if not body_clusters:
            # Fallback: use all large non-background clusters
            body_clusters = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                             if rec.data["size"] > 200 and not rec.data.get("is_background")]

        # Find the back ridge: cluster with wide horizontal span AND
        # in the upper-middle portion of the body bounding box
        if not body_clusters:
            return (0.5, 0.35)  # fallback fractions

        all_ys = [r.data["center_y"] for r in body_clusters]
        min_y_body = min(all_ys); max_y_body = max(all_ys)
        body_h = max_y_body - min_y_body

        # Back is at 35-50% from top of body bounding box
        back_y_target = min_y_body + body_h * 0.38

        # Find widest cluster near that y position
        candidates = [(rec, abs(rec.data["center_y"] - back_y_target))
                      for rec in body_clusters]
        candidates.sort(key=lambda x: x[1])

        # Among the top 5 closest to back_y_target, find widest horizontal span
        top5 = candidates[:5]
        if not top5:
            return (body_clusters[0].data["center_x"], back_y_target)

        best = max(top5, key=lambda x: x[0].data["width_span"])
        back_cluster = best[0]

        anchor_x = back_cluster.data["center_x"]
        anchor_y = back_cluster.data["center_y"]

        print(f"  Anchor [{subject_type}]: ({anchor_x:.0f},{anchor_y:.0f}) "
              f"from cluster '{back_cluster.data.get('semantic_class','?')}' "
              f"ws={back_cluster.data['width_span']:.0f}px")
        return (anchor_x, anchor_y)

    elif subject_type == "ground":
        # Lowest cluster in subject
        all_recs = vapor.query(QueryOptions(type="Cluster")).records
        subject_recs = [r for r in all_recs if not r.data.get("is_background")]
        if not subject_recs: return (0, 500)
        lowest = max(subject_recs, key=lambda r: r.data["center_y"])
        return (lowest.data["center_x"], lowest.data["center_y"])

    elif subject_type == "surface":
        # Widest horizontal cluster anywhere in the subject
        all_recs = [r for r in vapor.query(QueryOptions(type="Cluster")).records
                    if not r.data.get("is_background")]
        if not all_recs: return (0, 0)
        widest = max(all_recs, key=lambda r: r.data["width_span"])
        return (widest.data["center_x"], widest.data["center_y"])

    else:  # "any" or unknown
        all_recs = vapor.query(QueryOptions(type="Cluster")).records
        subject_recs = [r for r in all_recs if not r.data.get("is_background")
                        and r.data["size"] > 200]
        if not subject_recs: return (W//2, H//2) if 'W' in dir() else (300, 200)
        top = min(subject_recs, key=lambda r: r.data["min_y"])
        return (top.data["center_x"], top.data["center_y"])
```

---

## Step 17 — Scene Lighting Extraction (Phase 7)

```python
def extract_scene_lighting(vapor, pixels: list, W: int, H: int,
                            boundary_y: int = None,
                            zone_masks: dict = None) -> dict:
    """
    Extract full 12-variable scene lighting model from background image.

    Variables extracted:
    1. sky_color          - dominant sky RGB (flat sampled)
    2. sky_gradient       - (top_color, horizon_color) tuple
    3. sun_color          - direct sunlight color (warm bias at sunset)
    4. ambient_color      - skylight/fill color (cooler, opposite sun)
    5. light_direction    - "LEFT"|"RIGHT"|"TOP"|"FRONT"
    6. shadow_softness    - 0=hard 1=fully diffuse
    7. warm_strength      - 0-1 how warm/orange the scene is
    8. sand_color         - ground surface avg RGB
    9. water_color        - water surface avg RGB
    10. horizon_glow_color - saturated band at horizon
    11. color_temp        - "WARM_SUNSET"|"GOLDEN_HOUR"|"DAYLIGHT"|"OVERCAST"|"BLUE_HOUR"
    12. fog_depth         - estimated atmospheric haze start depth
    """
    # Determine zone boundaries
    if boundary_y is None:
        boundary_y = H // 2

    # Sample sky (above boundary)
    sky_samples = []; sky_top_samples = []; sky_horiz_samples = []
    for y in range(0, boundary_y, 3):
        for x in range(0, W, 4):
            r,g,b,_ = pixels[y][x]
            sky_samples.append((r,g,b))
            if y < boundary_y // 3: sky_top_samples.append((r,g,b))
            elif y > boundary_y * 2 // 3: sky_horiz_samples.append((r,g,b))

    def avg_color(samples):
        if not samples: return (128,128,128)
        n = len(samples)
        return tuple(int(sum(c[i] for c in samples)/n) for i in range(3))

    sky_col    = avg_color(sky_samples)
    sky_top    = avg_color(sky_top_samples)
    sky_horiz  = avg_color(sky_horiz_samples)

    # Sample ground (below boundary + 10%)
    ground_start = min(H-1, boundary_y + int((H-boundary_y)*0.1))
    sand_samples = []; water_samples = []
    for y in range(ground_start, H, 3):
        for x in range(0, W, 4):
            r,g,b,_ = pixels[y][x]
            if r > b and r > g-20:  # sandy/warm
                sand_samples.append((r,g,b))
            elif b > r and b > g:   # water/cool
                water_samples.append((r,g,b))

    sand_col  = avg_color(sand_samples) if sand_samples else (180,155,115)
    water_col = avg_color(water_samples) if water_samples else (100,130,160)

    # Horizon glow (narrow band ±15px around boundary)
    glow_samples = []
    for y in range(max(0,boundary_y-15), min(H,boundary_y+15)):
        for x in range(0, W, 4):
            r,g,b,_ = pixels[y][x]
            if r > 140 and g > 80:
                glow_samples.append((r,g,b))
    horiz_glow = avg_color(glow_samples) if glow_samples else sky_horiz

    # Light direction: compare left vs right brightness in bottom sand zone
    left_br  = sum(brightness(*pixels[y][x][:3])
                   for y in range(int(H*0.75),H)
                   for x in range(0,W//3,4)) / max(1, (H-int(H*0.75))*(W//3//4))
    right_br = sum(brightness(*pixels[y][x][:3])
                   for y in range(int(H*0.75),H)
                   for x in range(2*W//3,W,4)) / max(1, (H-int(H*0.75))*(W//3//4))

    light_from_right = right_br > left_br
    light_dir = "RIGHT" if light_from_right else "LEFT"

    # Warm strength: how orange is the sky vs neutral
    sr,sg,sb = sky_col
    warm_strength = max(0.0, min(1.0, (sr - sb) / 255.0))

    # Color temperature classification
    if warm_strength > 0.35:   color_temp = "WARM_SUNSET"
    elif warm_strength > 0.20: color_temp = "GOLDEN_HOUR"
    elif sr > 200 and sg > 200 and sb > 200: color_temp = "OVERCAST"
    elif sb > sr + 20:         color_temp = "BLUE_HOUR"
    else:                      color_temp = "DAYLIGHT"

    # Sun color: the warmest sky pixels
    bright_sky = [s for s in sky_samples if brightness(*s) > 180]
    sun_col = avg_color(sorted(bright_sky, key=lambda s: s[0]-s[2], reverse=True)[:20]) \
              if bright_sky else sky_col

    # Ambient color: cooler, complement to sun
    amb_r = max(0, sun_col[0] - 40); amb_g = sun_col[1]; amb_b = min(255, sun_col[2]+40)
    ambient_col = (amb_r, amb_g, amb_b)

    # Shadow softness: if sky is overcast → diffuse (1.0), if sunny → hard (0.0-0.4)
    sky_saturation = max(abs(sr-sg), abs(sg-sb), abs(sr-sb)) / 255.0
    shadow_softness = max(0.1, min(1.0, 1.0 - sky_saturation * 2))

    result = {
        "sky_color":         sky_col,
        "sky_gradient":      (sky_top, sky_horiz),
        "sun_color":         sun_col,
        "ambient_color":     ambient_col,
        "light_direction":   light_dir,
        "light_from_right":  light_from_right,
        "shadow_softness":   shadow_softness,
        "warm_strength":     warm_strength,
        "sand_color":        sand_col,
        "water_color":       water_col,
        "horizon_glow_color":horiz_glow,
        "color_temp":        color_temp,
        "fog_depth":         0.65,  # default: haze starts at 65% depth
        "boundary_y":        boundary_y,
    }

    print(f"  Scene: sky={sky_col} sand={sand_col} water={water_col}")
    print(f"         light={light_dir} warm={warm_strength:.2f} temp={color_temp}")
    return result
```

---

## Step 18 — Per-Cluster Lighting (Phase 8)

```python
def apply_scene_lighting_to_mask(fg_mask: dict, scene_props: dict,
                                  canvas_h: int, strength: float = 0.22) -> dict:
    """
    Re-light all pixels in fg_mask to match scene lighting.
    Applied per-pixel (respects cluster boundaries implicitly because
    all fg_mask pixels are subject pixels).

    Returns updated fg_mask with re-lit pixel values.
    """
    sr,sg,sb = scene_props["sky_color"]
    warm = scene_props["warm_strength"]
    light_right = scene_props["light_from_right"]

    # Estimate overall y range for relative position computation
    ys = [y for (x,y) in fg_mask]; y_min = min(ys); y_max = max(ys)
    y_range = max(y_max - y_min, 1)

    updated = {}
    for (x,y),(r,g,b,a) in fg_mask.items():
        rel_y = (y - y_min) / y_range  # 0=top of subject, 1=bottom

        # Warm sky tint (sunset wash): stronger at bottom (sand bounce light)
        sky_tint = strength + rel_y * 0.08
        sky_tint *= warm

        nr = clamp(r*(1-sky_tint) + sr*sky_tint)
        ng = clamp(g*(1-sky_tint*0.55) + sg*sky_tint*0.55)
        nb = clamp(b*(1-sky_tint*0.25) + sb*sky_tint*0.25)

        # Slight contrast for outdoor clarity
        nr = clamp((nr-128)*1.04+128); ng = clamp((ng-128)*1.04+128); nb = clamp((nb-128)*1.04+128)

        # Directional highlight: left or right side of subject gets slight boost
        xs_all = [xx for (xx,yy) in fg_mask]
        x_center = sum(xs_all)/len(xs_all) if xs_all else x
        is_lit_side = (light_right and x > x_center) or (not light_right and x < x_center)
        if is_lit_side:
            highlight = 0.06
            nr = clamp(nr * (1+highlight)); ng = clamp(ng * (1+highlight)); nb = clamp(nb * (1+highlight))

        updated[(x,y)] = (int(nr),int(ng),int(nb),a)

    return updated


def apply_specular_highlights(fg_mask: dict, scene_props: dict,
                               vapor=None, cluster_ids: dict = None,
                               material_class: str = "skin") -> dict:
    """
    Add directional specular highlights per material class.
    material_class: 'skin'(8)|'horse_coat'(32)|'clothing'(4)|'sand_dry'(2)|
                   'wet_surface'(64)|'water'(256)|'metal'(512)|'glass'(1024)|
                   'frog_skin'(8)|'lily_pad'(12)
    """
    exponents = {
        "skin":8,"horse_coat":32,"clothing":4,"sand_dry":2,"wet_surface":64,
        "water":256,"metal":512,"glass":1024,"frog_skin":8,"lily_pad":12,
        "hair":16,"fur":8,"plastic_matte":4,"plastic_glossy":128,
    }
    exp = exponents.get(material_class, 8)
    sr,sg,sb = scene_props["sun_color"]
    light_right = scene_props["light_from_right"]

    xs_all = [x for (x,y) in fg_mask]
    x_center = sum(xs_all)/len(xs_all) if xs_all else 0

    updated = dict(fg_mask)
    for (x,y),(r,g,b,a) in fg_mask.items():
        # Approximate surface normal from relative x position (crude but cheap)
        rel_x = (x - x_center) / (max(xs_all)-min(xs_all)+1) if xs_all else 0
        # Surface normal points toward camera and slightly to lit side
        dot = abs(rel_x) * (1.0 if (light_right and rel_x > 0) or
                                   (not light_right and rel_x < 0) else 0.2)
        if dot > 0.05:
            spec = dot ** exp  # specular term
            nr = clamp(r + (sr-r)*spec*0.8)
            ng = clamp(g + (sg-g)*spec*0.8)
            nb = clamp(b + (sb-b)*spec*0.8)
            updated[(x,y)] = (int(nr),int(ng),int(nb),a)

    return updated


def apply_sss_approximation(fg_mask: dict, scene_props: dict,
                             vapor=None) -> dict:
    """
    Sub-surface scattering approximation for organic surfaces (skin, frog, leaf).
    Warm translucent glow at boundary pixels facing the light source.
    Effect: edge pixels toward light get red-channel boost.
    Effect: rim-lit edges get slight red+blue boost (cool rim light).
    """
    sr,sg,sb = scene_props["sun_color"]
    light_right = scene_props["light_from_right"]
    mask_set = set(fg_mask.keys())

    xs_all = [x for (x,y) in fg_mask]
    x_min = min(xs_all); x_max = max(xs_all)
    step = 2  # assume step=2 sampling

    updated = dict(fg_mask)
    for (x,y),(r,g,b,a) in fg_mask.items():
        # Is this a boundary pixel?
        is_boundary = any((x+dx2,y+dy2) not in mask_set
                         for dx2,dy2 in [(step,0),(-step,0),(0,step),(0,-step)])
        if not is_boundary: continue

        rel_x = (x - (x_min+x_max)/2) / max(x_max-x_min,1)
        facing_light = (light_right and rel_x > 0) or (not light_right and rel_x < 0)

        if facing_light:
            # Warm SSS glow: boost red-channel by 15-25%
            sss_strength = 0.18
            nr = clamp(r + (sr-r)*sss_strength)
            ng = clamp(g + max(0,sg-g)*sss_strength*0.4)
            nb = clamp(b)
        else:
            # Cool rim light: slight red+blue boost
            rim_strength = 0.08
            nr = clamp(r + rim_strength*20)
            ng = clamp(g)
            nb = clamp(b + rim_strength*20)

        updated[(x,y)] = (int(nr),int(ng),int(nb),a)

    return updated
```

---

## Step 19 — Scene Construction & Compositing (Phase 9-10)

```python
def scale_mask_to_target(mask: dict, target_h_px: float,
                          step: int = 2) -> tuple[dict, float]:
    """
    Scale a pixel mask to a target height in pixels.
    Returns (scaled_mask, actual_scale_factor).
    Preserves aspect ratio.
    """
    if not mask: return {}, 1.0

    xs = [x for (x,y) in mask]; ys = [y for (x,y) in mask]
    src_x0,src_x1 = min(xs),max(xs); src_y0,src_y1 = min(ys),max(ys)
    src_w = src_x1-src_x0+1; src_h = src_y1-src_y0+1
    scale = target_h_px / src_h
    tgt_w = int(src_w * scale); tgt_h = int(target_h_px)

    scaled = {}
    for sy in range(tgt_h):
        raw_sy = int(sy/scale) + src_y0; raw_sy = (raw_sy//step)*step
        for sx in range(tgt_w):
            raw_sx = int(sx/scale) + src_x0; raw_sx = (raw_sx//step)*step
            if (raw_sx,raw_sy) in mask:
                scaled[(sx,sy)] = mask[(raw_sx,raw_sy)]

    print(f"  Scaled mask: {src_w}x{src_h} → {tgt_w}x{tgt_h} (scale={scale:.3f})")
    return scaled, scale


def paint_mask_onto_canvas(canvas: list, mask: dict, BW: int, BH: int,
                            cx_frac: float, feet_y: int,
                            scene_props: dict = None,
                            edge_blend: bool = True,
                            feather_px: int = 3) -> dict:
    """
    Paint a pixel mask onto a canvas at specified position.
    cx_frac: center x as fraction of canvas width (0-1)
    feet_y: y-coordinate where subject base (feet/hooves) should be placed

    Returns placement_info dict.
    """
    if not mask: return {}

    xs = [x for (x,y) in mask]; ys = [y for (x,y) in mask]
    tgt_w = max(xs)-min(xs)+1; tgt_h = max(ys)-min(ys)+1

    left_x = int(BW*cx_frac) - tgt_w//2
    top_y  = feet_y - tgt_h

    # Build edge set for boundary blending
    mask_set = set(mask.keys())
    edge_set = set()
    if edge_blend:
        for (sx,sy) in mask:
            for dx2,dy2 in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(-1,-1),(1,-1),(-1,1)]:
                if (sx+dx2,sy+dy2) not in mask_set:
                    edge_set.add((sx,sy)); break

    placed = 0
    for (sx,sy),(r,g,b,a) in mask.items():
        cx2 = left_x+sx; cy2 = top_y+sy
        if not (0<=cx2<BW and 0<=cy2<BH): continue

        # Alpha blending at boundary
        if (sx,sy) in edge_set:
            # Multi-pixel feather based on distance to boundary
            min_dist = feather_px+1
            for dd in range(1,feather_px+1):
                for dx2,dy2 in [(dd,0),(-dd,0),(0,dd),(0,-dd)]:
                    if (sx+dx2,sy+dy2) not in mask_set:
                        min_dist = min(min_dist,dd); break
                if min_dist <= feather_px: break
            alpha = 0.65 + 0.35*(min_dist/feather_px)
        else:
            alpha = 1.0

        bg = canvas[cy2][cx2]
        canvas[cy2][cx2] = [
            clamp(int(r*alpha + bg[0]*(1-alpha))),
            clamp(int(g*alpha + bg[1]*(1-alpha))),
            clamp(int(b*alpha + bg[2]*(1-alpha))),
            255
        ]
        placed += 1

    print(f"  Placed: {placed}px | edge_blend: {len(edge_set)}px | "
          f"pos=({left_x},{top_y}) size={tgt_w}x{tgt_h}")
    return {"placed_pixels":placed,"edge_pixels":len(edge_set),
            "left_x":left_x,"top_y":top_y,"feet_y":feet_y,
            "tgt_w":tgt_w,"tgt_h":tgt_h,"cx2":int(BW*cx_frac)}
```

---

## Step 20 — Contact Zone, Shadows, Ground Reflection (Phase 11)

```python
def generate_contact_zone(canvas: list, BW: int, BH: int,
                           feet_x: int, feet_y: int,
                           subject_w: int, scene_props: dict,
                           contact_type: str = "standard") -> None:
    """
    Generate physical contact effects where subject meets surface:
    1. Contact shadow ellipse (directional, colored from sand/surface)
    2. Ambient occlusion ring at feet
    3. For organic surfaces: slight surface darkening/compression

    contact_type: "standard"|"wet_surface"|"soft_ground"|"hard_floor"
    """
    sand_r,sand_g,sand_b = scene_props.get("sand_color",(180,155,115))
    light_right = scene_props.get("light_from_right", True)
    warm = scene_props.get("warm_strength", 0.3)

    shadow_color = (int(sand_r*0.38), int(sand_g*0.30), int(sand_b*0.25))

    # Shadow offset direction: opposite to light source
    sx_off = int(subject_w*0.18) * (-1 if light_right else 1)

    # Main contact shadow ellipse
    sh_cx = feet_x + sx_off; sh_cy = feet_y + 5
    sh_rx = int(subject_w*0.42); sh_ry = max(6, int(BH*0.022))

    for dy2 in range(-sh_ry*3, sh_ry*3+1):
        for dx2 in range(-sh_rx*2, sh_rx*2+1):
            px = sh_cx+dx2; py = sh_cy+dy2
            if not (0<=px<BW and 0<=py<BH): continue
            ex = (dx2/sh_rx)**2 + (dy2/sh_ry)**2
            if ex < 4.0:
                strength = max(0.0, (1.0-ex/4.0)) * 0.60
                bg = canvas[py][px]
                canvas[py][px] = [
                    clamp(int(bg[0]*(1-strength)+shadow_color[0]*strength)),
                    clamp(int(bg[1]*(1-strength)+shadow_color[1]*strength)),
                    clamp(int(bg[2]*(1-strength)+shadow_color[2]*strength)),
                    255
                ]

    # Cast shadow on ground in light direction
    sh2_len = int(subject_w * 0.6)
    for i in range(sh2_len):
        t = i/sh2_len
        px = feet_x + int(subject_w*0.2*t * (-1 if light_right else 1))
        py = feet_y + int(sh2_len*0.08*t)
        sw = max(1, int(subject_w*0.15*(1-t*0.5)))
        if 0<=py<BH:
            for ddx in range(-sw, sw+1):
                ppx = px+ddx
                if 0<=ppx<BW:
                    str2 = (1-t)*0.35
                    bg = canvas[py][ppx]
                    canvas[py][ppx] = [
                        clamp(int(bg[0]*(1-str2)+shadow_color[0]*str2)),
                        clamp(int(bg[1]*(1-str2)+shadow_color[1]*str2)),
                        clamp(int(bg[2]*(1-str2)+shadow_color[2]*str2)),
                        255
                    ]

    # Ambient occlusion ring directly at feet
    ao_w = int(subject_w*0.45); ao_h_range = 10
    for dy2 in range(ao_h_range):
        for dx2 in range(-ao_w, ao_w+1):
            px = feet_x+dx2; py = feet_y+dy2
            if not (0<=px<BW and 0<=py<BH): continue
            fade = (1.0-dy2/ao_h_range) * (1.0-abs(dx2)/ao_w)
            str3 = 0.30 * fade
            bg = canvas[py][px]
            canvas[py][px] = [clamp(int(bg[0]*(1-str3))),
                               clamp(int(bg[1]*(1-str3))),
                               clamp(int(bg[2]*(1-str3))),255]

    if contact_type == "soft_ground":
        # Slight darkening of surface under full subject footprint
        for dy2 in range(-3, ao_h_range):
            for dx2 in range(-int(ao_w*0.7), int(ao_w*0.7)+1):
                px = feet_x+dx2; py = feet_y+dy2
                if not (0<=px<BW and 0<=py<BH): continue
                str4 = 0.12 * max(0,(1.0-abs(dx2)/(ao_w*0.7)))
                bg = canvas[py][px]
                canvas[py][px] = [clamp(int(bg[0]*(1-str4))),
                                   clamp(int(bg[1]*(1-str4))),
                                   clamp(int(bg[2]*(1-str4))),255]


def generate_ground_reflection(canvas: list, subject_mask: dict,
                                BW: int, BH: int, feet_y: int,
                                scene_props: dict,
                                reflection_opacity: float = 0.38,
                                wave_amplitude: float = 3.0) -> None:
    """
    Generate physically correct reflection of subject in wet sand or water.
    Flips subject mask vertically below feet_y, applies wave distortion,
    desaturates, darkens, and blends at reflection_opacity.

    wave_amplitude: pixels of horizontal distortion (2-4 calm, 8-15 choppy)
    """
    if not subject_mask: return

    xs = [x for (x,y) in subject_mask]; ys = [y for (x,y) in subject_mask]
    src_x0 = min(xs); src_y0 = min(ys); src_y1 = max(ys)
    sub_h = src_y1 - src_y0

    # Build reflection: flip vertically from feet_y downward
    reflection = {}
    for (sx,sy),(r,g,b,a) in subject_mask.items():
        # Mirror y relative to feet_y
        refl_y = feet_y + (feet_y - sy) * 0.35  # compress reflection
        refl_x = sx  # same x
        # Wave distortion: horizontal sine displacement
        wave_offset = int(wave_amplitude * math.sin(refl_y * 0.08 + sx * 0.02))
        final_x = int(refl_x + wave_offset)
        final_y = int(refl_y)

        if 0<=final_x<BW and feet_y<final_y<BH:
            # Desaturate and darken
            h2,s2,v2 = rgb_to_hsv(r,g,b)
            s2 *= 0.45; v2 *= 0.40
            rr,gg,bb = hsv_to_rgb(h2,s2,v2)
            reflection[(final_x,final_y)] = (rr,gg,bb)

    # Blur reflection horizontally (simulate ripple blur)
    for (fx,fy),(r,g,b) in reflection.items():
        if not (0<=fx<BW and 0<=fy<BH): continue
        # Distance below feet determines blur amount
        depth_below = fy - feet_y
        blur_r = max(0, int(depth_below * 0.04))

        # Average with neighbors
        if blur_r > 0 and blur_r < 5:
            neighbors = [(fx+dx2,fy) for dx2 in range(-blur_r,blur_r+1)
                        if (fx+dx2,fy) in reflection]
            if neighbors:
                avg_r = sum(reflection.get((nx,fy),(r,g,b))[0] for nx,_ in neighbors)/len(neighbors)
                avg_g = sum(reflection.get((nx,fy),(r,g,b))[1] for nx,_ in neighbors)/len(neighbors)
                avg_b = sum(reflection.get((nx,fy),(r,g,b))[2] for nx,_ in neighbors)/len(neighbors)
                r,g,b = int(avg_r),int(avg_g),int(avg_b)

        bg = canvas[fy][fx]
        canvas[fy][fx] = [
            clamp(int(r*reflection_opacity + bg[0]*(1-reflection_opacity))),
            clamp(int(g*reflection_opacity + bg[1]*(1-reflection_opacity))),
            clamp(int(b*reflection_opacity + bg[2]*(1-reflection_opacity))),
            255
        ]

    print(f"  Ground reflection: {len(reflection)} pixels at opacity={reflection_opacity:.2f}")
```

---

## Step 21 — Post-Processing (Phase 11 Extras)

```python
def render_horizon_glow(canvas: list, BW: int, BH: int,
                         boundary_y: int, scene_props: dict,
                         glow_width: int = 25) -> None:
    """Add sunset/twilight horizon glow band at structural boundary."""
    gr,gg,gb = scene_props.get("horizon_glow_color", (255,180,80))
    warm = scene_props.get("warm_strength", 0.3)
    if warm < 0.15: return  # no glow for cool/neutral scenes

    for y in range(max(0,boundary_y-glow_width), min(BH,boundary_y+glow_width//2)):
        dist = abs(y - boundary_y)
        glow_t = max(0.0, 1.0-dist/glow_width) * warm * 0.35
        for x in range(BW):
            px = canvas[y][x]
            canvas[y][x] = [
                clamp(int(px[0]*(1-glow_t)+gr*glow_t)),
                clamp(int(px[1]*(1-glow_t)+gg*glow_t)),
                clamp(int(px[2]*(1-glow_t)+gb*glow_t)),
                255
            ]


def apply_depth_fog(canvas: list, BW: int, BH: int,
                    scene_props: dict, fog_start_y_frac: float = 0.0) -> None:
    """
    Atmospheric perspective: desaturate and haze distant elements.
    Applied per-pixel based on y position (top = far = more fog).
    Only affects top 50% of canvas (sky/horizon zone).
    """
    sr,sg,sb = scene_props.get("sky_color",(180,180,200))
    boundary_y = scene_props.get("boundary_y", BH//2)

    for y in range(int(BH*0.5)):
        if y >= boundary_y: continue
        # Fog increases toward top of frame (more distance = more haze)
        depth_t = max(0.0, (boundary_y - y) / boundary_y) * 0.22
        for x in range(BW):
            px = canvas[y][x]
            canvas[y][x] = [
                clamp(int(px[0]*(1-depth_t)+sr*depth_t)),
                clamp(int(px[1]*(1-depth_t)+sg*depth_t)),
                clamp(int(px[2]*(1-depth_t)+sb*depth_t)),
                255
            ]


def apply_vignette(canvas: list, BW: int, BH: int,
                   strength: float = 0.42) -> None:
    """Per-pixel radial vignette. Applied LAST, only to unconstrained version."""
    for y in range(BH):
        for x in range(BW):
            nx = (x/BW-0.5)*2; ny = (y/BH-0.5)*2
            dist = (nx**2+ny**2)**0.5
            v = max(0.0, 1.0-max(0.0,(dist-0.55)/0.70)*strength)
            px = canvas[y][x]
            canvas[y][x] = [clamp(int(px[0]*v)),clamp(int(px[1]*v)),clamp(int(px[2]*v)),255]


def procedural_sand_texture(canvas: list, BW: int, BH: int,
                             sand_start_y: int, scene_props: dict) -> None:
    """
    Add grain texture to sand zone using spatially-correlated noise.
    Uses fractional Brownian motion approximation (layered cosine waves).
    NOT per-pixel hash — produces realistic grain correlation.
    """
    sr,sg,sb = scene_props.get("sand_color",(180,155,115))
    for y in range(sand_start_y, BH):
        for x in range(0, BW, 2):
            # fBm: 3 octaves of cosine noise
            n  = math.cos(x*0.15 + y*0.07) * 0.5
            n += math.cos(x*0.31 + y*0.19) * 0.25
            n += math.cos(x*0.73 + y*0.47) * 0.125
            # Ripple from wet sand
            n += math.sin(x*0.09 + y*0.05) * 0.08
            grain = n * 0.04  # scale to ±4%

            px = canvas[y][x]
            canvas[y][x] = [
                clamp(int(px[0]*(1+grain))),
                clamp(int(px[1]*(1+grain*0.9))),
                clamp(int(px[2]*(1+grain*0.7))),
                255
            ]
```

---

## Step 22 — Color Transformation (Per-Cluster, Luminance-Preserving)

```python
def apply_color_swap_per_cluster(vapor, cluster_ids: dict,
                                  source_hue_range: tuple,
                                  target_hue: float,
                                  target_saturation_scale: float = 0.85,
                                  subject_labels: list = None) -> int:
    """
    Semantic-aware color swap preserving luminance structure.
    Applies ONLY to clusters matching subject_labels (not background).

    source_hue_range: (min_hue, max_hue) e.g. (75, 165) for green
    target_hue: target hue in degrees e.g. 18.0 for warm red-orange
    target_saturation_scale: scale factor for saturation (0.85 = 85% of original)
    subject_labels: list of semantic_class keywords to include

    Returns count of pixels swapped.
    """
    if subject_labels is None:
        subject_labels = []  # will apply to all non-background clusters

    swapped = 0
    hmin, hmax = source_hue_range

    for cid, crid in cluster_ids.items():
        crec = vapor.get(crid)
        if not crec: continue

        lbl = crec.data.get("semantic_class","")
        # Skip if subject_labels specified and this cluster doesn't match
        if subject_labels and not any(kw in lbl for kw in subject_labels):
            continue
        # Skip background
        if crec.data.get("is_background") or lbl in ("white_background","background"):
            continue

        # Check if cluster avg hue is in source range
        avg_h = crec.data.get("avg_hue",0)
        if not (hmin <= avg_h <= hmax):
            continue

        # Query pixels in this cluster
        # Use SAME_CLUSTER incoming (cluster←pixel) direction
        pixel_rels = vapor.get_relationships(crid, "SAME_CLUSTER", "incoming")

        for rel in pixel_rels:
            prec = vapor.get(rel.source_id)
            if not prec: continue

            ph = prec.data["hue"]; ps = prec.data["saturation"]
            pv = prec.data["brightness"] / 255.0

            # Only swap pixels whose hue is in source range
            if not (hmin <= ph <= hmax): continue

            # Shift hue to target, scale saturation, preserve value
            new_h = target_hue
            new_s = min(1.0, ps * target_saturation_scale)
            nr,ng,nb = hsv_to_rgb(new_h, new_s, pv)

            vapor.update(prec.id, {
                "r": float(nr), "g": float(ng), "b": float(nb),
                "hue": new_h, "saturation": new_s,
            })
            swapped += 1

    print(f"  Color swap: {swapped} pixels ({source_hue_range}° → {target_hue:.0f}°)")
    return swapped


def correct_outline_after_swap(vapor, body_labels: list, outline_labels: list,
                                target_hue: float,
                                target_saturation_scale: float = 0.7) -> int:
    """
    After swapping body cluster colors, also correct adjacent outline clusters.
    Example: after swapping green frog body → red, dark green outlines → dark maroon.
    This prevents color mismatch between swapped body and unswapped outlines.
    """
    # Find outline clusters adjacent to body clusters
    body_crecs = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                  if any(kw in rec.data.get("semantic_class","") for kw in body_labels)]

    outline_cids = set()
    for brec in body_crecs:
        # ADJACENT_TO is undirected — use "both"
        adj = vapor.get_relationships(brec.id, "ADJACENT_TO", "both")
        for e in adj:
            nid = e.target_id if e.source_id == brec.id else e.source_id
            nrec = vapor.get(nid)
            if nrec:
                nlbl = nrec.data.get("semantic_class","")
                if any(kw in nlbl for kw in outline_labels):
                    outline_cids.add(nid)

    corrected = 0
    for crid in outline_cids:
        crec = vapor.get(crid)
        if not crec: continue
        pixel_rels = vapor.get_relationships(crid, "SAME_CLUSTER", "incoming")
        for rel in pixel_rels:
            prec = vapor.get(rel.source_id)
            if not prec: continue
            pv = prec.data["brightness"] / 255.0
            ps = prec.data["saturation"]
            new_h = target_hue
            new_s = min(1.0, ps * target_saturation_scale)
            nr,ng,nb = hsv_to_rgb(new_h, new_s, pv)
            vapor.update(prec.id, {"r":float(nr),"g":float(ng),"b":float(nb),
                                    "hue":new_h,"saturation":new_s})
            corrected += 1

    print(f"  Outline correction: {corrected} pixels in {len(outline_cids)} outline clusters")
    return corrected
```

---

## Step 23 — Object Inference (Phase 5b)

```python
def infer_objects(vapor, image_type: str = "generic") -> list[dict]:
    """
    Traverse cluster relationships to infer composite semantic objects.
    This is where individual labeled clusters combine into 'hand', 'face', 'body'.

    Uses ADJACENCY + SYMMETRY + SPATIAL chains for inference.
    Returns list of inferred object dicts.
    """
    inferred = []

    def query_by_label(keyword):
        return [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                if keyword in rec.data.get("semantic_class","")]

    # ── Skin-based object inference ────────────────────────────────────────
    fingertips = query_by_label("fingertip")
    fingers    = query_by_label("finger_segment")
    skin_large = [r for r in query_by_label("skin_region") if r.data["size"] > 300]
    skin_ovals = query_by_label("large_skin_oval")
    arms       = query_by_label("arm_segment")

    # Hand detection: palm cluster with 3+ digit neighbors
    for palm in skin_large:
        adj = vapor.get_relationships(palm.id, "ADJACENT_TO", "both")
        digit_count = 0
        for e in adj:
            nid = e.target_id if e.source_id == palm.id else e.source_id
            nr = vapor.get(nid)
            if nr and nr.data.get("semantic_class","") in ("fingertip","finger_segment"):
                digit_count += 1
        if digit_count >= 2:
            inferred.append({
                "object": "hand",
                "center_x": palm.data["center_x"], "center_y": palm.data["center_y"],
                "evidence": f"{digit_count} digit clusters adjacent to palm"
            })

    # Face detection: large oval skin in upper 40% with dark circle(s) adjacent
    all_c = vapor.query(QueryOptions(type="Cluster")).records
    all_min_y = min(r.data["min_y"] for r in all_c) if all_c else 0
    all_max_y = max(r.data["max_y"] for r in all_c) if all_c else 100
    img_h = all_max_y - all_min_y

    for oval in skin_ovals:
        rel_y = (oval.data["center_y"]-all_min_y)/img_h if img_h > 0 else 0.5
        if rel_y < 0.45 and oval.data["convexity"] > 0.55:
            adj = vapor.get_relationships(oval.id, "ADJACENT_TO", "both")
            dark_circles = sum(1 for e in adj
                               if vapor.get(e.target_id if e.source_id==oval.id else e.source_id)
                               and vapor.get(e.target_id if e.source_id==oval.id else e.source_id
                                            ).data.get("semantic_class","") in
                               ("dark_circle","round_skin_blob","dark_blob"))
            if dark_circles >= 1:
                inferred.append({
                    "object": "face",
                    "center_x": oval.data["center_x"], "center_y": oval.data["center_y"],
                    "evidence": f"large skin oval at {rel_y:.0%} height with {dark_circles} dark circle(s)"
                })

    # Bilateral symmetry detection → animal or human body
    sym_count = sum(1 for rec in all_c
                    if vapor.get_relationships(rec.id, "SYMMETRICAL_WITH", "both"))
    if sym_count >= 4:
        inferred.append({
            "object": "bilaterally_symmetric_subject",
            "evidence": f"{sym_count} clusters with symmetric partners"
        })

    # ── Animal-specific inference ─────────────────────────────────────────
    if image_type in ("horse","frog","animal"):
        body_clusters = query_by_label("horse_body") or query_by_label("frog_body")
        if len(body_clusters) >= 3:
            cx = sum(r.data["center_x"] for r in body_clusters) / len(body_clusters)
            cy = sum(r.data["center_y"] for r in body_clusters) / len(body_clusters)
            inferred.append({
                "object": "animal_body",
                "center_x": cx, "center_y": cy,
                "evidence": f"{len(body_clusters)} body clusters with bilateral symmetry"
            })

    return inferred
```

---

## Step 24 — Reconstruction from Vapor Index

```python
def reconstruct_from_vapor(vapor, width: int, height: int,
                            output_path: str = "output.png",
                            step: int = 2) -> None:
    """
    Reconstruct PNG from vapor pixel index.
    Reads current r,g,b,a values from all Pixel records.
    Fills step×step blocks for sampled images.
    """
    canvas = [[(0,0,0,0)]*width for _ in range(height)]

    all_pix = vapor.query(QueryOptions(type="Pixel"))
    for rec in all_pix.records:
        x = int(rec.data["x"]); y = int(rec.data["y"])
        r = int(clamp(rec.data["r"])); g = int(clamp(rec.data["g"]))
        b = int(clamp(rec.data["b"])); a = int(clamp(rec.data.get("a",255)))
        for dy2 in range(step):
            for dx2 in range(step):
                py2,px2 = y+dy2,x+dx2
                if 0<=px2<width and 0<=py2<height:
                    canvas[py2][px2] = (r,g,b,a)

    write_png_raw(output_path, width, height, canvas)
```

---

## Step 25 — Full Pipeline Template

```python
# ══════════════════════════════════════════════════════════════════════════════
# FULL PIPELINE — adapt for any compositing scenario
# ══════════════════════════════════════════════════════════════════════════════

import time; PIPELINE_START = time.time()
print("="*60 + "\nVAPOR-IDX PIPELINE — " + "="*40)

# ── Configuration ─────────────────────────────────────────────────────────────
SUBJECT_FP   = "/home/claude/subject.png"   # the subject to extract
ENVIRON_FP   = "/home/claude/background.png" # the target environment
OUTPUT_FP    = "/home/claude/composite.png"
IMAGE_TYPE   = "outdoor_scene"  # affects semantic labeling
BG_LABELS    = ["sky","sand","water","background","foam","white_background"]
STEP         = 2                # sampling step — keep consistent across images

# ── Load ──────────────────────────────────────────────────────────────────────
SW,SH,subj_pix  = load_image(SUBJECT_FP)
BW,BH,bg_pix    = load_image(ENVIRON_FP)

# ═══════════════════════════════════════════════════
# VAPOR INSTANCE 1: SUBJECT
# ═══════════════════════════════════════════════════
print("\n" + "─"*40 + "\nVAPOR INSTANCE 1: SUBJECT\n" + "─"*40)
v_subj = make_vapor_schema(include_skeleton=False, include_scene=False)

# Phase 1: Index
grid_s, st1 = index_pixels(v_subj, SW, SH, subj_pix, step=STEP, label="SUBJ")

# Phase 2: Sobel
st2 = compute_sobel_edges(v_subj, grid_s, SW, SH, step=STEP, label="SUBJ")

# Phase 3: Clusters
cids_s, st3 = detect_clusters(v_subj, grid_s, SW, SH, step=STEP,
                                colour_tolerance=42.0, label="SUBJ")

# Phase 4: Relationships
st4 = build_cluster_relationships(v_subj, cids_s, label="SUBJ")

# Phase 5: Semantic 5x
lh_s, st5 = semantic_label_clusters_5x(v_subj, cids_s,
                                         image_type=IMAGE_TYPE, label="SUBJ")

# Phase 5b: Object inference
inferred_s = infer_objects(v_subj, image_type=IMAGE_TYPE)
print(f"  Inferred: {[o['object'] for o in inferred_s]}")

# Phase 6: Halo-free background removal
subj_mask, st6 = isolate_foreground_halosafe(v_subj, grid_s, SW, SH,
                                              bg_label_keywords=BG_LABELS,
                                              step=STEP, label="SUBJ")

# Detect and preserve motion artifacts
artifacts = classify_motion_artifacts(v_subj, subj_mask, step=STEP)
subj_mask.update({(x,y): subj_pix[y][x][:3]+(255,) for (x,y) in artifacts})

v_subj.destroy(); print("  Vapor instance 1 destroyed")

# ═══════════════════════════════════════════════════
# VAPOR INSTANCE 2: BACKGROUND SCENE ANALYSIS
# ═══════════════════════════════════════════════════
print("\n" + "─"*40 + "\nVAPOR INSTANCE 2: BACKGROUND\n" + "─"*40)
v_bg = make_vapor_schema(include_scene=True)

grid_b, st_b1 = index_pixels(v_bg, BW, BH, bg_pix, step=STEP+1, label="BG")
st_b2 = compute_sobel_edges(v_bg, grid_b, BW, BH, step=STEP+1, threshold=12.0, label="BG")
cids_b, st_b3 = detect_clusters(v_bg, grid_b, BW, BH, step=STEP+1,
                                  colour_tolerance=45.0, label="BG")
build_cluster_relationships(v_bg, cids_b, label="BG")
semantic_label_clusters_5x(v_bg, cids_b, image_type="outdoor_scene", label="BG")

# Scene analysis
boundary_info = detect_structural_boundary(v_bg, grid_b, BW, BH, step=STEP+1)
horizon_y = boundary_info["y"]
zone_masks = segment_environment_zones(v_bg, grid_b, BW, BH,
                                        boundary_y=horizon_y,
                                        step=STEP+1, scene_type="outdoor")
scene_props = extract_scene_lighting(v_bg, bg_pix, BW, BH,
                                      boundary_y=horizon_y, zone_masks=zone_masks)

v_bg.destroy(); print("  Vapor instance 2 destroyed")

# ═══════════════════════════════════════════════════
# SCENE CONSTRUCTION
# ═══════════════════════════════════════════════════
print("\n" + "─"*40 + "\nSCENE CONSTRUCTION\n" + "─"*40)

# Apply scene lighting to subject
subj_lit = apply_scene_lighting_to_mask(subj_mask, scene_props, BH)
subj_lit = apply_specular_highlights(subj_lit, scene_props,
                                      material_class="skin")
subj_lit = apply_sss_approximation(subj_lit, scene_props)

# Compute correct scale using perspective
feet_y_target = int(BH * 0.88)  # where subject base should land
scale_f = compute_perspective_scale(horizon_y, feet_y_target, BH)
# Target height = scale_f * available ground zone height
target_h = int(scale_f * (BH - horizon_y) * 1.1)
scaled_mask, actual_scale = scale_mask_to_target(subj_lit, target_h, step=STEP)

# Initialize canvas from background
canvas = [[list(bg_pix[y][x][:3])+[255] for x in range(BW)] for y in range(BH)]

# Paint subject
cx_frac = 0.52  # slightly right of center
placement = paint_mask_onto_canvas(canvas, scaled_mask, BW, BH,
                                    cx_frac=cx_frac, feet_y=feet_y_target,
                                    scene_props=scene_props,
                                    edge_blend=True, feather_px=4)

# Physical contact effects
if placement:
    feet_cx = placement["cx2"]
    generate_contact_zone(canvas, BW, BH, feet_cx, feet_y_target,
                          placement["tgt_w"], scene_props)
    generate_ground_reflection(canvas, scaled_mask, BW, BH, feet_y_target,
                               scene_props, reflection_opacity=0.32)

# Environment rendering
render_horizon_glow(canvas, BW, BH, horizon_y, scene_props)
apply_depth_fog(canvas, BW, BH, scene_props)

# Sand texture on ground zone
sand_start = int(BH * 0.68)
procedural_sand_texture(canvas, BW, BH, sand_start, scene_props)

# Vignette (unconstrained only)
apply_vignette(canvas, BW, BH, strength=0.40)

# Output
out = [[tuple(canvas[y][x]) for x in range(BW)] for y in range(BH)]
write_png_raw(OUTPUT_FP, BW, BH, out)

total_s = time.time()-PIPELINE_START
print(f"\nPIPELINE COMPLETE in {total_s:.1f}s → {OUTPUT_FP}")
```

---

## Output

After running the pipeline, report:
- Per-instance pixel/cluster/relationship counts
- Semantic label distribution (top 15 per image)
- Background removal stats (FG%, BG%)
- Scene lighting extracted values (all 12 variables)
- Boundary detection result (y, type, confidence)
- Zone masks (zone names + pixel counts)
- Placement info (scale, position, edge blend count)
- Motion artifacts preserved
- Total pipeline time

Save final PNG to /mnt/user-data/outputs/. Describe confidence per label (how many of 5 passes agreed).
