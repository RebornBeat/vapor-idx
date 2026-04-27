# vapor-idx — Core Concept

## The fundamental idea

vapor-idx is built on one constraint: **everything lives in RAM, everything is
gone when the skill ends.**

This constraint is not a limitation — it is the design. Skills are invocations,
not services. They run, they finish, they leave no trace. An in-skill knowledge
store that persists would break this model. An in-skill knowledge store that
requires a database connection would introduce external dependencies that break
skill portability. An in-skill knowledge store that uses ML embeddings would make
skills non-deterministic and heavy.

vapor-idx gives skills a structured, queryable, traversable knowledge store that
respects all of these constraints: no persistence, no external dependencies, no ML.

---

## What a skill author declares

A skill author writes a **schema** before storing any records. The schema declares:

1. **Types** — named categories of records (`Function`, `Pixel`, `Vertex`, `Task`)
2. **Fields** — named properties on each type, with a primitive type and an index
   strategy
3. **Relationships** — named edge kinds between types, with cardinality and
   direction

From that schema, vapor-idx builds the in-memory index structure. Nothing is
auto-detected. Nothing has a default. Everything is intentional.

---

## The four index strategies

Every field must have exactly one declared index strategy. The strategy determines
what queries are possible on that field.

**`none`** — The field is stored but not indexed. It can be retrieved via `get(id)`
but cannot be used in `query()` filters directly. Use this for fields you store
purely to return in results, like `description` or `rawData`.

**`exact`** — An equality index. The field's value is normalised (lowercased for
strings) and stored in a HashMap keyed by value. Supports `eq`, `neq`, `in`,
`notIn`. Use for status fields, category fields, boolean flags, IDs, language
identifiers.

**`keyword`** — A tokenised inverted index. The field's value is split into tokens
(words of 3+ characters), each token keyed to a set of record IDs. Supports
`contains` (per-field) and free-text `keywords` search (across all keyword
fields). Use for text content, docstrings, labels, descriptions.

**`prefix`** — A trie-based index. The field's value is inserted character by
character into a prefix tree, with the record ID stored at every prefix node.
Supports `startsWith`. Use for paths, namespaces, MIME types, anything where
prefix matching matters.

**`range`** — A sorted array of `(orderedBits, id)` pairs. Supports `gt`, `lt`,
`gte`, `lte` via binary search. Use for coordinates, timestamps, sizes, scores,
any numeric field you need range queries on. All implementations correctly handle
negative numbers, zero, and positive numbers.

---

## Relationships as first-class citizens

Relationships are not just join tables. They are stored as typed edges with:

- A declared type name (e.g. `CALLS`, `ADJACENT_TO`, `DEFINED_IN`)
- A source record ID and target record ID
- A cardinality constraint (`one-to-one`, `one-to-many`, `many-to-many`)
- A direction flag (`directed` = true means one-way; false = bidirectional)
- Optional metadata (arbitrary key-value pairs)

When a relationship is bidirectional, calling `relate(a, type, b)` automatically
creates both the forward and reverse edges. The traversal engine follows edges in
the declared direction.

---

## RAM-first: what this means in practice

`vapor.store(type, data)` returns a string ID. The record is held in:

- **TypeScript**: a frozen JavaScript object in a `Map<string, object>`
- **Python**: a frozen dataclass instance in a `dict[str, VaporRecord]`
- **Rust**: a `VaporRecord` struct in a `HashMap<String, VaporRecord>`

No disk write. No network call. No database transaction. The data lives in process
memory alongside the skill's other local variables. It is as ephemeral as a `let`
declaration.

When `vapor.destroy()` is called — or when the instance goes out of scope — the
HashMap and all associated index structures are freed. The GC or Rust's drop
semantics handle the rest.

---

## Any modality that can be typed can be indexed

The schema system is general enough to express any modality as typed records with
relationships. This is the core insight that makes vapor-idx useful beyond
traditional structured data:

**Images**: A `Pixel` type with `x`, `y`, `r`, `g`, `b` fields indexed as `range`,
and `ADJACENT_TO` relationships between neighbouring pixels. Spatial queries find
pixels by colour range or position. Traversal finds connected regions.

**3D meshes**: A `Vertex` type with `x`, `y`, `z` and `normalX`, `normalY`,
`normalZ` fields, a `Face` type, a `Material` type, and `CONNECTED_TO` / `PART_OF`
relationships. The full topology of an OBJ or GLTF file becomes queryable and
traversable.

**Design elements**: An `Element` type with `tagName`, `className`, `colorHex`,
`width`, `height`, `x`, `y` fields, and `CONTAINS` / `ADJACENT_TO` relationships
between layout elements. An HTML DOM or a Figma layer tree becomes a traversable
graph.

**Audio frames**: A `Frame` type with `time`, `amplitude`, `frequency` fields, and
`PRECEDES` / `OVERLAPS` relationships between frames. A waveform becomes a
queryable time-series.

**Code structure**: A `Function` type with `name`, `filePath`, `lineStart`,
`lineEnd` fields, and `CALLS` / `DEFINED_IN` relationships. A codebase becomes a
traversable call graph.

---

## Claude as the zero-shot intelligence

vapor-idx provides structure. Claude provides reasoning.

When a skill runs, Claude is the intelligence executing the skill instructions.
Claude can:

- Query the index with declared predicates (`eq`, `range`, `keyword`)
- Traverse relationships (BFS with depth control)
- Find shortest paths between records
- Apply its own semantic understanding to what the traversal returns
- Drive reconstruction of output artifacts from the indexed structure

This means a skill can analyse an image without YOLO, understand a 3D mesh without
a render engine, and reconstruct design elements without Figma's API — because
Claude traverses the structured index and applies its reasoning to the results.

The index is the bridge between raw modality data and Claude's reasoning. The skill
is the instruction set that tells Claude how to use the bridge.

---

## Snapshots

Snapshots capture the full state of a VaporInstance as a plain serialisable object.
They enable:

**Branching logic**: Snapshot before exploring an interpretation. If the branch
fails, restore from the snapshot and try another. The original instance is
unchanged.

**Checkpointing**: Snapshot at a milestone. The serialised snapshot can be written
to disk by the skill author if persistence across invocations is needed — but this
is the skill author's responsibility, not vapor-idx's.

**Forking**: Restore the same snapshot into two separate instances and explore both
paths in parallel.

Snapshots are schema-hash-bound. Restoring a snapshot taken from a different
schema version will be rejected.

---

## What vapor-idx does not do

These are intentional exclusions, not missing features:

- No embeddings, vectors, or similarity search
- No ML model calls
- No persistence or disk writes
- No cross-skill or cross-session state
- No schema migrations or versioning
- No transactions or rollback (destroy and recreate if needed)
- No query optimiser (declare the right index strategy for your access patterns)
- No confidence scores (the index is deterministic)

The moment you need any of these, you have outgrown an in-skill ephemeral index.
Use a real database, a vector store, or a persistent graph database.

---

## Design decisions

**Why separate packages for TypeScript, Python, and Rust?**

Skills execute in the runtime they target. A Node.js skill imports from npm. A
Python computer-use skill imports from PyPI. A Rust skill tooling layer imports
from crates.io. There is no polyglot runtime that covers all three with a single
package. The monorepo keeps the API contract consistent across all three while
shipping idiomatic implementations for each runtime.

**Why no defaults anywhere?**

Defaults hide intent. When a skill author declares `{ type: 'string', index: 'exact' }`,
it is explicit that this field will be used for equality queries. When they declare
`{ type: 'string', index: 'none' }`, it is explicit that this field will not be
queried. Defaults would make skill behaviour harder to reason about and harder to
optimise.

**Why normalise string values in the exact index?**

Case-insensitive equality is almost always what skill authors want. Storing `"TypeScript"`
and querying for `"typescript"` should match. Skill authors who need case-sensitive
equality can store values in a canonical case themselves.

**Why BFS for traversal?**

BFS naturally returns the shortest paths first. For most skill use cases — finding
call chains, finding spatial neighbours, finding connected regions — shortest-first
is the correct traversal order. DFS would be deeper-first, which tends to produce
less useful results for relationship-following tasks.
