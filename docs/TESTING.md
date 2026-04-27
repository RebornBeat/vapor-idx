# vapor-idx — Testing Guide

This guide covers how to deploy, build, and fully test all three packages and
all four skills. Follow sections in order for each runtime.

---

## Prerequisites

| Tool        | Version    | Install                          |
|-------------|------------|----------------------------------|
| Node.js     | ≥ 18       | https://nodejs.org               |
| TypeScript  | ≥ 5.1      | `npm install -g typescript`      |
| Python      | ≥ 3.10     | https://python.org               |
| Rust        | ≥ 1.75     | https://rustup.rs                |
| Cargo       | ≥ 1.75     | (bundled with Rust)              |

---

## Part 1 — TypeScript package

### 1.1 Build

```bash
cd packages/vapor-idx
npm install
npx tsc -p tsconfig.json
```

Expected: `dist/` folder created with `.js`, `.d.ts`, and `.js.map` files.

### 1.2 Smoke test (manual)

Create `smoke.mjs` in the package root:

```js
import { createVapor } from './dist/index.js';

const vapor = createVapor({
  types: {
    Task: {
      fields: {
        title:    { type: 'string',  index: 'keyword' },
        priority: { type: 'number',  index: 'range'   },
        status:   { type: 'string',  index: 'exact'   },
      },
      relationships: {
        BLOCKS: { targetTypes: ['Task'], directed: true, cardinality: 'many-to-many' },
      },
    },
  },
});

const id1 = vapor.store('Task', { title: 'Write tests', priority: 1, status: 'open' });
const id2 = vapor.store('Task', { title: 'Deploy package', priority: 2, status: 'open' });
vapor.relate(id2, 'BLOCKS', id1);

const urgent = vapor.query({ type: 'Task', where: { field: 'priority', op: 'lte', value: 1 } });
console.assert(urgent.total === 1, 'Expected 1 urgent task');

const search = vapor.query({ type: 'Task', keywords: 'tests' });
console.assert(search.total === 1, 'Expected 1 keyword match');

const blockers = vapor.traverse({ from: id2, relationship: 'BLOCKS', depth: 1 });
console.assert(blockers.records.length === 1, 'Expected 1 blocked task');

const snap = vapor.snapshot();
const fork = vapor.restore(snap);
console.assert(fork.stats().totalRecords === 2, 'Snapshot restored 2 records');

vapor.destroy();
fork.destroy();
console.log('TypeScript smoke test PASSED');
```

```bash
node smoke.mjs
```

Expected: `TypeScript smoke test PASSED`

### 1.3 Pixel indexing test

```js
// pixel_test.mjs
import { createVapor } from './dist/index.js';

const vapor = createVapor({
  types: {
    Pixel: {
      fields: {
        x:          { type: 'number', index: 'range' },
        y:          { type: 'number', index: 'range' },
        r:          { type: 'number', index: 'range' },
        g:          { type: 'number', index: 'range' },
        b:          { type: 'number', index: 'range' },
        brightness: { type: 'number', index: 'range' },
      },
      relationships: {
        ADJACENT_TO: { targetTypes: ['Pixel'], directed: false, cardinality: 'many-to-many' },
      },
    },
  },
});

// Index a tiny 3x3 image
const pixels = [];
for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 3; x++) {
    const r = x * 80, g = y * 80, b = 100;
    const id = vapor.store('Pixel', { x, y, r, g, b, brightness: (r + g + b) / 3 });
    pixels.push(id);
  }
}

// Build adjacency
for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 3; x++) {
    const id = pixels[y * 3 + x];
    if (x + 1 < 3) vapor.relate(id, 'ADJACENT_TO', pixels[y * 3 + x + 1]);
    if (y + 1 < 3) vapor.relate(id, 'ADJACENT_TO', pixels[(y + 1) * 3 + x]);
  }
}

// Negative range query — CRITICAL TEST
const dark = vapor.query({ type: 'Pixel', where: { field: 'brightness', op: 'lt', value: 120 } });
console.assert(dark.total > 0, 'Should find dark pixels');

// Spatial query
const leftCol = vapor.query({ type: 'Pixel', where: { field: 'x', op: 'eq', value: 0 } });
console.assert(leftCol.total === 3, 'Left column should have 3 pixels');

// Traversal
const neighbours = vapor.traverse({ from: pixels[4], relationship: 'ADJACENT_TO', direction: 'both', depth: 1 });
console.assert(neighbours.records.length === 4, 'Centre pixel should have 4 neighbours');

vapor.destroy();
console.log('Pixel indexing test PASSED');
```

```bash
node pixel_test.mjs
```

### 1.4 Negative number range test

This specifically validates the TypeScript range index handles negatives correctly:

```js
// negative_test.mjs
import { createVapor } from './dist/index.js';

const vapor = createVapor({
  types: {
    Point: {
      fields: {
        x: { type: 'number', index: 'range' },
        y: { type: 'number', index: 'range' },
      },
      relationships: {},
    },
  },
});

vapor.store('Point', { x: -10, y: -5  });
vapor.store('Point', { x:  -1, y:  0  });
vapor.store('Point', { x:   0, y:  3  });
vapor.store('Point', { x:   5, y: 10  });

const negative_x = vapor.query({ type: 'Point', where: { field: 'x', op: 'lt', value: 0 } });
console.assert(negative_x.total === 2, `Expected 2 negative-x points, got ${negative_x.total}`);

const gt_neg2 = vapor.query({ type: 'Point', where: { field: 'x', op: 'gt', value: -2 } });
console.assert(gt_neg2.total === 3, `Expected 3 points with x > -2, got ${gt_neg2.total}`);

vapor.destroy();
console.log('Negative range test PASSED');
```

---

## Part 2 — Python package

### 2.1 Install

```bash
cd packages/vapor-idx-py
pip install -e . --break-system-packages
# or in a venv:
python -m venv .venv && source .venv/bin/activate
pip install -e .
```

### 2.2 Smoke test

```bash
python - <<'EOF'
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions, PathOptions

vapor = create_vapor({
    "types": {
        "Task": {
            "fields": {
                "title":    {"type": "string",  "index": "keyword"},
                "priority": {"type": "number",  "index": "range"},
                "status":   {"type": "string",  "index": "exact"},
            },
            "relationships": {
                "BLOCKS": {"targetTypes": ["Task"], "directed": True, "cardinality": "many-to-many"},
            },
        },
    },
})

id1 = vapor.store("Task", {"title": "Write tests",   "priority": 1, "status": "open"})
id2 = vapor.store("Task", {"title": "Deploy package","priority": 2, "status": "open"})
vapor.relate(id2, "BLOCKS", id1)

urgent = vapor.query(QueryOptions(type="Task", where=FieldFilter(field="priority", op="lte", value=1)))
assert urgent.total == 1, f"Expected 1, got {urgent.total}"

search = vapor.query(QueryOptions(type="Task", keywords="tests"))
assert search.total == 1, f"Expected 1, got {search.total}"

blockers = vapor.traverse(TraversalOptions(from_id=id2, relationship="BLOCKS", depth=1))
assert len(blockers.records) == 1, f"Expected 1 blocked task"

snap = vapor.snapshot()
fork = vapor.restore(snap)
assert fork.stats().total_records == 2, "Snapshot restore failed"

vapor.destroy()
fork.destroy()
print("Python smoke test PASSED")
EOF
```

### 2.3 Negative range test

```bash
python - <<'EOF'
from vapor_idx import create_vapor, QueryOptions, FieldFilter

vapor = create_vapor({
    "types": {
        "Point": {
            "fields": {
                "x": {"type": "number", "index": "range"},
                "y": {"type": "number", "index": "range"},
            },
            "relationships": {},
        },
    },
})

vapor.store("Point", {"x": -10, "y": -5})
vapor.store("Point", {"x":  -1, "y":  0})
vapor.store("Point", {"x":   0, "y":  3})
vapor.store("Point", {"x":   5, "y": 10})

neg = vapor.query(QueryOptions(type="Point", where=FieldFilter(field="x", op="lt", value=0)))
assert neg.total == 2, f"Expected 2 negative-x points, got {neg.total}"

gt_neg2 = vapor.query(QueryOptions(type="Point", where=FieldFilter(field="x", op="gt", value=-2)))
assert gt_neg2.total == 3, f"Expected 3 points with x > -2, got {gt_neg2.total}"

vapor.destroy()
print("Python negative range test PASSED")
EOF
```

### 2.4 Pixel indexing test (Python)

```bash
python - <<'EOF'
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
            },
            "relationships": {
                "ADJACENT_TO": {"targetTypes":["Pixel"],"directed":False,"cardinality":"many-to-many"},
            },
        },
    },
})

grid = {}
for y in range(4):
    for x in range(4):
        r = x * 60; g = y * 60; b = 100
        pid = vapor.store("Pixel", {"x":x,"y":y,"r":r,"g":g,"b":b,"brightness":(r+g+b)/3})
        grid[(x,y)] = pid

for y in range(4):
    for x in range(4):
        if x+1<4: vapor.relate(grid[(x,y)],"ADJACENT_TO",grid[(x+1,y)])
        if y+1<4: vapor.relate(grid[(x,y)],"ADJACENT_TO",grid[(x,y+1)])

dark = vapor.query(QueryOptions(type="Pixel", where=FieldFilter(field="brightness",op="lt",value=100)))
assert dark.total > 0, "Should find dark pixels"

left_col = vapor.query(QueryOptions(type="Pixel", where=FieldFilter(field="x",op="eq",value=0)))
assert left_col.total == 4, f"Expected 4, got {left_col.total}"

centre = vapor.traverse(TraversalOptions(from_id=grid[(1,1)],relationship="ADJACENT_TO",direction="both",depth=1))
assert len(centre.records) == 4, f"Expected 4 neighbours, got {len(centre.records)}"

vapor.destroy()
print("Python pixel test PASSED")
EOF
```

---

## Part 3 — Rust package

### 3.1 Build

```bash
cd packages/vapor-idx-rs
cargo build
```

Expected: `Finished dev` with no errors.

### 3.2 Run built-in tests

The `range.rs` module includes unit tests for the negative float ordering fix:

```bash
cargo test
```

Expected output (approximately):

```
running 2 tests
test indexes::range::tests::test_negative_float_ordering ... ok
test indexes::range::tests::test_gt_with_negatives ... ok
test indexes::range::tests::test_lte_with_negatives ... ok
test result: ok. 3 passed; 0 failed; 0 ignored
```

### 3.3 Integration test

Create `tests/integration.rs`:

```rust
use vapor_idx::{
    create_vapor, VaporSchema, TypeDefinition, FieldDefinition,
    FieldType, IndexStrategy, QueryOptions, FieldFilter, FilterOp,
    TraversalOptions, TraversalDirection,
};
use std::collections::HashMap;

fn task_schema() -> VaporSchema {
    VaporSchema {
        types: HashMap::from([
            ("Task".to_string(), TypeDefinition {
                fields: HashMap::from([
                    ("title".to_string(), FieldDefinition {
                        field_type: FieldType::String,
                        index: IndexStrategy::Keyword,
                        required: true,
                    }),
                    ("priority".to_string(), FieldDefinition {
                        field_type: FieldType::Number,
                        index: IndexStrategy::Range,
                        required: true,
                    }),
                    ("status".to_string(), FieldDefinition {
                        field_type: FieldType::String,
                        index: IndexStrategy::Exact,
                        required: false,
                    }),
                ]),
                relationships: HashMap::new(),
            }),
        ]),
    }
}

#[test]
fn smoke_test() {
    let mut vapor = create_vapor(task_schema()).expect("valid schema");

    let id1 = vapor.store("Task", serde_json::json!({
        "title": "Write tests", "priority": 1, "status": "open"
    })).unwrap();
    let id2 = vapor.store("Task", serde_json::json!({
        "title": "Deploy package", "priority": 2, "status": "open"
    })).unwrap();

    assert_eq!(vapor.stats().unwrap().total_records, 2);

    let low_priority = vapor.query(&QueryOptions {
        where_filters: vec![FieldFilter {
            field: "priority".to_string(),
            op: FilterOp::Lte,
            value: serde_json::json!(1),
        }],
        ..Default::default()
    }).unwrap();
    assert_eq!(low_priority.total, 1);

    vapor.destroy();
}

#[test]
fn negative_range_test() {
    let schema = VaporSchema {
        types: HashMap::from([
            ("Point".to_string(), TypeDefinition {
                fields: HashMap::from([
                    ("x".to_string(), FieldDefinition { field_type: FieldType::Number, index: IndexStrategy::Range, required: false }),
                    ("y".to_string(), FieldDefinition { field_type: FieldType::Number, index: IndexStrategy::Range, required: false }),
                ]),
                relationships: HashMap::new(),
            }),
        ]),
    };

    let mut vapor = create_vapor(schema).unwrap();
    vapor.store("Point", serde_json::json!({"x": -10.0, "y": -5.0})).unwrap();
    vapor.store("Point", serde_json::json!({"x":  -1.0, "y":  0.0})).unwrap();
    vapor.store("Point", serde_json::json!({"x":   0.0, "y":  3.0})).unwrap();
    vapor.store("Point", serde_json::json!({"x":   5.0, "y": 10.0})).unwrap();

    let negatives = vapor.query(&QueryOptions {
        where_filters: vec![FieldFilter {
            field: "x".to_string(), op: FilterOp::Lt, value: serde_json::json!(0.0),
        }],
        ..Default::default()
    }).unwrap();
    assert_eq!(negatives.total, 2, "Expected 2 negative-x points, got {}", negatives.total);

    let gt_neg2 = vapor.query(&QueryOptions {
        where_filters: vec![FieldFilter {
            field: "x".to_string(), op: FilterOp::Gt, value: serde_json::json!(-2.0),
        }],
        ..Default::default()
    }).unwrap();
    assert_eq!(gt_neg2.total, 3, "Expected 3 points with x > -2, got {}", gt_neg2.total);

    vapor.destroy();
}
```

```bash
cargo test --test integration
```

### 3.4 Verify range index correctness for coordinates

This is critical for pixel and 3D indexing. Test negative spatial coordinates:

```bash
cargo test indexes::range
```

---

## Part 4 — Skills testing with Claude

### 4.1 Install skills

Copy the skill files to the Claude skills directory:

```bash
# If testing locally with Claude Code:
mkdir -p ~/.claude/skills
cp -r skills/* ~/.claude/skills/
```

Or reference the skill files directly from the repository when running Claude Code.

### 4.2 Test pixel-analyzer skill

Prepare a test image (any PNG):

```bash
# Create a simple 64x64 test PNG using Python
python3 - <<'EOF'
from PIL import Image
img = Image.new("RGB", (64, 64), (255, 255, 255))
pix = img.load()
# Red square top-left
for y in range(20):
    for x in range(20):
        pix[x, y] = (220, 30, 30)
# Blue square bottom-right
for y in range(44, 64):
    for x in range(44, 64):
        pix[x, y] = (30, 30, 220)
img.save("test_input.png")
print("Created test_input.png")
EOF
```

Then prompt Claude with:
> "Use the pixel-analyzer skill to analyze test_input.png. Find all red pixels,
> find all blue pixels, invert the colours, and save the result as output.png."

Expected: Claude indexes the pixels, finds red/blue regions, applies inversion,
saves output.png, and reports the pixel counts.

### 4.3 Test mesh-analyzer skill

Create a minimal OBJ file:

```bash
cat > test_cube.obj << 'EOF'
# Simple cube
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
EOF
```

Then prompt Claude with:
> "Use the mesh-analyzer skill to analyze test_cube.obj. Report the vertex and
> face counts, find all vertices with positive X coordinates, then reconstruct
> the mesh as a Blender Python script and save it as cube_reconstruct.py."

Expected: Claude indexes 8 vertices and 6 faces, reports stats, queries by
spatial position, and saves the reconstruction script.

Verify the Blender script runs (if Blender is available):
```bash
blender --background --python cube_reconstruct.py
```

### 4.4 Test design-indexer skill

```bash
cat > test_design.svg << 'EOF'
<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect id="bg"     x="0"   y="0"   width="400" height="300" fill="#f0f0f0"/>
  <rect id="header" x="0"   y="0"   width="400" height="60"  fill="#2c3e50"/>
  <rect id="card1"  x="20"  y="80"  width="160" height="180" fill="#ffffff"/>
  <rect id="card2"  x="220" y="80"  width="160" height="180" fill="#ffffff"/>
  <text id="title"  x="20"  y="40"  fill="#ffffff" font-size="24">Dashboard</text>
</svg>
EOF
```

Then prompt Claude with:
> "Use the design-indexer skill to analyze test_design.svg. Report the element
> structure, find all white elements, and reconstruct the design as a CSS layout
> file."

Expected: Claude indexes 5 elements, queries by colour, and saves layout.css.

### 4.5 Test cross-modal-reconstructor skill

```bash
# Reuse test_design.svg from above
```

Prompt Claude with:
> "Use the cross-modal-reconstructor skill to convert test_design.svg into a
> CSS flexbox layout."

Expected: Claude decomposes the SVG, traverses the containment hierarchy, and
emits a CSS file with absolute positioning for each element.

---

## Part 5 — End-to-end validation checklist

Work through this checklist after all tests pass:

```
TypeScript package:
[ ] npm install runs without errors
[ ] tsc builds dist/ without errors
[ ] Smoke test passes (createVapor, store, query, traverse, snapshot, restore, destroy)
[ ] Negative range test passes (lt/gt on negative numbers)
[ ] Pixel indexing test passes (range queries on x/y/r/g/b, adjacency traversal)

Python package:
[ ] pip install -e . runs without errors
[ ] Smoke test passes
[ ] Negative range test passes
[ ] Pixel indexing test passes
[ ] Schema validator rejects invalid types and strategies
[ ] VaporDestroyedError raised after destroy()

Rust package:
[ ] cargo build succeeds
[ ] cargo test passes (including range::tests)
[ ] Negative range integration test passes
[ ] Snapshot/restore round-trip preserves all records

Skills:
[ ] pixel-analyzer: indexes PNG, queries by colour, saves output PNG
[ ] mesh-analyzer: indexes OBJ, queries by position, saves Blender script
[ ] design-indexer: indexes SVG/HTML, queries by property, saves CSS/SVG
[ ] cross-modal-reconstructor: converts between modalities, saves output file
```

---

## Publishing

When all tests pass:

```bash
# TypeScript — npm
cd packages/vapor-idx
npm run build
npm publish --access public

# Python — PyPI
cd packages/vapor-idx-py
pip install build twine --break-system-packages
python -m build
twine upload dist/*

# Rust — crates.io
cd packages/vapor-idx-rs
cargo publish
```

All three packages should be published simultaneously with the same version number.

---

## Discord

Join the community at **https://discord.gg/vapor-idx** to share skills, report
bugs, and discuss modality indexing patterns.
