# VAPOR-IDX DEVELOPER GUIDE
## Complete Reference for Image Reconstruction, Compositing, and Graph Analysis

**Version:** 2.0 — Covers bulk ops: update_where, relate_many, query_adjacent
**Install:** `pip install vapor-idx`

---

## PART 1: WHAT vapor-idx IS

vapor-idx is an **in-memory typed graph database for Python** with four index types,
BFS traversal, and snapshot/restore. It is not a neural network, CV library, or
rendering engine. It is a structured index that enables relationship-aware reasoning
over any data — pixels, 3D geometry, HTML elements, audio segments, code graphs, etc.

**It stores:**
- Typed records with named fields (string, number, boolean, string[], number[])
- Directed or undirected relationships between records
- Field indexes: exact (hash), keyword (inverted), prefix (trie), range (bisect)

**It provides:**
- O(1) exact lookups, O(log N) range queries
- BFS graph traversal with optional filtered predicates
- Shortest-path finding
- Snapshot/restore for multi-phase checkpointing

---

## PART 2: COMPLETE API REFERENCE

### 2.1 Installation and Import

```python
pip install vapor-idx

from vapor_idx import (
    create_vapor,
    QueryOptions, FieldFilter,
    TraversalOptions, TraversalResult, TraversalEntry,
    PathOptions,
    VaporError, VaporSchemaError, VaporQueryError,
)
```

### 2.2 Schema Definition

Every type must be declared before records of that type are stored.

```python
vapor = create_vapor({
    "types": {
        "Pixel": {
            "fields": {
                "x":         {"type": "number",  "index": "range"},
                "y":         {"type": "number",  "index": "range"},
                "r":         {"type": "number",  "index": "range"},
                "cluster":   {"type": "string",  "index": "exact"},
                "label":     {"type": "string",  "index": "keyword"},
                "is_edge":   {"type": "boolean", "index": "exact"},
                "tag":       {"type": "string",  "index": "prefix"},
                "scores":    {"type": "number[]","index": "none"},
            },
            "relationships": {
                "ADJACENT_TO": {
                    "targetTypes": ["Pixel"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
                "SAME_CLUSTER": {
                    "targetTypes": ["Cluster"],
                    "directed":    True,          # Pixel → Cluster
                    "cardinality": "many-to-one",
                },
            },
        },
        "Cluster": {
            "fields": {
                "cluster_id":    {"type": "string", "index": "exact"},
                "semantic_class":{"type": "string", "index": "keyword"},
                "size":          {"type": "number", "index": "range"},
            },
            "relationships": {
                "ADJACENT_TO": {"targetTypes":["Cluster"],"directed":False,"cardinality":"many-to-many"},
                "PART_OF":     {"targetTypes":["Cluster"],"directed":True, "cardinality":"many-to-one"},
                "CONTAINS":    {"targetTypes":["Cluster"],"directed":True, "cardinality":"one-to-many"},
            },
        },
    }
})
```

**Field types:** `"string"` | `"number"` | `"boolean"` | `"string[]"` | `"number[]"`

**Index strategies:**
| Strategy | Type | Supports | Performance |
|---|---|---|---|
| `"exact"` | string/number/boolean | eq, neq, in, notIn | O(1) |
| `"keyword"` | string | contains | O(tokens) |
| `"prefix"` | string | startsWith | O(prefix_len) |
| `"range"` | number/number[] | gt, lt, gte, lte | O(log N) |
| `"none"` | any | not queryable (stored only) | — |

**Cardinality:** `"one-to-one"` | `"one-to-many"` | `"many-to-many"`

### 2.3 Record CRUD

```python
# Store — returns record_id (string)
pid = vapor.store("Pixel", {
    "x": 10.0, "y": 20.0, "r": 128.0,
    "cluster": "", "label": "", "is_edge": False,
    "tag": "base", "scores": [0.1, 0.9],
})

# Get — returns VaporRecord | None
rec = vapor.get(pid)
if rec:
    print(rec.id, rec.type, rec.data["x"])

# Update (partial) — only listed keys change
vapor.update(pid, {"r": 255.0, "cluster": "c0001"})

# Delete — also removes all its relationships
vapor.delete(pid)

# Check existence
vapor.get(pid) is not None
```

**VaporRecord fields:**
```python
rec.id          # str
rec.type        # str (type_name from schema)
rec.data        # dict[str, Any] — full field data
rec._created_at # int (milliseconds epoch)
rec._updated_at # int (milliseconds epoch)
```

### 2.4 Relationships

```python
# Create relationship — returns edge_id (str)
edge_id = vapor.relate(pixel_id, "ADJACENT_TO", other_pixel_id)
edge_id = vapor.relate(pixel_id, "SAME_CLUSTER", cluster_id)

# Optional metadata on relationship
edge_id = vapor.relate(src_id, "CALLS", tgt_id, {"weight": 1.5})

# Remove single relationship
vapor.unrelate(edge_id)

# Get relationships — THE CRITICAL METHOD (not getRelationships!)
edges = vapor.get_relationships(record_id)                    # all
edges = vapor.get_relationships(record_id, "ADJACENT_TO")     # by type
edges = vapor.get_relationships(record_id, "ADJACENT_TO", "both")      # undirected
edges = vapor.get_relationships(record_id, "SAME_CLUSTER", "outgoing") # pixel→cluster
edges = vapor.get_relationships(record_id, "SAME_CLUSTER", "incoming") # cluster←pixels
```

**VaporRelationship fields:**
```python
e.id                # str
e.relationship_type # str
e.source_id         # str
e.target_id         # str
e.metadata          # dict
e._created_at       # int
```

**Neighbor IDs shortcut:**
```python
# Get neighbor record IDs without fetching relationships first
# (used in BFS loops)
edges = vapor.get_relationships(pid, "ADJACENT_TO", "both")
neighbor_ids = [
    e.target_id if e.source_id == pid else e.source_id
    for e in edges
]
```

### 2.5 Direction Rules — Complete Reference

This is the most common source of bugs. Commit this table to memory.

```
RELATIONSHIP        DIRECTED?  FROM PIXEL/CHILD:   FROM CLUSTER/PARENT:
─────────────────────────────────────────────────────────────────────────
ADJACENT_TO         No         "both"               "both"
SYMMETRICAL_WITH    No         "both"               "both"
CONNECTS (edge↔v)   No         "both"               "both"
BORDERS (edge↔face) No         "both"               "both"

SAME_CLUSTER        Yes(P→C)   "outgoing"           "incoming"
PART_OF             Yes(C→P)   "outgoing"           "incoming"
CONTAINS            Yes(P→C)   "outgoing"(parent)   "incoming"(child)
SPATIALLY_ABOVE     Yes(A→B)   "outgoing"=A above B "incoming"=above A
SPATIALLY_LEFT_OF   Yes(A→B)   "outgoing"=A left B  "incoming"=left of A
PARENT_OF (joint)   Yes        "outgoing"           "incoming"(find children)
CHILD_OF (joint)    Yes        "outgoing"           "incoming"
OWNS_PIXELS (j→c)   Yes        "outgoing"           "incoming"
PART_OF_FACE (v→f)  Yes        "outgoing"           "incoming"(face gets verts)
USES_MATERIAL (f→m) Yes        "outgoing"           "incoming"
FLOWS_BEFORE        Yes        "outgoing"           —
VISUALLY_ABOVE      Yes        "outgoing"           —
CONTAINS (html)     Yes        "outgoing"(parent)   "incoming"(child)
MOTION_ARTIFACT_OF  Yes        "outgoing"           "incoming"
```

### 2.6 Queries

```python
from vapor_idx import QueryOptions, FieldFilter

# Get all records of a type
result = vapor.query(QueryOptions(type="Pixel"))
result.records  # list[VaporRecord]
result.total    # int

# Single field filter
result = vapor.query(QueryOptions(
    type="Cluster",
    where=FieldFilter("semantic_class", "eq", "skin_region"),
))

# Multi-field filter (AND by default)
result = vapor.query(QueryOptions(
    type="Pixel",
    where=[
        FieldFilter("r", "gt", 130.0),
        FieldFilter("brightness", "lt", 200.0),
    ],
    logic="AND",  # or "OR"
))

# Range filter
result = vapor.query(QueryOptions(
    type="Cluster",
    where=FieldFilter("size", "gte", 100.0),
    order_by=("size", "desc"),
    limit=20,
    offset=0,
))

# Keyword search
result = vapor.query(QueryOptions(
    type="Cluster",
    keywords="skin frog",
))

# NOT in
result = vapor.query(QueryOptions(
    type="Cluster",
    where=FieldFilter("semantic_class", "notIn", ["background", "sky", "sand"]),
))
```

**Filter operators by index type:**
| Operator | Index Required | Value Type |
|---|---|---|
| `"eq"` | exact | any |
| `"neq"` | exact | any |
| `"in"` | exact | list |
| `"notIn"` | exact | list |
| `"contains"` | keyword | str |
| `"startsWith"` | prefix | str |
| `"gt"` | range | number |
| `"lt"` | range | number |
| `"gte"` | range | number |
| `"lte"` | range | number |

### 2.7 Traversal

```python
from vapor_idx import TraversalOptions, TraversalResult, TraversalEntry, PathOptions

# Basic BFS traversal
result = vapor.traverse(TraversalOptions(
    from_id=cluster_id,
    relationship="ADJACENT_TO",
    direction="both",   # undirected
    depth=3,
))
result.records  # list[VaporRecord] — all visited nodes
result.entries  # list[TraversalEntry] — nodes with depth and path info

# TraversalEntry fields:
entry.record   # VaporRecord
entry.depth    # int (1 = immediate neighbor)
entry.via      # list[str] — record IDs in the path from start

# FILTERED TRAVERSAL (most powerful — runs at index level):
result = vapor.traverse(TraversalOptions(
    from_id=body_cluster_id,
    relationship="SPATIALLY_ABOVE",
    direction="incoming",   # clusters that are ABOVE this one
    depth=10,
    filter=QueryOptions(
        type="Cluster",
        where=FieldFilter("semantic_class", "contains", "frog"),
    ),
))
# result.records = only frog clusters above body — no Python filtering needed

# Shortest path
path = vapor.find_path(PathOptions(
    from_id=start_id,
    to_id=end_id,
    relationship="ADJACENT_TO",  # None = any relationship
    max_depth=20,
))
# path = list of record IDs from start to end, or None if unreachable
```

### 2.8 NEW: Bulk Operations (v2.0)

```python
# ─── update_where ─── bulk conditional update ─────────────────────────────────
# Update all pixels in cluster "c0042" to red in ONE call
# Previously: 5000+ individual update() calls
updated_count = vapor.update_where(
    "Pixel",
    where={"cluster": "c0042"},
    data={"r": 200.0, "g": 50.0, "b": 50.0},
)
print(f"Updated {updated_count} pixels")

# Mark all background clusters
vapor.update_where(
    "Cluster",
    where={"semantic_class": "sky_region"},
    data={"is_background": True},
)

# ─── relate_many ─── batch relationship insertion ─────────────────────────────
# Build ADJACENT_TO for all pixel pairs in ONE call
# Previously: 120,000 individual relate() calls
edges = []
for y in range(0, H, step):
    for x in range(0, W, step):
        pid = grid.get((x, y))
        r   = grid.get((x+step, y))
        d   = grid.get((x, y+step))
        if pid and r: edges.append((pid, "ADJACENT_TO", r))
        if pid and d: edges.append((pid, "ADJACENT_TO", d))

created = vapor.relate_many(edges)
print(f"Created {created} ADJACENT_TO relationships")

# relate_many with metadata (same dict reused for all edges)
bone_edges = [
    (joint_a_id, "PARENT_OF", joint_b_id),
    (joint_b_id, "CHILD_OF",  joint_a_id),
]
vapor.relate_many(bone_edges, metadata={"type": "skeletal"})

# ─── query_adjacent ─── filtered neighbor query ───────────────────────────────
# Find all clusters adjacent to this one that are labeled "frog_body*"
frog_neighbors = vapor.query_adjacent(
    record_id=current_cluster_id,
    relationship_type="ADJACENT_TO",
    direction="both",
    where=FieldFilter("semantic_class", "contains", "frog"),
    type_name="Cluster",
)

# Find all pixels in cluster c0042 (replaces get_relationships + loop)
pixels_in_cluster = vapor.query_adjacent(
    record_id=cluster_record_id,
    relationship_type="SAME_CLUSTER",
    direction="incoming",  # cluster ← pixels
    type_name="Pixel",
)
```

### 2.9 Snapshot and Restore

```python
# Checkpoint after heavy analysis phase
snap = vapor.snapshot()

# If reconstruction fails, restore to last good state
try:
    # ... complex operation ...
    pass
except Exception as e:
    print(f"Failed: {e} — restoring")
    vapor_restored = vapor.restore(snap)
    # vapor_restored is a NEW VaporInstance — vapor is still the old one

# Note: restore() creates a new instance with schema-validated copies of all records.
# The original instance is unchanged.
```

### 2.10 Stats and Lifecycle

```python
# Stats
s = vapor.stats()
s.total_records         # int
s.records_by_type       # dict[str, int]
s.total_relationships   # int
s.relationships_by_type # dict[str, int]
s.index_stats.exact_entries
s.index_stats.keyword_tokens
s.index_stats.prefix_nodes
s.index_stats.range_entries
s.memory_estimate_bytes # approximate

# Lifecycle
vapor.is_destroyed  # bool
vapor.destroy()     # frees memory; instance unusable after
```

---

## PART 3: PERFORMANCE GUIDE

### 3.1 Step Sampling for Large Images

Never index every pixel of a large image. Use step=2 or step=3:

```python
step = 1 if max(W, H) <= 200 else (2 if max(W, H) <= 500 else 3)

for y in range(0, H, step):
    for x in range(0, W, step):
        pid = vapor.store("Pixel", {...})
        grid[(x,y)] = pid
```

Step=2 reduces pixels by 75% (from W×H to W/2×H/2), reducing all subsequent
relationship counts by the same factor.

**Keep the same step across all images you will composite together.**

### 3.2 relate_many vs relate in loops

```python
# SLOW (N=120,000 relate() calls for a 500×300 image at step=2):
for y in range(0, H, step):
    for x in range(0, W, step):
        if (x+step,y) in grid: vapor.relate(grid[(x,y)], "ADJACENT_TO", grid[(x+step,y)])
        if (x,y+step) in grid: vapor.relate(grid[(x,y)], "ADJACENT_TO", grid[(x,y+step)])

# FAST (1 relate_many call):
edges = []
for y in range(0, H, step):
    for x in range(0, W, step):
        pid = grid.get((x,y))
        if not pid: continue
        r = grid.get((x+step,y)); d = grid.get((x,y+step))
        if r: edges.append((pid,"ADJACENT_TO",r))
        if d: edges.append((pid,"ADJACENT_TO",d))
vapor.relate_many(edges)
```

### 3.3 update_where vs update in loops

```python
# SLOW (5000 update() calls to recolor a cluster):
pixels = vapor.query(QueryOptions(type="Pixel",
    where=FieldFilter("cluster","eq","c0042"))).records
for rec in pixels:
    vapor.update(rec.id, {"r": 200.0, "g": 50.0, "b": 50.0})

# FAST (1 update_where call):
vapor.update_where("Pixel", {"cluster":"c0042"}, {"r":200.0,"g":50.0,"b":50.0})
```

### 3.4 Filtered Traversal vs BFS + Filter

```python
# SLOW (BFS returns everything, Python filters):
result = vapor.traverse(TraversalOptions(from_id=cid, relationship="SPATIALLY_ABOVE",
                                          direction="incoming", depth=10))
frog_above = [r for r in result.records
              if "frog" in r.data.get("semantic_class","")]

# FAST (filter runs at index level inside traverse):
result = vapor.traverse(TraversalOptions(
    from_id=cid, relationship="SPATIALLY_ABOVE",
    direction="incoming", depth=10,
    filter=QueryOptions(type="Cluster",
                        where=FieldFilter("semantic_class","contains","frog"))
))
frog_above = result.records  # already filtered
```

### 3.5 Typical Timing Reference

| Image Size | Step | Pixels | Phase 1 (index) | Phase 3 (clusters) | Total Pipeline |
|---|---|---|---|---|---|
| 150×150 | 1 | 22,500 | ~1.2s | ~1.8s | ~6s |
| 300×400 | 2 | 22,500 | ~1.2s | ~1.8s | ~6s |
| 500×600 | 2 | 56,250 | ~2.8s | ~4.5s | ~14s |
| 800×600 | 3 | 53,400 | ~2.6s | ~4.2s | ~13s |
| 1200×900 | 4 | 67,500 | ~3.3s | ~5.4s | ~16s |

---

## PART 4: COMMON PATTERNS

### 4.1 Get All Pixels in a Cluster

```python
# Method A: query_adjacent (v2.0, fastest)
pixels = vapor.query_adjacent(cluster_record_id, "SAME_CLUSTER", "incoming")

# Method B: query by field (works on v1.0)
pixels = vapor.query(QueryOptions(type="Pixel",
    where=FieldFilter("cluster","eq",cluster_id)))

# Method C: traverse from cluster (works on v1.0, slower)
# — use Method B or A instead
```

### 4.2 Get Adjacent Clusters of Same Type

```python
# Find all frog-body clusters adjacent to this cluster
adj = vapor.query_adjacent(
    cluster_record_id, "ADJACENT_TO", "both",
    where=FieldFilter("semantic_class","contains","frog"),
    type_name="Cluster",
)

# Alternative without query_adjacent:
adj_edges = vapor.get_relationships(cluster_record_id, "ADJACENT_TO", "both")
adj_frog = []
for e in adj_edges:
    nid = e.target_id if e.source_id==cluster_record_id else e.source_id
    nr = vapor.get(nid)
    if nr and "frog" in nr.data.get("semantic_class",""):
        adj_frog.append(nr)
```

### 4.3 BFS Flood Fill (Core Pattern)

```python
from collections import deque

def flood_fill(vapor, start_pid, color_tolerance=40.0):
    seed = vapor.get(start_pid)
    if not seed: return []
    visited = {start_pid}
    result  = []
    queue   = deque([start_pid])

    while queue:
        cur = queue.popleft()
        cr  = vapor.get(cur)
        if not cr: continue
        result.append(cur)

        # ADJACENT_TO is undirected — always "both"
        for e in vapor.get_relationships(cur, "ADJACENT_TO", "both"):
            nid = e.target_id if e.source_id==cur else e.source_id
            if nid in visited: continue
            nr = vapor.get(nid)
            if not nr: continue
            dist = ((seed.data["r"]-nr.data["r"])**2 +
                    (seed.data["g"]-nr.data["g"])**2 +
                    (seed.data["b"]-nr.data["b"])**2)**0.5
            if dist <= color_tolerance:
                visited.add(nid)
                queue.append(nid)

    return result
```

### 4.4 Find Dominant Label in Cluster Set

```python
from collections import Counter

all_clusters = vapor.query(QueryOptions(type="Cluster")).records
label_counts = Counter(r.data.get("semantic_class","?") for r in all_clusters)
top_label, top_count = label_counts.most_common(1)[0]
```

### 4.5 Build Spatial Index (Object Lookup by Position)

```python
# After indexing pixels, find the pixel at a specific position
def get_pixel_at(vapor, x, y, step=2):
    # Snap to step grid
    sx = (x // step) * step
    sy = (y // step) * step
    result = vapor.query(QueryOptions(type="Pixel", where=[
        FieldFilter("x","gte",float(sx)), FieldFilter("x","lte",float(sx)),
        FieldFilter("y","gte",float(sy)), FieldFilter("y","lte",float(sy)),
    ]))
    return result.records[0] if result.records else None
```

### 4.6 Snapshot Checkpoint Pattern

```python
# Long pipeline: checkpoint between expensive phases
grid, _ = index_pixels(vapor, W, H, pixels, step=2)  # Phase 1

snap_phase1 = vapor.snapshot()  # Save after indexing

compute_sobel_edges(vapor, grid, W, H, step=2)  # Phase 2
cluster_ids, _ = detect_clusters(vapor, grid, W, H)  # Phase 3

snap_phase3 = vapor.snapshot()  # Save after clustering

try:
    build_cluster_relationships(vapor, cluster_ids)  # Phase 4
    semantic_label_clusters_5x(vapor, cluster_ids)   # Phase 5
    snap_phase5 = vapor.snapshot()
except Exception as e:
    print(f"Phase 4/5 failed: {e}")
    vapor2 = vapor.restore(snap_phase3)  # Back to clusters
    # Try alternative path...
```

### 4.7 Multiple Vapor Instances for Compositing

```python
# Pattern: one vapor instance per image — destroy when done with that image

# Instance 1: Subject image
v_subj = make_vapor_schema()
# ... process subject ...
subj_mask = isolate_foreground_halosafe(v_subj, ...)
v_subj.destroy()  # Free memory before processing background

# Instance 2: Background image
v_bg = make_vapor_schema(include_scene=True)
# ... process background ...
scene_props = extract_scene_lighting(v_bg, ...)
v_bg.destroy()

# Now composite without any vapor instance (pure Python pixel ops)
canvas = [[...]]
paint_mask_onto_canvas(canvas, subj_mask, ...)
```

---

## PART 5: SCHEMA DESIGN GUIDE

### 5.1 Index Strategy Selection

Choose based on the queries you will run:

```python
# Use "exact" when you query with == or "in":
"cluster":      {"type": "string",  "index": "exact"}   # filter by cluster ID
"is_edge":      {"type": "boolean", "index": "exact"}   # filter True/False
"mat_idx":      {"type": "number",  "index": "exact"}   # filter by material index

# Use "keyword" when you query with "contains":
"semantic_class": {"type": "string", "index": "keyword"} # "contains": "skin"
"label":          {"type": "string", "index": "keyword"}
"text":           {"type": "string", "index": "keyword"}

# Use "prefix" when you query with "startsWith":
"tag":  {"type": "string", "index": "prefix"}  # startsWith "skin_"

# Use "range" when you query with >, <, >=, <=:
"x":          {"type": "number", "index": "range"}
"brightness": {"type": "number", "index": "range"}
"size":       {"type": "number", "index": "range"}

# Use "none" for fields you store but never query:
"normal_x":  {"type": "number", "index": "none"}  # stored, not queried
"raw_bytes": {"type": "string", "index": "none"}
```

### 5.2 Relationship Direction Design

```python
# RULE: direction = who "owns" or "initiates" the relationship

# Pixel initiates belonging to cluster: directed pixel→cluster
"SAME_CLUSTER": {"directed": True}   # pixel → cluster
# → query from pixel: "outgoing" to get cluster
# → query from cluster: "incoming" to get all pixels

# Parent contains child: directed parent→child
"CONTAINS": {"directed": True}   # parent → child
# → query from parent: "outgoing" to get children
# → query from child: "incoming" to find parent

# Spatial position is symmetric: undirected
"ADJACENT_TO": {"directed": False}  # both ways always
"SYMMETRICAL_WITH": {"directed": False}

# Bone connects two joints, but has direction (from→to)
"FROM_JOINT": {"directed": True}  # bone → proximal joint
"TO_JOINT":   {"directed": True}  # bone → distal joint
```

### 5.3 Extending the Schema for New Types

```python
# Add skeleton types to the pixel-analyzer schema
def make_vapor_schema(include_skeleton=False):
    types = { ... }  # base types

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
                "PARENT_OF":   {"targetTypes":["Joint"],  "directed":True, "cardinality":"one-to-many"},
                "CHILD_OF":    {"targetTypes":["Joint"],  "directed":True, "cardinality":"many-to-one"},
                "OWNS_PIXELS": {"targetTypes":["Cluster"],"directed":True, "cardinality":"one-to-many"},
            },
        }

    return create_vapor({"types": types})
```

---

## PART 6: ERROR REFERENCE

| Error | Cause | Fix |
|---|---|---|
| `AttributeError: 'VaporInstance' has no attribute 'getRelationships'` | Called camelCase version | Use `vapor.get_relationships()` |
| `VaporSchemaError: Relationship "X" not declared on type "Y"` | Trying to relate with undeclared relationship | Add relationship to schema |
| `VaporSchemaError: Relationship "X" does not allow target type "Y"` | Wrong target type | Check `targetTypes` in schema |
| `VaporError: Source record "X" does not exist` | relate() with non-existent ID | Check store() returned a valid ID |
| `VaporError: Cardinality violation` | one-to-one or one-to-many constraint broken | Change cardinality or restructure |
| `VaporQueryError: Operator "gt" requires index "range"` | Querying non-range field with range op | Change field index to "range" |
| `VaporQueryError: Query references field "X" not declared` | Field name typo in FieldFilter | Check field name matches schema |
| `VaporDestroyedError` | Called method after destroy() | Create a new instance |
| `VaporError: Unknown type "X"` | store() with undeclared type | Declare in schema dict |

---

## PART 7: QUICK REFERENCE CHEATSHEET

```python
# ═══ Create ════════════════════════════════════════════════════════════
vapor = create_vapor({"types": {...}})

# ═══ Store / Get / Update / Delete ════════════════════════════════════
rid = vapor.store("Type", {"field": value})
rec = vapor.get(rid)           # VaporRecord | None
vapor.update(rid, {"f": v})   # partial update
vapor.delete(rid)              # also removes relationships

# ═══ Bulk (v2.0) ═══════════════════════════════════════════════════════
n = vapor.update_where("Type", {"field": "val"}, {"f2": v2})
n = vapor.relate_many([(src,rel,tgt), ...])
r = vapor.query_adjacent(rid, "REL", "both", where=FieldFilter(...))

# ═══ Relationships ══════════════════════════════════════════════════════
eid = vapor.relate(src, "REL", tgt)
vapor.unrelate(eid)
edges = vapor.get_relationships(rid, "REL", "both"|"outgoing"|"incoming")
# neighbor shortcut:
nids = [e.target_id if e.source_id==rid else e.source_id for e in edges]

# ═══ Query ═════════════════════════════════════════════════════════════
r = vapor.query(QueryOptions(type="T", where=FieldFilter("f","op",v),
                              order_by=("f","desc"), limit=20))
r.records  # list[VaporRecord]
r.total    # int

# ═══ Traversal ══════════════════════════════════════════════════════════
r = vapor.traverse(TraversalOptions(from_id=rid, relationship="REL",
                   direction="both", depth=5,
                   filter=QueryOptions(type="T", where=FieldFilter(...))))
path = vapor.find_path(PathOptions(from_id=a, to_id=b, max_depth=10))

# ═══ Lifecycle ══════════════════════════════════════════════════════════
snap = vapor.snapshot()
v2   = vapor.restore(snap)  # new instance
s    = vapor.stats()        # VaporStats
vapor.destroy()             # free memory
```
