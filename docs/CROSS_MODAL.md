# vapor-idx — Cross-Modal Reconstruction Guide

## The concept

Cross-modal reconstruction is the process of taking data indexed in one modality
and emitting it in another. vapor-idx is the bridge — the indexed structure holds
the information, Claude traverses it and drives the reconstruction.

Examples:
- **Pixels → SVG**: Index image pixels, detect regions via traversal, emit vector shapes
- **3D mesh → Blender Python**: Index OBJ vertices/faces, traverse topology, emit bpy script
- **HTML DOM → CSS layout**: Index elements with position/style, emit clean CSS
- **Audio frames → MIDI**: Index waveform segments, detect pitches, emit MIDI events
- **Code graph → Documentation**: Index functions/relationships, emit structured docs

---

## The pattern

Every cross-modal reconstruction follows the same three steps:

1. **Decompose** — parse the source modality into typed records and store them in
   vapor-idx. Apply appropriate index strategies for the source modality's query
   patterns.

2. **Traverse** — use vapor-idx's query and traversal engines to explore the
   indexed structure. Claude applies its own semantic reasoning to interpret what
   the traversal returns.

3. **Reconstruct** — emit the target modality from the traversal results. The
   output is constructed by the skill from the indexed data, not by any ML model.

---

## Pattern 1: SVG → pixel index → modified PNG

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter

# Step 1: Decompose an SVG into elements
vapor = create_vapor({
    "types": {
        "Element": {
            "fields": {
                "tagName":    {"type": "string", "index": "exact"},
                "id":         {"type": "string", "index": "exact"},
                "className":  {"type": "string", "index": "keyword"},
                "x":          {"type": "number", "index": "range"},
                "y":          {"type": "number", "index": "range"},
                "width":      {"type": "number", "index": "range"},
                "height":     {"type": "number", "index": "range"},
                "fillHex":    {"type": "string", "index": "exact"},
                "strokeHex":  {"type": "string", "index": "exact"},
                "opacity":    {"type": "number", "index": "range"},
                "zIndex":     {"type": "number", "index": "range"},
            },
            "relationships": {
                "CONTAINS": {
                    "targetTypes": ["Element"],
                    "directed":    True,
                    "cardinality": "one-to-many",
                },
                "ADJACENT_TO": {
                    "targetTypes": ["Element"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
            },
        },
    },
})
```

### Decompose SVG elements

```python
import xml.etree.ElementTree as ET

def index_svg(vapor, svg_text: str) -> dict[str, str]:
    """Index SVG elements into vapor. Returns element_id → vapor_id."""
    root   = ET.fromstring(svg_text)
    id_map: dict[str, str] = {}

    def index_element(el, parent_vapor_id: str | None, z: int):
        tag  = el.tag.split('}')[-1]  # strip namespace
        data = {
            'tagName':   tag,
            'id':        el.get('id', ''),
            'className': el.get('class', ''),
            'x':         float(el.get('x', 0)),
            'y':         float(el.get('y', 0)),
            'width':     float(el.get('width', 0)),
            'height':    float(el.get('height', 0)),
            'fillHex':   el.get('fill', '#000000'),
            'strokeHex': el.get('stroke', 'none'),
            'opacity':   float(el.get('opacity', 1.0)),
            'zIndex':    z,
        }
        vid = vapor.store('Element', data)
        elem_id = el.get('id', f'{tag}_{z}')
        id_map[elem_id] = vid

        if parent_vapor_id:
            vapor.relate(parent_vapor_id, 'CONTAINS', vid)

        for i, child in enumerate(el):
            index_element(child, vid, z + 1 + i)

    for i, child in enumerate(root):
        index_element(child, None, i)

    return id_map

id_map = index_svg(vapor, open("design.svg").read())
```

### Reconstruct as CSS layout

```python
def reconstruct_css(vapor) -> str:
    """Emit a CSS layout from the indexed SVG elements."""
    from vapor_idx import QueryOptions
    
    lines = [
        "/* Reconstructed layout from vapor-idx */",
        ".container { position: relative; }",
    ]

    elements = vapor.query(QueryOptions(
        type='Element',
        order_by=('zIndex', 'asc'),
    ))

    for rec in elements.records:
        d = rec.data
        eid = d.get('id') or f"el_{rec.id[:8]}"
        lines.append(f"""
#{eid} {{
  position: absolute;
  left: {d.get('x', 0)}px;
  top: {d.get('y', 0)}px;
  width: {d.get('width', 0)}px;
  height: {d.get('height', 0)}px;
  background-color: {d.get('fillHex', 'transparent')};
  border: {'1px solid ' + d.get('strokeHex', 'none') if d.get('strokeHex', 'none') != 'none' else 'none'};
  opacity: {d.get('opacity', 1.0)};
  z-index: {d.get('zIndex', 0)};
}}""")

    return '\n'.join(lines)
```

---

## Pattern 2: Pixel index → reconstructed PNG with transformations

```python
def transform_and_reconstruct(vapor, width: int, height: int) -> bytes:
    """
    Apply a colour transformation to all pixels in the index,
    then reconstruct and return PNG bytes.
    """
    import struct, zlib
    from vapor_idx import QueryOptions

    # Apply transformation: invert colours
    all_pixels = vapor.query(QueryOptions(type='Pixel'))
    for rec in all_pixels.records:
        d = rec.data
        vapor.update(rec.id, {
            'r': 255 - int(d['r']),
            'g': 255 - int(d['g']),
            'b': 255 - int(d['b']),
        })

    # Reconstruct pixel buffer
    buffer = bytearray(width * height * 3)
    all_pixels = vapor.query(QueryOptions(type='Pixel'))
    for rec in all_pixels.records:
        d = rec.data
        x, y = int(d['x']), int(d['y'])
        offset = (y * width + x) * 3
        buffer[offset]     = int(d['r'])
        buffer[offset + 1] = int(d['g'])
        buffer[offset + 2] = int(d['b'])

    # Emit minimal PNG (pure Python, no Pillow needed)
    def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data)
        return struct.pack('>I', len(data)) + chunk_type + data + struct.pack('>I', crc)

    png_signature = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    ihdr = png_chunk(b'IHDR', ihdr_data)

    # Scanlines with filter byte 0 (None)
    scanlines = b''
    for y in range(height):
        row = bytes([0]) + bytes(buffer[y * width * 3: (y + 1) * width * 3])
        scanlines += row

    idat = png_chunk(b'IDAT', zlib.compress(scanlines))
    iend = png_chunk(b'IEND', b'')

    return png_signature + ihdr + idat + iend
```

---

## Pattern 3: 3D index → Blender scene reconstruction

See [3D_INDEXING.md](3D_INDEXING.md) for the full OBJ → vapor → Blender Python
pipeline. The general pattern:

```python
# Decompose
obj_data = open("model.obj").read()
ids = index_obj(vapor, obj_data)

# Traverse (Claude applies semantic reasoning here)
# e.g. find all isolated vertex clusters → separate objects
# e.g. find high-curvature regions → mark as edge loops
# e.g. find faces with metallic materials → separate mesh

# Reconstruct
blender_script = reconstruct_as_blender_python(vapor, mesh_name="MyMesh")
open("reconstruct.py", "w").write(blender_script)
# Run: blender --background --python reconstruct.py
```

---

## Pattern 4: Audio waveform → MIDI

```python
# Audio schema: index waveform amplitude peaks as note events
vapor = create_vapor({
    "types": {
        "Frame": {
            "fields": {
                "timeMs":     {"type": "number", "index": "range"},
                "amplitude":  {"type": "number", "index": "range"},
                "freqHz":     {"type": "number", "index": "range"},
                "noteLabel":  {"type": "string", "index": "exact"},
                "isOnset":    {"type": "boolean","index": "exact"},
            },
            "relationships": {
                "PRECEDES":  {"targetTypes": ["Frame"], "directed": True,  "cardinality": "one-to-one"},
                "SAME_NOTE": {"targetTypes": ["Frame"], "directed": False, "cardinality": "many-to-many"},
            },
        },
    },
})

# After indexing frames and detecting note events:
def reconstruct_midi_events(vapor) -> list[dict]:
    """Extract MIDI note events from the indexed audio frames."""
    from vapor_idx import QueryOptions, FieldFilter
    
    onset_frames = vapor.query(QueryOptions(
        type='Frame',
        where=FieldFilter(field='isOnset', op='eq', value=True),
        order_by=('timeMs', 'asc'),
    ))

    events = []
    for rec in onset_frames.records:
        events.append({
            'time_ms':   rec.data['timeMs'],
            'freq_hz':   rec.data['freqHz'],
            'note':      rec.data['noteLabel'],
            'amplitude': rec.data['amplitude'],
            'velocity':  min(127, int(rec.data['amplitude'] * 127)),
        })
    return events
```

---

## Pattern 5: Code graph → documentation

```typescript
// After indexing a codebase with Function, Class, Module types:
function reconstructMarkdownDocs(vapor: ReturnType<typeof createVapor>): string {
  const modules = vapor.query({ type: 'Module', orderBy: { field: 'path', direction: 'asc' } });
  const lines: string[] = ['# API Documentation\n'];

  for (const mod of modules.records) {
    const { path, language } = mod.data as any;
    lines.push(`## ${path}\n`);

    // Find all functions defined in this module
    const fns = vapor.query({
      type:  'Function',
      where: { field: 'filePath', op: 'eq', value: path },
      orderBy: { field: 'lineStart', direction: 'asc' },
    });

    for (const fn of fns.records) {
      const { name, docstring, isAsync, visibility, lineStart, lineEnd } = fn.data as any;
      lines.push(`### \`${isAsync ? 'async ' : ''}${name}\``);
      lines.push(`*Lines ${lineStart}–${lineEnd} · ${visibility}*\n`);
      if (docstring) lines.push(`${docstring}\n`);

      // Find what this function calls
      const calls = vapor.getRelationships(fn.id, 'CALLS', 'outgoing');
      if (calls.length > 0) {
        const callNames = calls
          .map(e => vapor.get(e.targetId))
          .filter(Boolean)
          .map(r => (r!.data as any).name);
        lines.push(`**Calls:** ${callNames.join(', ')}\n`);
      }
    }
  }

  return lines.join('\n');
}
```

---

## Cross-modal link tracking

When a reconstruction produces references between modalities, store them in the
index as explicit cross-modal relationships:

```typescript
const vapor = createVapor({
  types: {
    PixelRegion: { fields: { label: { type: 'string', index: 'keyword' }, area: { type: 'number', index: 'range' } }, relationships: {} },
    SVGShape:    { fields: { tag: { type: 'string', index: 'exact' }, fill: { type: 'string', index: 'exact' } }, relationships: {
      DERIVED_FROM: { targetTypes: ['PixelRegion'], directed: true, cardinality: 'many-to-one' },
    }},
  },
});

const regionId = vapor.store('PixelRegion', { label: 'sky', area: 15000 });
const shapeId  = vapor.store('SVGShape',    { tag: 'ellipse', fill: '#87CEEB' });

// Record the cross-modal derivation
vapor.relate(shapeId, 'DERIVED_FROM', regionId, {
  confidence: 'high',
  method: 'flood-fill-region-detection',
});

// Later: find all SVG shapes derived from large pixel regions
const largeRegionShapes = vapor.query({
  type: 'PixelRegion',
  where: { field: 'area', op: 'gt', value: 10000 },
});
```

---

## Snapshot for cross-modal checkpointing

```python
# After decomposing source modality — checkpoint
snap_after_decompose = vapor.snapshot()

# After traversal and analysis — checkpoint
snap_after_analysis = vapor.snapshot()

# If reconstruction fails or produces wrong output:
# Restore to post-analysis state and try different reconstruction strategy
vapor2 = vapor.restore(snap_after_analysis)
result2 = reconstruct_with_different_strategy(vapor2)
```

Cross-modal snapshots let you checkpoint between decompose, traverse, and
reconstruct phases without re-parsing the source data.
