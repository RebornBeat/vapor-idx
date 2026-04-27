# vapor-idx

> **Pure RAM. Per-skill. Gone when you're done.**

`vapor-idx` is a zero-dependency, fully declarative, in-memory indexing framework
for AI skill authors. It gives individual skills a structured, queryable,
traversable knowledge store that lives entirely in process memory and disappears
the moment the skill ends — no files, no databases, no persistence, no cross-skill
leakage.

**GitHub:** https://github.com/RebornBeat/vapor-idx
**Discord:** https://discord.gg/vapor-idx

---

## Why does this exist?

When you write a Claude skill that needs to reason over structured data — code
analysis, image pixel traversal, 3D mesh topology, design element layout — you need
somewhere to put that structure while the skill runs. Without a tool like this,
every skill author re-implements ad-hoc Maps, arrays of objects, and linear scans.

`vapor-idx` provides the scaffold so skill authors declare their data model once and
query it cleanly, without reinventing indexing primitives every time.

**Core constraints:**
- It does not persist anything. Ever.
- It does not share state between skills.
- It does not use embeddings, ML models, or vector search.
- It has no defaults. Every type, field, and index strategy is declared explicitly.

`vapor.store(type, data)` stores records **in RAM** as native language objects —
JavaScript objects, Python dicts, Rust structs. Nothing touches the filesystem
unless the skill author chooses to serialise a snapshot themselves.

---

## The modality vision

vapor-idx is not limited to traditional structured data. Any modality that can be
expressed as typed records with relationships can be indexed, queried, and
reconstructed.

### Images without ML

Declare a `Pixel` type with `x`, `y`, `r`, `g`, `b` fields indexed as `range`.
Claude traverses adjacency relationships to identify regions, edges, and dominant
colours. Reconstruct to `.png`, SVG shapes, or CSS — no YOLO, no ResNet, no
external model calls.

### 3D mesh without a render engine

Index OBJ/STL/GLTF vertices, faces, and materials as typed records. Traverse mesh
topology. Emit a Blender Python script that reconstructs the full `.blend` file.
Analyse spatial layout and material usage without loading a render engine.

### Design element indexing

Index HTML/SVG elements by position, size, colour, and containment. Query by
property. Reconstruct as CSS layouts or transformed SVG.

### Cross-modal reconstruction

Index source modality → traverse with Claude's semantic reasoning → emit target
modality. Pixels → SVG regions. OBJ mesh → Blender Python. SVG → CSS. Audio
peaks → MIDI events. The index is the bridge; Claude is the intelligence.

---

## Current capabilities

| Capability                         | Status  |
|------------------------------------|---------|
| Typed schema declaration           | ✅ Stable |
| Exact / keyword / prefix / range indexing | ✅ Stable |
| Relationship edges (directed + bidirectional) | ✅ Stable |
| BFS traversal with depth control   | ✅ Stable |
| Shortest-path finding              | ✅ Stable |
| Snapshot / restore                 | ✅ Stable |
| Pixel-level image indexing         | ✅ Stable |
| 3D mesh vertex/face indexing       | ✅ Stable |
| Design element indexing            | ✅ Stable |
| Cross-modal reconstruction         | ✅ Stable |
| Negative number range queries      | ✅ Stable |
| TypeScript / Node.js               | ✅ Stable |
| Python 3.10+                       | ✅ Stable |
| Rust                               | ✅ Stable |

## What it cannot do (by design)

| Capability                         | Status  |
|------------------------------------|---------|
| Generate data that wasn't in the source | ❌ By design |
| Persist across skill invocations   | ❌ By design |
| Share state between skills         | ❌ By design |
| Vector / semantic similarity search | ❌ By design |
| ML-guided ranking                  | ❌ By design |

"Add a teapot to this image" is outside scope — this requires **generative**
capability, not indexing. vapor-idx can index a teapot if you give it teapot pixel
data, and it can then position, blend, and reconstruct it. The data must come from
somewhere; vapor-idx is the structure, not the source.

---

## Future roadmap

These are community-driven and not committed. Contributions welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md).

| Capability                              | Phase    |
|-----------------------------------------|----------|
| Local LLM API bridge (Ollama / llamacpp) | Phase 2 |
| Hybrid mode: in-memory + local persistent store | Phase 2 |
| Spatial tree indexes (R-tree / k-d tree) for pixel/vertex queries | Phase 2 |
| WASM target for browser-native usage    | Phase 3  |
| Local embedding index (no API key)      | Phase 3  |
| Cross-skill snapshot passing            | Phase 3  |
| Full local graph database backend       | Phase 4  |

**Inspiration:** vapor-idx grew out of research into modality-based graph systems
for AGI architecture — specifically the insight that any modality (pixels, vertices,
audio frames, design elements) can be decomposed into typed records with
relationships and traversed by a zero-shot reasoning model. The library is a
standalone, dependency-free demonstration of that concept, open to community
contributions and extensions.

---

## Monorepo structure

```
vapor-idx/
├── README.md
├── TESTING.md
├── CONTRIBUTING.md
├── smoke_test.py          ← developer validation (Python)
├── smoke.mjs              ← developer validation (TypeScript)
├── docs/
│   ├── CONCEPT.md
│   ├── API_REFERENCE.md
│   ├── PIXEL_INDEXING.md
│   ├── 3D_INDEXING.md
│   └── CROSS_MODAL.md
├── skills/
│   ├── pixel-analyzer/SKILL.md
│   ├── mesh-analyzer/SKILL.md
│   ├── design-indexer/SKILL.md
│   └── cross-modal-reconstructor/SKILL.md
├── python/                ← PyPI: vapor-idx
├── rust/                  ← crates.io: vapor-idx
└── typescript/            ← npm: vapor-idx
```

---

## Installation

**Node.js / Browser ESM**
```bash
npm install vapor-idx
```

**Python**
```bash
pip install vapor-idx
```

**Rust**
```toml
[dependencies]
vapor-idx = "0.1"
```

---

## Index strategies

| Strategy  | Supported operations           | Best for                        |
|-----------|--------------------------------|---------------------------------|
| `none`    | Retrieval by ID only           | Display-only fields             |
| `exact`   | `eq` `neq` `in` `notIn`       | Status, category, boolean, enum |
| `keyword` | `contains`, free-text          | Text, descriptions, labels      |
| `prefix`  | `startsWith`                   | Paths, namespaces               |
| `range`   | `gt` `lt` `gte` `lte`         | Numbers, coords, timestamps     |

**Important:** `range` fields require `gte`/`lte` pairs for point-equality queries.
`op: "eq"` is only valid on `exact`-indexed fields.

---

## API reference

See [docs/API_REFERENCE.md](docs/API_REFERENCE.md) for complete type definitions.

---

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Discord

https://discord.gg/vapor-idx
