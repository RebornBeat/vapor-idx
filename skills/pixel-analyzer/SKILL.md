---
name: Pixel Analyzer
description: Analyze, understand, and reconstruct images by indexing raw pixel data into vapor-idx. No PIL, no YOLO, no ML. Parse PNG/PPM/BMP directly with built-in Python. Build semantic understanding bottom-up through relationship traversal — pixel clusters become regions, regions become features, features become objects. Geometric transforms applied through the index. 5x validation pass on all semantic conclusions.
version: 2.0.0
tools:
  - computer_use
---

# Pixel Analyzer Skill

## Purpose

Index raw image pixels into vapor-idx and reason over the structured index using
Claude's built-in semantic knowledge — no ML models, no PIL, no external libraries.
Parse image formats directly with Python's built-in `struct` and `zlib`.

Build understanding **bottom up**: individual pixels → connected clusters →
geometric shapes → features → semantic parts → identified objects.

Claude traverses relationships in the index rather than running top-down
object detection.

## When to trigger

- "Analyze this image and describe what you see"
- "Find all red / dark / bright regions"
- "What objects are visible in this image?"
- "Detect edges and describe the shapes"
- "Invert / transform / recolour this image"
- "Describe the spatial layout of elements"
- Any image understanding or transformation task

## Supported raw formats (no external libraries)

- **PNG** — parsed with `struct` + `zlib` (built-in)
- **PPM/PGM/PBM** — plain text pixel format, trivial to parse
- **BMP** — parsed with `struct` (built-in)
- **Raw RGBA dumps** — if provided as bytes

## Environment

Python computer-use. No additional installs required beyond vapor-idx.

```bash
pip install vapor-idx
```

---

## Step 1 — Raw format parsers

```python
import struct, zlib

def parse_png(filepath: str) -> tuple[int, int, list]:
    """
    Parse a PNG file using only built-in Python (struct + zlib).
    Returns (width, height, pixels) where pixels[y][x] = (r, g, b, a).
    Handles filter types 0-4 (None, Sub, Up, Average, Paeth).
    Supports colour types: 0=Grey, 2=RGB, 4=Grey+Alpha, 6=RGBA.
    """
    with open(filepath, 'rb') as f:
        raw = f.read()

    assert raw[:8] == b'\x89PNG\r\n\x1a\n', f"Not a PNG: {filepath}"

    pos       = 8
    width     = 0
    height    = 0
    bit_depth = 0
    clr_type  = 0
    idat      = b''

    while pos < len(raw):
        length     = struct.unpack('>I', raw[pos:pos+4])[0]
        chunk_type = raw[pos+4:pos+8]
        chunk_data = raw[pos+8:pos+8+length]
        pos       += 12 + length

        if chunk_type == b'IHDR':
            width, height = struct.unpack('>II', chunk_data[:8])
            bit_depth     = chunk_data[8]
            clr_type      = chunk_data[9]
        elif chunk_type == b'IDAT':
            idat += chunk_data
        elif chunk_type == b'IEND':
            break

    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(clr_type, 3)
    scanline_len = width * channels

    decompressed = zlib.decompress(idat)
    pixels = []
    prev  = bytes(scanline_len)

    for y in range(height):
        base    = y * (scanline_len + 1)
        flt     = decompressed[base]
        row     = bytearray(decompressed[base+1 : base+1+scanline_len])

        if flt == 1:   # Sub
            for i in range(channels, len(row)):
                row[i] = (row[i] + row[i-channels]) & 0xFF
        elif flt == 2: # Up
            for i in range(len(row)):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif flt == 3: # Average
            for i in range(len(row)):
                a = row[i-channels] if i >= channels else 0
                row[i] = (row[i] + (a + prev[i]) // 2) & 0xFF
        elif flt == 4: # Paeth
            for i in range(len(row)):
                a = row[i-channels] if i >= channels else 0
                b = prev[i]
                c = prev[i-channels] if i >= channels else 0
                p  = a + b - c
                pr = a if abs(p-a) <= abs(p-b) and abs(p-a) <= abs(p-c) \
                     else (b if abs(p-b) <= abs(p-c) else c)
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

        pixels.append(row_pixels)
        prev = bytes(row)

    return width, height, pixels


def parse_ppm(filepath: str) -> tuple[int, int, list]:
    """
    Parse PPM/PGM (P3/P6/P5) — no external libraries needed.
    PPM is the simplest lossless format for raw pixel data.
    """
    with open(filepath, 'rb') as f:
        data = f.read()

    lines = data.split(b'\n')
    magic = lines[0].strip()
    # Skip comment lines
    header_lines = [l for l in lines if not l.startswith(b'#')]
    dims         = header_lines[1].split()
    width, height = int(dims[0]), int(dims[1])

    if magic == b'P3':  # ASCII RGB
        vals = [int(v) for line in header_lines[2:] for v in line.split()]
        # skip maxval line
        vals = vals[1:]  # drop maxval
        pixels = []
        idx = 0
        for y in range(height):
            row = []
            for x in range(width):
                r, g, b = vals[idx], vals[idx+1], vals[idx+2]
                row.append((r, g, b, 255))
                idx += 3
            pixels.append(row)
    elif magic == b'P6':  # Binary RGB
        # Find where binary data starts (after third newline)
        header_end = data.index(b'\n', data.index(b'\n', data.index(b'\n')+1)+1) + 1
        binary = data[header_end:]
        pixels = []
        pos = 0
        for y in range(height):
            row = []
            for x in range(width):
                r, g, b = binary[pos], binary[pos+1], binary[pos+2]
                row.append((r, g, b, 255))
                pos += 3
            pixels.append(row)
    else:
        raise ValueError(f"Unsupported PPM magic: {magic}")

    return width, height, pixels


def parse_bmp(filepath: str) -> tuple[int, int, list]:
    """
    Parse BMP using only struct (built-in).
    Supports 24-bit and 32-bit uncompressed BMP.
    """
    with open(filepath, 'rb') as f:
        data = f.read()

    assert data[:2] == b'BM', "Not a BMP file"
    pixel_offset = struct.unpack_from('<I', data, 10)[0]
    width        = struct.unpack_from('<i', data, 18)[0]
    height       = struct.unpack_from('<i', data, 22)[0]
    bpp          = struct.unpack_from('<H', data, 28)[0]
    flipped      = height > 0  # positive height = bottom-up
    height       = abs(height)

    bytes_per_pixel = bpp // 8
    row_size        = (width * bytes_per_pixel + 3) & ~3  # 4-byte aligned

    raw_pixels = []
    for y in range(height):
        row_y    = (height - 1 - y) if flipped else y
        row_off  = pixel_offset + row_y * row_size
        row      = []
        for x in range(width):
            off = row_off + x * bytes_per_pixel
            if bytes_per_pixel == 4:
                b, g, r, a = data[off], data[off+1], data[off+2], data[off+3]
            else:
                b, g, r = data[off], data[off+1], data[off+2]
                a = 255
            row.append((r, g, b, a))
        raw_pixels.append(row)

    return width, height, raw_pixels


def write_png_raw(filepath: str, width: int, height: int, pixels: list) -> None:
    """
    Write PNG using only struct + zlib (built-in).
    pixels[y][x] must be (r, g, b, a) tuples.
    """
    def make_chunk(tag: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(tag + body) & 0xFFFFFFFF
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', crc)

    rows = bytearray()
    for row in pixels:
        rows += b'\x00'  # filter type None
        for r, g, b, a in row:
            rows += bytes([
                max(0, min(255, int(r))),
                max(0, min(255, int(g))),
                max(0, min(255, int(b))),
                max(0, min(255, int(a))),
            ])

    sig  = b'\x89PNG\r\n\x1a\n'
    ihdr = make_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    idat = make_chunk(b'IDAT', zlib.compress(bytes(rows), 9))
    iend = make_chunk(b'IEND', b'')

    with open(filepath, 'wb') as f:
        f.write(sig + ihdr + idat + iend)
    print(f"Saved {filepath} ({width}×{height})")


def load_image(filepath: str) -> tuple[int, int, list]:
    """Auto-detect format and parse raw. Returns (w, h, pixels[y][x]=(r,g,b,a))."""
    ext = filepath.rsplit('.', 1)[-1].lower()
    if ext == 'png':  return parse_png(filepath)
    if ext in ('ppm','pgm','pbm'): return parse_ppm(filepath)
    if ext == 'bmp':  return parse_bmp(filepath)
    raise ValueError(f"Unsupported format: {ext}. Convert to PNG/PPM/BMP first.")
```

---

## Step 2 — Schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions, PathOptions

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
                "hue":        {"type": "number", "index": "range"},
                "saturation": {"type": "number", "index": "range"},
                "edge_score": {"type": "number", "index": "range"},
                "cluster":    {"type": "string", "index": "exact"},
                "feature":    {"type": "string", "index": "keyword"},
                "layer":      {"type": "string", "index": "exact"},
            },
            "relationships": {
                "ADJACENT_TO": {
                    "targetTypes": ["Pixel"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
                "SAME_CLUSTER": {
                    "targetTypes": ["Cluster"],
                    "directed":    True,
                    "cardinality": "many-to-one",
                },
            },
        },
        "Cluster": {
            "fields": {
                "cluster_id":  {"type": "string", "index": "exact"},
                "label":       {"type": "string", "index": "keyword"},
                "size":        {"type": "number", "index": "range"},
                "center_x":    {"type": "number", "index": "range"},
                "center_y":    {"type": "number", "index": "range"},
                "min_x":       {"type": "number", "index": "range"},
                "max_x":       {"type": "number", "index": "range"},
                "min_y":       {"type": "number", "index": "range"},
                "max_y":       {"type": "number", "index": "range"},
                "width_span":  {"type": "number", "index": "range"},
                "height_span": {"type": "number", "index": "range"},
                "aspect_ratio":{"type": "number", "index": "range"},
                "avg_r":       {"type": "number", "index": "range"},
                "avg_g":       {"type": "number", "index": "range"},
                "avg_b":       {"type": "number", "index": "range"},
                "avg_brightness":{"type": "number","index": "range"},
                "is_edge":     {"type": "boolean","index": "exact"},
                "convexity":   {"type": "number", "index": "range"},
                "perimeter":   {"type": "number", "index": "range"},
                "semantic_class": {"type": "string","index": "keyword"},
                "confidence_passes": {"type": "number","index": "range"},
            },
            "relationships": {
                "ADJACENT_TO": {
                    "targetTypes": ["Cluster"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
                "PART_OF": {
                    "targetTypes": ["Cluster"],
                    "directed":    True,
                    "cardinality": "many-to-one",
                },
                "CONTAINS": {
                    "targetTypes": ["Cluster"],
                    "directed":    True,
                    "cardinality": "one-to-many",
                },
                "SPATIALLY_LEFT_OF": {
                    "targetTypes": ["Cluster"],
                    "directed":    True,
                    "cardinality": "many-to-many",
                },
                "SPATIALLY_ABOVE":   {
                    "targetTypes": ["Cluster"],
                    "directed":    True,
                    "cardinality": "many-to-many",
                },
                "SYMMETRICAL_WITH": {
                    "targetTypes": ["Cluster"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
            },
        },
    },
})
```

---

## Step 3 — Index raw pixels into vapor

```python
def rgb_to_hsv(r, g, b):
    """Convert RGB (0-255) to HSV (h: 0-360, s: 0-1, v: 0-1). No libraries."""
    r, g, b = r/255, g/255, b/255
    mx, mn  = max(r,g,b), min(r,g,b)
    delta   = mx - mn
    v       = mx
    s       = (delta / mx) if mx > 0 else 0
    if delta == 0:
        h = 0.0
    elif mx == r:
        h = 60 * (((g-b)/delta) % 6)
    elif mx == g:
        h = 60 * ((b-r)/delta + 2)
    else:
        h = 60 * ((r-g)/delta + 4)
    return h, s, v


def index_pixels(vapor, width: int, height: int, pixels: list) -> dict:
    """
    Index all pixels into vapor. Returns grid dict: (x,y) -> record_id.
    Computes HSV alongside RGB for richer queries without any library.
    For large images (>128x128) sample every 2nd pixel for performance.
    """
    grid: dict[tuple, str] = {}
    step = 1 if max(width, height) <= 256 else 2

    for y in range(0, height, step):
        for x in range(0, width, step):
            r, g, b, a = pixels[y][x]
            h, s, v    = rgb_to_hsv(r, g, b)
            brightness = (r + g + b) / 3.0

            pid = vapor.store("Pixel", {
                "x":          float(x),
                "y":          float(y),
                "r":          float(r),
                "g":          float(g),
                "b":          float(b),
                "a":          float(a),
                "brightness": brightness,
                "hue":        h,
                "saturation": s,
                "edge_score": 0.0,
                "cluster":    "",
                "feature":    "",
                "layer":      "base",
            })
            grid[(x, y)] = pid

    # 4-connectivity adjacency (only between sampled pixels)
    for y in range(0, height, step):
        for x in range(0, width, step):
            pid = grid.get((x, y))
            if not pid: continue
            right = grid.get((x+step, y))
            down  = grid.get((x, y+step))
            if right: vapor.relate(pid, "ADJACENT_TO", right)
            if down:  vapor.relate(pid, "ADJACENT_TO", down)

    actual_w = len(range(0, width,  step))
    actual_h = len(range(0, height, step))
    print(f"Indexed {actual_w * actual_h} pixels ({width}×{height} at step={step}).")
    print(f"Stats: {vapor.stats()}")
    return grid
```

---

## Step 4 — Compute edge scores (Sobel, no libraries)

```python
def compute_sobel_edges(vapor, grid: dict, width: int, height: int,
                        step: int = 1, threshold: float = 20.0) -> None:
    """
    Compute Sobel gradient magnitude for each pixel using neighbour lookups
    through the vapor index. Updates edge_score in place.
    """
    def get_brightness(x, y):
        rec = vapor.get(grid.get((x, y), ""))
        return rec.data["brightness"] if rec else 0.0

    for y in range(step, height - step, step):
        for x in range(step, width - step, step):
            key = (x, y)
            if key not in grid: continue
            gx = (
                -1 * get_brightness(x-step, y-step) +
                 1 * get_brightness(x+step, y-step) +
                -2 * get_brightness(x-step, y) +
                 2 * get_brightness(x+step, y) +
                -1 * get_brightness(x-step, y+step) +
                 1 * get_brightness(x+step, y+step)
            )
            gy = (
                -1 * get_brightness(x-step, y-step) +
                -2 * get_brightness(x,      y-step) +
                -1 * get_brightness(x+step, y-step) +
                 1 * get_brightness(x-step, y+step) +
                 2 * get_brightness(x,      y+step) +
                 1 * get_brightness(x+step, y+step)
            )
            score = (gx**2 + gy**2) ** 0.5
            if score > threshold:
                vapor.update(grid[key], {"edge_score": score})
```

---

## Step 5 — Connected cluster detection (flood fill through vapor relationships)

```python
def detect_clusters(vapor, grid: dict, width: int, height: int,
                    step: int = 1,
                    colour_tolerance: float = 40.0,
                    min_cluster_size: int = 8) -> dict:
    """
    Find connected pixel clusters by traversing ADJACENT_TO relationships.
    Two adjacent pixels belong to the same cluster if their colour distance
    is within colour_tolerance.
    Returns cluster_id -> Cluster record_id mapping.
    """
    visited: set[str]  = set()
    cluster_ids: dict[str, str] = {}  # pixel_id -> cluster_record_id
    cluster_counter = 0

    def colour_distance(a_rec, b_rec) -> float:
        return ((a_rec.data["r"] - b_rec.data["r"])**2 +
                (a_rec.data["g"] - b_rec.data["g"])**2 +
                (a_rec.data["b"] - b_rec.data["b"])**2) ** 0.5

    def flood_fill(start_pid: str) -> list[str]:
        """BFS flood fill returning all pixel IDs in this cluster."""
        cluster_pixels = []
        queue = [start_pid]
        local_visited = {start_pid}
        seed_rec = vapor.get(start_pid)
        if not seed_rec: return []

        while queue:
            current_pid = queue.pop(0)
            current_rec = vapor.get(current_pid)
            if not current_rec: continue
            cluster_pixels.append(current_pid)

            # Follow ADJACENT_TO edges
            neighbours = vapor.getRelationships(current_pid, "ADJACENT_TO", "both")
            for edge in neighbours:
                nbr_id = edge.target_id if edge.source_id == current_pid else edge.source_id
                if nbr_id in local_visited or nbr_id in visited: continue
                nbr_rec = vapor.get(nbr_id)
                if not nbr_rec: continue
                if colour_distance(seed_rec, nbr_rec) <= colour_tolerance:
                    local_visited.add(nbr_id)
                    queue.append(nbr_id)

        return cluster_pixels

    # Walk all indexed pixels
    for pid in list({v for v in grid.values() if v}):
        if pid in visited: continue
        cluster_pixels = flood_fill(pid)
        visited.update(cluster_pixels)

        if len(cluster_pixels) < min_cluster_size: continue

        cluster_counter += 1
        cid = f"cluster_{cluster_counter:04d}"

        # Compute cluster statistics
        recs = [vapor.get(p) for p in cluster_pixels if vapor.get(p)]
        xs   = [r.data["x"] for r in recs]
        ys   = [r.data["y"] for r in recs]
        rs   = [r.data["r"] for r in recs]
        gs   = [r.data["g"] for r in recs]
        bs   = [r.data["b"] for r in recs]
        brs  = [r.data["brightness"] for r in recs]

        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        w_span       = max_x - min_x + 1
        h_span       = max_y - min_y + 1
        aspect       = w_span / h_span if h_span > 0 else 1.0
        is_edge      = any(r.data["edge_score"] > 10 for r in recs)

        # Estimate perimeter: pixels that have at least one neighbour in a different cluster
        perimeter_count = 0
        for p in cluster_pixels[:200]:  # sample first 200 for speed
            edges = vapor.getRelationships(p, "ADJACENT_TO", "both")
            for e in edges:
                nbr_id = e.target_id if e.source_id == p else e.source_id
                if nbr_id not in set(cluster_pixels):
                    perimeter_count += 1
                    break

        # Convexity proxy: area / (width_span * height_span)
        area      = float(len(cluster_pixels))
        convexity = area / (w_span * h_span) if (w_span * h_span) > 0 else 0.0

        crid = vapor.store("Cluster", {
            "cluster_id":    cid,
            "label":         "",
            "size":          area,
            "center_x":      sum(xs) / len(xs),
            "center_y":      sum(ys) / len(ys),
            "min_x":         float(min_x),
            "max_x":         float(max_x),
            "min_y":         float(min_y),
            "max_y":         float(max_y),
            "width_span":    float(w_span),
            "height_span":   float(h_span),
            "aspect_ratio":  aspect,
            "avg_r":         sum(rs) / len(rs),
            "avg_g":         sum(gs) / len(gs),
            "avg_b":         sum(bs) / len(bs),
            "avg_brightness":sum(brs) / len(brs),
            "is_edge":       is_edge,
            "convexity":     convexity,
            "perimeter":     float(perimeter_count),
            "semantic_class":  "",
            "confidence_passes": 0.0,
        })

        for p in cluster_pixels:
            vapor.update(p, {"cluster": cid})
            vapor.relate(p, "SAME_CLUSTER", crid)

        cluster_ids[cid] = crid

    print(f"Found {cluster_counter} clusters.")
    return cluster_ids
```

---

## Step 6 — Build spatial relationships between clusters

```python
def build_cluster_relationships(vapor, cluster_ids: dict) -> None:
    """
    For each pair of clusters, compute spatial relationships and store them
    as edges in vapor. These relationships are what Claude traverses to
    build semantic understanding.
    """
    all_clusters = vapor.query(QueryOptions(type="Cluster"))
    recs = all_clusters.records

    for i in range(len(recs)):
        for j in range(i+1, len(recs)):
            a = recs[i].data
            b = recs[j].data

            # Bounding box overlap or adjacency
            a_left, a_right = a["min_x"], a["max_x"]
            a_top,  a_bot   = a["min_y"], a["max_y"]
            b_left, b_right = b["min_x"], b["max_x"]
            b_top,  b_bot   = b["min_y"], b["max_y"]

            # Check adjacency (within 5 pixels)
            horiz_adjacent = (abs(a_right - b_left) < 5 or abs(b_right - a_left) < 5)
            vert_adjacent  = (abs(a_bot   - b_top)  < 5 or abs(b_bot   - a_top)  < 5)
            overlap        = not (a_right < b_left or b_right < a_left or
                                  a_bot   < b_top  or b_bot   < a_top)

            if horiz_adjacent or vert_adjacent or overlap:
                vapor.relate(recs[i].id, "ADJACENT_TO", recs[j].id)

            # Relative position
            a_cx, a_cy = a["center_x"], a["center_y"]
            b_cx, b_cy = b["center_x"], b["center_y"]

            if a_cx < b_cx - 10:
                vapor.relate(recs[i].id, "SPATIALLY_LEFT_OF", recs[j].id)
            if a_cy < b_cy - 10:
                vapor.relate(recs[i].id, "SPATIALLY_ABOVE", recs[j].id)

            # Symmetry detection: similar size + mirrored position relative to image centre
            size_similar = abs(a["size"] - b["size"]) / max(a["size"], b["size"], 1) < 0.3
            colour_close = ((a["avg_r"]-b["avg_r"])**2 +
                            (a["avg_g"]-b["avg_g"])**2 +
                            (a["avg_b"]-b["avg_b"])**2) ** 0.5 < 40
            if size_similar and colour_close:
                vapor.relate(recs[i].id, "SYMMETRICAL_WITH", recs[j].id)

    print("Cluster spatial relationships built.")
```

---

## Step 7 — Bottom-up semantic labelling with 5x validation pass

This is the core: Claude traverses the indexed relationships and applies its
own knowledge to label clusters from the ground up — without any ML model.

```python
def classify_cluster(cluster_data: dict, adjacent_clusters: list[dict]) -> str:
    """
    Claude applies semantic knowledge to a single cluster based on its
    geometric properties and spatial relationships.
    Returns a semantic label string.
    This function embeds Claude's knowledge directly as decision logic.
    """
    size       = cluster_data["size"]
    aspect     = cluster_data["aspect_ratio"]
    convexity  = cluster_data["convexity"]
    is_edge    = cluster_data["is_edge"]
    brightness = cluster_data["avg_brightness"]
    r          = cluster_data["avg_r"]
    g          = cluster_data["avg_g"]
    b          = cluster_data["avg_b"]
    w_span     = cluster_data["width_span"]
    h_span     = cluster_data["height_span"]

    # Skin tone range (Fitzpatrick scale average)
    is_skin_tone = (r > 130 and r > g and r > b and
                    g > 60 and b > 40 and
                    r - b > 30 and r - g < 80)

    # Dark with high edge score = likely contour/outline
    if is_edge and brightness < 60:
        return "contour_edge"

    # Very small uniform clusters = noise or texture grain
    if size < 20:
        return "texture_grain"

    # Approximately circular (aspect near 1, high convexity)
    is_circular = 0.7 <= aspect <= 1.4 and convexity > 0.65

    # Approximately rectangular (extreme convexity, non-square aspect)
    is_rectangular = convexity > 0.75 and (aspect < 0.5 or aspect > 2.0)

    # Elongated vertically
    is_vert_elongated = aspect < 0.5 and h_span > w_span * 2

    # Elongated horizontally
    is_horiz_elongated = aspect > 2.0 and w_span > h_span * 2

    # Has symmetrical neighbour = likely paired body part (arms, legs, eyes)
    has_symmetric_partner = any("SYMMETRICAL_WITH" in str(adj) for adj in adjacent_clusters)

    # Bottom-up labelling hierarchy
    # Level 1: primitive shapes
    if is_circular and size < 150:
        if is_skin_tone:
            return "round_skin_blob"  # could be fingertip, eye highlight, etc.
        if brightness > 200:
            return "bright_circle"   # eye white, button, circular light
        return "dark_circle"         # pupil, hole, button

    if is_circular and size >= 150:
        if is_skin_tone:
            return "large_skin_oval"  # face, palm, shoulder
        return "large_oval"

    if is_vert_elongated:
        if is_skin_tone:
            return "vertical_skin_strip"  # finger, arm, leg segment
        if brightness > 180:
            return "vertical_light_bar"
        return "vertical_dark_bar"

    if is_horiz_elongated:
        if is_skin_tone:
            return "horizontal_skin_strip"
        return "horizontal_bar"

    if is_rectangular and size > 500:
        if brightness > 180:
            return "large_bright_rect"  # background, sky, wall, paper
        if brightness < 60:
            return "large_dark_rect"    # shadow, dark surface, clothing
        return "large_rect"

    # Mid-size skin regions
    if is_skin_tone and size > 200:
        return "skin_region"

    # Fallback
    if brightness > 200:
        return "bright_blob"
    if brightness < 50:
        return "dark_blob"
    return "undefined_region"


def semantic_label_clusters_5x(vapor, cluster_ids: dict) -> dict:
    """
    Apply bottom-up semantic labelling with 5x validation pass.

    For each cluster:
    1. Classify it based on geometry + colour
    2. Check consistency with adjacent cluster labels
    3. Repeat 5 times, updating the label if new evidence changes it
    4. Only commit the label when it is stable across all 5 passes

    Returns cluster_id -> final_label mapping.
    """
    label_history: dict[str, list[str]] = {cid: [] for cid in cluster_ids}

    for pass_num in range(5):
        all_clusters = vapor.query(QueryOptions(type="Cluster"))

        for rec in all_clusters.records:
            cid = rec.data["cluster_id"]

            # Get adjacent cluster data for context
            adj_edges   = vapor.getRelationships(rec.id, "ADJACENT_TO", "both")
            adj_recs    = [vapor.get(e.target_id if e.source_id==rec.id else e.source_id)
                           for e in adj_edges]
            adj_data    = [a.data for a in adj_recs if a]
            adj_labels  = [a["semantic_class"] for a in adj_data if a.get("semantic_class")]

            # Apply classification
            label = classify_cluster(rec.data, adj_data)

            # Context refinement using adjacent labels from previous passes
            # If surrounded by skin_region blobs → likely a body part component
            skin_neighbours = sum(1 for l in adj_labels if "skin" in l)
            if skin_neighbours >= 2 and "skin" not in label:
                if rec.data["aspect_ratio"] < 0.5:
                    label = "finger_segment"   # vertical elongated near skin = finger
                elif rec.data["aspect_ratio"] > 2.0:
                    label = "arm_segment"

            # If small round skin blob adjacent to large skin oval → likely fingertip near palm
            if label == "round_skin_blob":
                large_skin_adj = any("large_skin_oval" in l or "skin_region" in l
                                     for l in adj_labels)
                if large_skin_adj:
                    label = "fingertip"

            # Accumulate history
            history = label_history.setdefault(cid, [])
            history.append(label)

            # Update in vapor with current pass result
            passes_so_far = len(history)
            # Stable if last 3 labels agree
            if passes_so_far >= 3 and len(set(history[-3:])) == 1:
                confirmed_label = history[-1]
            else:
                # Take majority vote from history so far
                from collections import Counter
                confirmed_label = Counter(history).most_common(1)[0][0]

            vapor.update(rec.id, {
                "semantic_class":    confirmed_label,
                "confidence_passes": float(passes_so_far),
            })

        print(f"  Semantic pass {pass_num+1}/5 complete.")

    # Final summary
    final = vapor.query(QueryOptions(type="Cluster"))
    label_counts: dict[str, int] = {}
    for rec in final.records:
        lbl = rec.data.get("semantic_class","?")
        label_counts[lbl] = label_counts.get(lbl, 0) + 1

    print("Final label distribution:")
    for lbl, count in sorted(label_counts.items(), key=lambda x: -x[1])[:15]:
        print(f"  {count:4d}  {lbl}")

    return label_history
```

---

## Step 8 — Build higher-level semantic objects from cluster groups

```python
def infer_objects(vapor) -> list[dict]:
    """
    After 5x labelling, traverse cluster relationships to infer composite objects.
    This is where 'thumb → hand → arm → body' happens:
    - Find fingertip clusters adjacent to finger_segment clusters
    - Find finger groups adjacent to a palm (skin_region with high convexity)
    - Find palm adjacent to arm_segment → hand + arm = limb
    - Find symmetrical limb pairs → body (bilateral symmetry)
    Claude's structural anatomy knowledge is encoded as these rules.
    """
    inferred = []

    # Query for specific cluster types
    fingertips   = vapor.query(QueryOptions(type="Cluster",
        where=FieldFilter(field="semantic_class", op="eq", value="fingertip")))
    fingers      = vapor.query(QueryOptions(type="Cluster",
        where=FieldFilter(field="semantic_class", op="eq", value="finger_segment")))
    skin_regions = vapor.query(QueryOptions(type="Cluster",
        where=[FieldFilter(field="semantic_class", op="eq", value="skin_region"),
               FieldFilter(field="size", op="gt", value=300)]))
    arms         = vapor.query(QueryOptions(type="Cluster",
        where=FieldFilter(field="semantic_class", op="eq", value="arm_segment")))
    large_ovals  = vapor.query(QueryOptions(type="Cluster",
        where=FieldFilter(field="semantic_class", op="eq", value="large_skin_oval")))

    # Rule: fingertip + adjacent finger_segment = digit
    digits_found = 0
    for tip in fingertips.records:
        adj = vapor.getRelationships(tip.id, "ADJACENT_TO", "both")
        for e in adj:
            nbr = vapor.get(e.target_id if e.source_id==tip.id else e.source_id)
            if nbr and nbr.data.get("semantic_class") == "finger_segment":
                digits_found += 1
                break

    # Rule: 3+ digits adjacent to a skin_region = hand
    hands_found = 0
    for palm in skin_regions.records:
        adj = vapor.getRelationships(palm.id, "ADJACENT_TO", "both")
        digit_count = 0
        for e in adj:
            nbr = vapor.get(e.target_id if e.source_id==palm.id else e.source_id)
            if nbr and nbr.data.get("semantic_class") in ("fingertip","finger_segment"):
                digit_count += 1
        if digit_count >= 3:
            hands_found += 1
            inferred.append({
                "object": "hand",
                "center_x": palm.data["center_x"],
                "center_y": palm.data["center_y"],
                "evidence": f"{digit_count} digit clusters adjacent to palm region",
            })

    # Rule: hand adjacent to arm_segment = limb (arm)
    limbs_found = 0
    for arm in arms.records:
        adj = vapor.getRelationships(arm.id, "ADJACENT_TO", "both")
        for e in adj:
            nbr = vapor.get(e.target_id if e.source_id==arm.id else e.source_id)
            if nbr and "hand" in str([i["object"] for i in inferred]):
                limbs_found += 1
                inferred.append({
                    "object": "arm_and_hand_limb",
                    "evidence": "arm_segment adjacent to identified hand cluster",
                })
                break

    # Rule: large_skin_oval with high convexity near top of image = face
    for oval in large_ovals.records:
        total_h = vapor.query(QueryOptions(type="Cluster")).records
        if total_h:
            all_min_y = min(r.data["min_y"] for r in total_h)
            all_max_y = max(r.data["max_y"] for r in total_h)
            img_height = all_max_y - all_min_y
            # Face is typically in upper third of image
            rel_y = (oval.data["center_y"] - all_min_y) / img_height if img_height > 0 else 0.5
            if rel_y < 0.4 and oval.data["convexity"] > 0.6:
                # Check for dark_circle nearby (eyes/pupils)
                adj = vapor.getRelationships(oval.id, "ADJACENT_TO", "both")
                dark_circles = 0
                for e in adj:
                    nbr = vapor.get(e.target_id if e.source_id==oval.id else e.source_id)
                    if nbr and nbr.data.get("semantic_class") in ("dark_circle","round_skin_blob"):
                        dark_circles += 1
                if dark_circles >= 1:
                    inferred.append({
                        "object": "face",
                        "center_x": oval.data["center_x"],
                        "center_y": oval.data["center_y"],
                        "evidence": f"large oval skin region in upper {int(rel_y*100)}% of image with {dark_circles} dark circle(s) adjacent",
                    })

    # Rule: 2+ SYMMETRICAL_WITH pairs among large clusters = bilateral symmetric body
    sym_pairs = vapor.query(QueryOptions(type="Cluster"))
    sym_count = 0
    for rec in sym_pairs.records:
        sym_edges = vapor.getRelationships(rec.id, "SYMMETRICAL_WITH", "both")
        if sym_edges: sym_count += 1
    if sym_count >= 4:
        inferred.append({
            "object": "bilaterally_symmetric_subject",
            "evidence": f"{sym_count} clusters with symmetric partners — consistent with animal/human body",
        })

    return inferred


def describe_image(vapor, inferred_objects: list[dict]) -> str:
    """
    Compose a natural language description of what Claude sees in the image
    based entirely on the indexed relationships.
    """
    lines = ["## Image analysis (vapor-idx relationship traversal)\n"]

    all_clusters = vapor.query(QueryOptions(type="Cluster"))
    total        = all_clusters.total

    # Label distribution
    labels: dict[str, int] = {}
    for rec in all_clusters.records:
        lbl = rec.data.get("semantic_class", "?")
        labels[lbl] = labels.get(lbl, 0) + 1

    lines.append(f"**Total clusters identified:** {total}")
    lines.append(f"**Dominant colour regions:**")
    for lbl, cnt in sorted(labels.items(), key=lambda x: -x[1])[:8]:
        lines.append(f"  - {lbl}: {cnt} cluster(s)")

    # Spatial summary
    bright = vapor.query(QueryOptions(type="Cluster",
        where=FieldFilter(field="avg_brightness", op="gt", value=180)))
    dark   = vapor.query(QueryOptions(type="Cluster",
        where=FieldFilter(field="avg_brightness", op="lt", value=60)))
    lines.append(f"\n**Bright regions:** {bright.total}  |  **Dark regions:** {dark.total}")

    if inferred_objects:
        lines.append(f"\n**Inferred objects ({len(inferred_objects)}):**")
        for obj in inferred_objects:
            pos = f"at ({obj.get('center_x',0):.0f},{obj.get('center_y',0):.0f})" \
                  if "center_x" in obj else ""
            lines.append(f"  - **{obj['object']}** {pos} — {obj['evidence']}")
    else:
        lines.append("\n**No composite objects inferred.** Review cluster labels above.")

    return "\n".join(lines)
```

---

## Step 9 — Pixel-level transforms through the index

```python
def transform_pixels(vapor, operation: str, **kwargs) -> None:
    """
    Apply colour transformations directly through the vapor index.
    No image library — update records in place, then reconstruct.
    """
    all_pix = vapor.query(QueryOptions(type="Pixel",
        where=FieldFilter(field="layer", op="eq", value="base")))

    if operation == "invert":
        for rec in all_pix.records:
            vapor.update(rec.id, {
                "r": 255.0 - rec.data["r"],
                "g": 255.0 - rec.data["g"],
                "b": 255.0 - rec.data["b"],
            })

    elif operation == "greyscale":
        for rec in all_pix.records:
            v = rec.data["brightness"]
            vapor.update(rec.id, {"r": v, "g": v, "b": v})

    elif operation == "contrast":
        factor = kwargs.get("factor", 1.5)
        for rec in all_pix.records:
            vapor.update(rec.id, {
                "r": max(0.0, min(255.0, (rec.data["r"] - 128) * factor + 128)),
                "g": max(0.0, min(255.0, (rec.data["g"] - 128) * factor + 128)),
                "b": max(0.0, min(255.0, (rec.data["b"] - 128) * factor + 128)),
            })

    elif operation == "hue_shift":
        # Shift hue by degrees — implemented without external libs
        shift = kwargs.get("shift_degrees", 90)
        def hsv_to_rgb(h, s, v):
            if s == 0: c = int(v*255); return c, c, c
            h /= 60
            i = int(h); f = h - i
            p, q, t = v*(1-s), v*(1-s*f), v*(1-s*(1-f))
            p,q,t,v = int(p*255),int(q*255),int(t*255),int(v*255)
            return [(v,t,p),(q,v,p),(p,v,t),(p,q,v),(t,p,v),(v,p,q)][i%6]
        for rec in all_pix.records:
            new_h = (rec.data["hue"] + shift) % 360
            nr, ng, nb = hsv_to_rgb(new_h, rec.data["saturation"],
                                    rec.data["brightness"]/255.0)
            vapor.update(rec.id, {
                "r": float(nr), "g": float(ng), "b": float(nb),
                "hue": new_h,
            })

    elif operation == "threshold":
        cutoff = kwargs.get("cutoff", 128)
        for rec in all_pix.records:
            v = 255.0 if rec.data["brightness"] >= cutoff else 0.0
            vapor.update(rec.id, {"r": v, "g": v, "b": v})

    elif operation == "recolour_cluster":
        # Recolour a specific cluster by semantic label
        target_label = kwargs.get("label", "")
        new_r = kwargs.get("r", 255)
        new_g = kwargs.get("g", 0)
        new_b = kwargs.get("b", 0)
        target_clusters = vapor.query(QueryOptions(type="Cluster",
            keywords=target_label))
        for crec in target_clusters.records:
            cid = crec.data["cluster_id"]
            pixels_in_cluster = vapor.query(QueryOptions(type="Pixel",
                where=FieldFilter(field="cluster", op="eq", value=cid)))
            for prec in pixels_in_cluster.records:
                vapor.update(prec.id, {
                    "r": float(new_r), "g": float(new_g), "b": float(new_b)
                })

    print(f"Transform '{operation}' applied to {all_pix.total} pixels.")
```

---

## Step 10 — Reconstruct raw PNG from vapor index

```python
def reconstruct_png(vapor, width: int, height: int,
                    output_path: str = "output.png",
                    step: int = 1) -> None:
    """
    Reconstruct image from vapor pixel index and write raw PNG.
    No PIL — pure Python struct + zlib.
    """
    # Build pixel grid from index
    canvas = [[(0,0,0,0)] * width for _ in range(height)]

    all_pix = vapor.query(QueryOptions(type="Pixel"))
    for rec in all_pix.records:
        x = int(rec.data["x"])
        y = int(rec.data["y"])
        r = max(0, min(255, int(rec.data["r"])))
        g = max(0, min(255, int(rec.data["g"])))
        b = max(0, min(255, int(rec.data["b"])))
        a = max(0, min(255, int(rec.data.get("a", 255))))
        # If step > 1, fill in the sampled block
        for dy in range(step):
            for dx in range(step):
                py, px = y+dy, x+dx
                if 0 <= px < width and 0 <= py < height:
                    canvas[py][px] = (r, g, b, a)

    write_png_raw(output_path, width, height, canvas)
```

---

## Step 11 — Full pipeline

```python
# ── Load
width, height, pixels = load_image("input.png")
step = 1 if max(width, height) <= 128 else 2

# ── Index
grid = index_pixels(vapor, width, height, pixels)

# ── Edges
compute_sobel_edges(vapor, grid, width, height, step=step, threshold=15.0)

# ── Clusters
cluster_ids = detect_clusters(vapor, grid, width, height, step=step,
                               colour_tolerance=45.0, min_cluster_size=step*step*4)

# ── Spatial relationships
build_cluster_relationships(vapor, cluster_ids)

# ── 5x semantic labelling
print("Running 5x semantic validation pass...")
label_history = semantic_label_clusters_5x(vapor, cluster_ids)

# ── Infer composite objects
inferred = infer_objects(vapor)

# ── Describe
description = describe_image(vapor, inferred)
print(description)

# ── Optional transform
# transform_pixels(vapor, "invert")
# transform_pixels(vapor, "recolour_cluster", label="skin_region", r=255, g=200, b=150)

# ── Reconstruct
reconstruct_png(vapor, width, height, "output.png", step=step)

# ── Destroy
vapor.destroy()
```

## Output

Report the cluster count, label distribution, inferred objects with evidence
chains, and any transformation applied. Save the output PNG. Describe confidence:
how many of the 5 passes agreed on each label.
