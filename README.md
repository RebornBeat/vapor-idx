# vapor-idx

> **Pure RAM. Per-skill. Gone when you're done.**

`vapor-idx` is a zero-dependency, fully declarative, in-memory indexing framework for
AI skill authors. It gives individual skills a structured, queryable, traversable
knowledge store that lives entirely in process memory and disappears the moment the
skill ends — no files, no databases, no persistence, no cross-skill leakage.

It is not a database. It is not a cache. It is not a knowledge graph that survives
sessions. It is RAM — shaped, named, and queryable — scoped to exactly one skill
invocation at a time.

---

## Why does this exist?

When you write a Claude skill that needs to reason over structured data — a code
analysis skill that must track function relationships, a document skill that must
link sections to their references, a pipeline skill that must index its own steps —
you need somewhere to put that structure while the skill runs. Without a tool like
this, every skill author re-implements ad-hoc Maps, arrays of objects, and linear
scans.

`vapor-idx` provides the scaffold so skill authors declare their data model once and
query it cleanly, without reinventing indexing primitives every time.

**What it is not:**
- It does not persist anything. Ever. By design.
- It does not share state between skills.
- It does not use embeddings, ML models, or vector search.
- It does not have defaults. Every type, field, and index strategy is declared by
  the skill author.
- It does not enforce opinions about your data shape.

---

## Monorepo structure

Skills execute in multiple runtimes. A single npm package cannot serve a Python
computer-use skill, and a Python package cannot serve a browser artifact. Each
package is a faithful implementation of the same API contract in its target language.

```
vapor-idx/
├── README.md                     ← you are here
├── packages/
│   ├── vapor-idx/                ← TypeScript / JavaScript (Node.js + Browser ESM)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── VaporInstance.ts
│   │       ├── SchemaValidator.ts
│   │       ├── RecordStore.ts
│   │       ├── RelationshipStore.ts
│   │       ├── QueryEngine.ts
│   │       ├── TraversalEngine.ts
│   │       └── indexes/
│   │           ├── ExactIndex.ts
│   │           ├── KeywordIndex.ts
│   │           ├── PrefixIndex.ts
│   │           └── RangeIndex.ts
│   │
│   ├── vapor-idx-py/             ← Python 3.10+ (PyPI)
│   │   ├── pyproject.toml
│   │   └── vapor_idx/
│   │       ├── __init__.py
│   │       ├── types.py
│   │       ├── instance.py
│   │       ├── schema.py
│   │       ├── record_store.py
│   │       ├── relationship_store.py
│   │       ├── query_engine.py
│   │       ├── traversal_engine.py
│   │       └── indexes/
│   │           ├── __init__.py
│   │           ├── exact.py
│   │           ├── keyword.py
│   │           ├── prefix.py
│   │           └── range_.py
│   │
│   └── vapor-idx-rs/             ← Rust (crates.io)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── types.rs
│           ├── instance.rs
│           ├── schema.rs
│           ├── record_store.rs
│           ├── relationship_store.rs
│           ├── query_engine.rs
│           ├── traversal_engine.rs
│           └── indexes/
│               ├── mod.rs
│               ├── exact.rs
│               ├── keyword.rs
│               ├── prefix.rs
│               └── range.rs
```

---

## Installation

**Node.js / Browser (TypeScript / JavaScript)**
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

## Core concepts

### Schema-first, no defaults

You declare every type, every field, and the index strategy for every field before
storing a single record. There are no auto-detected types, no implicit indexes, no
convenience defaults. The schema is the law of your skill's index.

### Index strategies

| Strategy   | What it indexes              | Supported operations               |
|------------|------------------------------|------------------------------------|
| `none`     | Nothing — stored only        | Full scan only                     |
| `exact`    | Exact value equality         | `eq`, `neq`, `in`, `notIn`         |
| `keyword`  | Tokenised inverted index     | `contains`, free-text `keywords`   |
| `prefix`   | Trie-based prefix matching   | `startsWith`                       |
| `range`    | Sorted numeric values        | `gt`, `lt`, `gte`, `lte`           |

### Relationships

Types can declare named relationship kinds between them. Relationships are
directional or bidirectional, with declared cardinality. They are stored as
first-class edges that can be traversed by the query engine.

### Traversal

The traversal engine follows relationship edges from a starting node, up to a
declared depth, with optional filtering applied at each hop. It returns both the
matched records and the paths taken to reach them.

### Snapshots

At any point you can take a snapshot of the entire index state as a plain
serialisable value. You can restore from a snapshot to fork or checkpoint state
mid-skill. Snapshots are still RAM-only — serialisation to disk is the caller's
responsibility if they want it.

---

## Quick start — TypeScript

```typescript
import { createVapor } from 'vapor-idx';

// 1. Declare your schema. No defaults. Every field needs an index strategy.
const vapor = createVapor({
  types: {
    Function: {
      fields: {
        name:       { type: 'string',   index: 'exact'   },
        filePath:   { type: 'string',   index: 'exact'   },
        docstring:  { type: 'string',   index: 'keyword' },
        lineStart:  { type: 'number',   index: 'range'   },
        lineEnd:    { type: 'number',   index: 'range'   },
        isAsync:    { type: 'boolean',  index: 'exact'   },
        tags:       { type: 'string[]', index: 'keyword' },
        visibility: { type: 'string',   index: 'prefix'  },
      },
      relationships: {
        CALLS: {
          targetTypes:  ['Function'],
          directed:     true,
          cardinality:  'many-to-many',
        },
        DEFINED_IN: {
          targetTypes:  ['Module'],
          directed:     true,
          cardinality:  'many-to-one',
        },
      },
    },

    Module: {
      fields: {
        path:     { type: 'string', index: 'exact'   },
        language: { type: 'string', index: 'exact'   },
        summary:  { type: 'string', index: 'keyword' },
      },
    },
  },
});

// 2. Store records.
const modId = vapor.store('Module', {
  path:     'src/parser.ts',
  language: 'typescript',
  summary:  'Parses AST nodes and extracts function signatures',
});

const fnId = vapor.store('Function', {
  name:       'parseFunction',
  filePath:   'src/parser.ts',
  docstring:  'Extracts function name, parameters, and return type from an AST node',
  lineStart:  42,
  lineEnd:    78,
  isAsync:    false,
  tags:       ['parsing', 'ast', 'extraction'],
  visibility: 'public',
});

// 3. Link records.
vapor.relate(fnId, 'DEFINED_IN', modId);

// 4. Query.
const asyncFns = vapor.query({
  type:  'Function',
  where: { field: 'isAsync', op: 'eq', value: true },
});

const parsingFns = vapor.query({
  type:     'Function',
  keywords: 'ast extraction',
});

const largeFns = vapor.query({
  type:  'Function',
  where: { field: 'lineEnd', op: 'gt', value: 100 },
  orderBy: { field: 'lineStart', direction: 'asc' },
  limit: 10,
});

// 5. Traverse relationships.
const callChain = vapor.traverse({
  from:         fnId,
  relationship: 'CALLS',
  direction:    'outgoing',
  depth:        3,
});

// 6. Find a path between two nodes.
const path = vapor.findPath({
  from:         fnId,
  to:           someOtherFnId,
  relationship: 'CALLS',
  maxDepth:     5,
});

// 7. Inspect stats.
console.log(vapor.stats());

// 8. Snapshot and restore.
const snap = vapor.snapshot();
const fork = vapor.restore(snap);

// 9. Wipe everything when the skill ends (or just let it go out of scope).
vapor.destroy();
```

---

## Quick start — Python

```python
from vapor_idx import create_vapor

vapor = create_vapor({
    "types": {
        "Function": {
            "fields": {
                "name":       {"type": "string",   "index": "exact"},
                "file_path":  {"type": "string",   "index": "exact"},
                "docstring":  {"type": "string",   "index": "keyword"},
                "line_start": {"type": "number",   "index": "range"},
                "is_async":   {"type": "boolean",  "index": "exact"},
                "tags":       {"type": "string[]", "index": "keyword"},
            },
            "relationships": {
                "CALLS": {
                    "targetTypes": ["Function"],
                    "directed":    True,
                    "cardinality": "many-to-many",
                },
            },
        },
    },
})

fn_id = vapor.store("Function", {
    "name":       "parse_function",
    "file_path":  "parser.py",
    "docstring":  "Extracts function signatures from AST nodes",
    "line_start": 42,
    "is_async":   False,
    "tags":       ["parsing", "ast"],
})

results = vapor.query({
    "type":     "Function",
    "keywords": "ast extraction",
})

vapor.destroy()
```

---

## Quick start — Rust

```rust
use vapor_idx::{create_vapor, VaporSchema, TypeDefinition, FieldDefinition,
                FieldType, IndexStrategy, QueryOptions, FieldFilter, FilterOp};
use std::collections::HashMap;

fn main() {
    let mut schema = VaporSchema::new();

    schema.add_type("Function", TypeDefinition {
        fields: HashMap::from([
            ("name".into(), FieldDefinition {
                field_type: FieldType::Str,
                index:      IndexStrategy::Exact,
                required:   true,
            }),
            ("line_start".into(), FieldDefinition {
                field_type: FieldType::Number,
                index:      IndexStrategy::Range,
                required:   true,
            }),
        ]),
        relationships: HashMap::new(),
    });

    let mut vapor = create_vapor(schema);

    let fn_id = vapor.store("Function", serde_json::json!({
        "name":       "parse_function",
        "line_start": 42,
    })).unwrap();

    let results = vapor.query(QueryOptions {
        type_filter: Some(vec!["Function".into()]),
        where_filters: vec![FieldFilter {
            field: "line_start".into(),
            op:    FilterOp::Gt,
            value: serde_json::json!(10),
        }],
        ..Default::default()
    }).unwrap();

    vapor.destroy();
}
```

---

## API reference

### `createVapor(schema)` → `VaporInstance`

Creates a new isolated index bound to the provided schema. No types, fields, or
relationships exist until declared in the schema.

---

### `vapor.store(type, data)` → `string` (record ID)

Stores a record of the given type. Validates required fields and field types
against the schema. Indexes all fields according to their declared strategy.
Throws if the type is not declared or required fields are missing.

---

### `vapor.get(id)` → `VaporRecord | null`

Returns a single record by ID. O(1).

---

### `vapor.update(id, partial)` → `void`

Updates fields on an existing record. Re-indexes all changed fields. Throws if
the record does not exist or updated values violate type constraints.

---

### `vapor.delete(id)` → `void`

Removes a record and all its relationship edges from the index.

---

### `vapor.relate(sourceId, relationshipType, targetId, metadata?)` → `string` (edge ID)

Creates a relationship edge between two records. Validates that both records exist,
that the relationship type is declared on the source type, and that the target
type is permitted. If the relationship is bidirectional, creates edges in both
directions.

---

### `vapor.unrelate(edgeId)` → `void`

Removes a relationship edge by edge ID.

---

### `vapor.query(options)` → `QueryResult`

Executes a query against the index.

```typescript
interface QueryOptions {
  type?:     string | string[];          // filter by type
  where?:    FieldFilter | FieldFilter[];// field-level predicates
  keywords?: string | string[];         // full-text across keyword fields
  logic?:    'AND' | 'OR';              // how multiple where clauses combine
  limit?:    number;
  offset?:   number;
  orderBy?:  { field: string; direction: 'asc' | 'desc' };
}
```

Operators by index strategy:

| Strategy  | Valid operators                        |
|-----------|----------------------------------------|
| `exact`   | `eq`, `neq`, `in`, `notIn`             |
| `keyword` | `contains`                             |
| `prefix`  | `startsWith`                           |
| `range`   | `gt`, `lt`, `gte`, `lte`              |
| `none`    | None — field is not queryable directly |

---

### `vapor.traverse(options)` → `TraversalResult`

Follows relationship edges from a starting node.

```typescript
interface TraversalOptions {
  from:         string;                   // start record ID
  relationship: string;                   // declared relationship type
  direction?:   'outgoing' | 'incoming' | 'both';
  depth?:       number;                   // max hops (default: 1)
  filter?:      Omit<QueryOptions, 'limit' | 'offset' | 'orderBy'>;
}
```

---

### `vapor.findPath(options)` → `string[] | null`

Returns the shortest ID path between two records following relationship edges,
or `null` if no path exists within `maxDepth`.

---

### `vapor.getRelationships(id, type?, direction?)` → `VaporRelationship[]`

Returns all relationship edges for a given record, optionally filtered by
relationship type and direction.

---

### `vapor.stats()` → `VaporStats`

Returns counts of records by type, relationships by type, index sizes, and a
rough memory estimate in bytes.

---

### `vapor.snapshot()` → `VaporSnapshot`

Captures the full current state as a plain serialisable object. Does not write
to disk.

---

### `vapor.restore(snapshot)` → `VaporInstance`

Returns a **new** `VaporInstance` hydrated from a snapshot. The original instance
is unchanged. The snapshot must have been taken from an instance with the same
schema hash.

---

### `vapor.destroy()` → `void`

Explicitly releases all references held by the index. After calling `destroy()`,
all method calls on the instance throw. Safe to call multiple times.

---

## Skill authoring guidelines

**Declare only what you need.** Every declared field consumes memory proportional
to its index type and the number of unique values stored. A `keyword` index on a
high-cardinality field with long text will consume significantly more RAM than an
`exact` index on a low-cardinality enum field.

**Choose index strategies based on actual query patterns.** If you never query a
field, use `none`. If you only do equality checks, use `exact`. Do not use
`keyword` for fields you only filter with `eq`.

**Destroy explicitly in long-running skills.** If a skill instantiates vapor-idx
inside a loop or a repeated subroutine, call `vapor.destroy()` when the local
scope is done. This ensures GC can collect the index structures promptly rather
than waiting for scope exit.

**Use snapshots for branching logic.** If your skill needs to explore two possible
interpretations of data and then pick one, snapshot before the branch and restore
the losing branch's state.

**Do not use vapor-idx as a communication channel between skills.** Instances are
process-local and are not designed to be passed across skill boundaries. Each skill
creates its own instance from its own schema.

---

## Philosophy

vapor-idx is deliberately minimal. It does not implement:

- Embeddings or vector similarity
- ML-guided ranking or confidence scoring
- Persistence to any storage medium
- Cross-skill or cross-session state
- Schema migrations
- Query optimiser hints
- Transactions or rollback

These are not omissions waiting to be filled. They are intentional exclusions. The
moment you need any of them, you have outgrown an in-skill ephemeral index and you
need a real database.

---

## Package publishing

| Package      | Registry  | Import                         |
|--------------|-----------|--------------------------------|
| `vapor-idx`  | npm       | `import { createVapor } from 'vapor-idx'` |
| `vapor-idx`  | PyPI      | `from vapor_idx import create_vapor`      |
| `vapor-idx`  | crates.io | `use vapor_idx::create_vapor;`            |

All three packages are versioned in lockstep. A `0.2.0` release ships all three
packages simultaneously.

---

## License

MIT
