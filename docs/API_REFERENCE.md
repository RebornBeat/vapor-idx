# vapor-idx — Complete API Reference

## Type definitions

### Schema types

```typescript
type FieldType     = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';
type IndexStrategy = 'none' | 'exact' | 'keyword' | 'prefix' | 'range';

interface FieldDefinition {
  type:      FieldType;
  index:     IndexStrategy;
  required?: boolean;         // default: false
}

interface RelationshipDefinition {
  targetTypes:  string[];                          // use ['*'] to allow any type
  directed:     boolean;                           // true = one-way, false = both directions
  cardinality: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

interface TypeDefinition {
  fields:         Record<string, FieldDefinition>;
  relationships?: Record<string, RelationshipDefinition>;
}

interface VaporSchema {
  types: Record<string, TypeDefinition>;
}
```

### Record types

```typescript
interface VaporRecord<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly id:         string;   // generated: "vpr_<timestamp>_<counter>"
  readonly type:       string;   // declared type name
  readonly data:       Readonly<T>;
  readonly _createdAt: number;   // Unix timestamp in ms
  readonly _updatedAt: number;   // Unix timestamp in ms
}

interface VaporRelationship {
  readonly id:               string;   // generated: "vpe_<timestamp>_<counter>"
  readonly relationshipType: string;   // declared relationship name
  readonly sourceId:         string;
  readonly targetId:         string;
  readonly metadata:         Readonly<Record<string, unknown>>;
  readonly _createdAt:       number;
}
```

### Query types

```typescript
type FilterOp =
  | 'eq'        // exact index only
  | 'neq'       // exact index only
  | 'in'        // exact index only; value must be an array
  | 'notIn'     // exact index only; value must be an array
  | 'contains'  // keyword index only
  | 'startsWith'// prefix index only
  | 'gt'        // range index only; value must be a number
  | 'lt'        // range index only; value must be a number
  | 'gte'       // range index only; value must be a number
  | 'lte'       // range index only; value must be a number

interface FieldFilter {
  field: string;
  op:    FilterOp;
  value: unknown;
}

interface QueryOptions {
  type?:     string | string[];
  where?:    FieldFilter | FieldFilter[];
  keywords?: string | string[];  // free-text across all keyword fields
  logic?:    'AND' | 'OR';       // how multiple where filters combine; default 'AND'
  limit?:    number;
  offset?:   number;
  orderBy?:  { field: string; direction: 'asc' | 'desc' };
}

interface QueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
  records: VaporRecord<T>[];
  total:   number;             // total before limit/offset
}
```

### Traversal types

```typescript
interface TraversalOptions {
  from:         string;                              // starting record ID
  relationship: string;                              // declared relationship type name
  direction?:   'outgoing' | 'incoming' | 'both';   // default: 'outgoing'
  depth?:       number;                              // max hops; default: 1
  filter?:      Omit<QueryOptions, 'limit' | 'offset' | 'orderBy'>;
}

interface TraversalEntry<T extends Record<string, unknown> = Record<string, unknown>> {
  record: VaporRecord<T>;
  depth:  number;         // number of hops from start
  via:    string[];       // IDs of nodes traversed to reach this record
}

interface TraversalResult<T extends Record<string, unknown> = Record<string, unknown>> {
  records: VaporRecord<T>[];
  entries: TraversalEntry<T>[];
}

interface PathOptions {
  from:          string;
  to:            string;
  relationship?: string;     // only follow edges of this type; omit = any type
  maxDepth?:     number;     // default: 10
}
```

### Stats and snapshots

```typescript
interface IndexStats {
  exactEntries:  number;  // entries in exact indexes
  keywordTokens: number;  // tokens in keyword inverted indexes
  prefixNodes:   number;  // nodes in prefix tries
  rangeEntries:  number;  // entries in range sorted arrays
}

interface VaporStats {
  totalRecords:        number;
  recordsByType:       Record<string, number>;
  totalRelationships:  number;
  relationshipsByType: Record<string, number>;
  indexStats:          IndexStats;
  memoryEstimateBytes: number;  // rough heuristic
}

interface VaporSnapshot {
  records:       VaporRecord[];
  relationships: VaporRelationship[];
  schema:        VaporSchema;
  _takenAt:      number;
  _schemaHash:   string;  // must match when restoring
}
```

### Error types

```typescript
class VaporError extends Error {}          // base class
class VaporSchemaError extends VaporError {}  // schema declaration or validation error
class VaporQueryError extends VaporError {}   // query filter error
class VaporDestroyedError extends VaporError {} // called after destroy()
```

---

## Instance methods

### `createVapor(schema: VaporSchema): VaporInstance`

Factory function. Validates schema at construction. Throws `VaporSchemaError` if
the schema is invalid (unknown field types, invalid strategies, undeclared
relationship target types).

---

### `store(type: string, data: Record<string, unknown>): string`

Store a record in RAM. Returns generated ID. Throws `VaporError` if type is not
declared. Throws `VaporSchemaError` if required fields are missing or field values
violate their declared types.

**ID format**: `vpr_<Date.now().toString(36)>_<counter.toString(36)>`

---

### `get<T>(id: string): VaporRecord<T> | null`

O(1) lookup by ID. Returns `null` if not found.

---

### `update(id: string, partial: Record<string, unknown>): void`

Update fields on an existing record. Only the provided fields are re-indexed. The
`_updatedAt` timestamp is updated. Throws `VaporError` if record does not exist.

---

### `delete(id: string): void`

Remove a record and all its relationship edges. Clears all index entries for the
record. Safe to call if the record does not exist (no-op).

---

### `relate(sourceId, relationshipType, targetId, metadata?): string`

Create a relationship edge. Validates:
- Both records exist
- The relationship type is declared on the source type
- The target type is permitted by the relationship definition
- Cardinality constraints are not violated

Returns the generated edge ID. For bidirectional relationships, also creates the
reverse edge automatically (the reverse edge has `_reverse: true` in its metadata).

**Edge ID format**: `vpe_<Date.now().toString(36)>_<counter.toString(36)>`

---

### `unrelate(edgeId: string): void`

Remove a relationship edge by ID. Safe to call if edge does not exist (no-op).

---

### `getRelationships(id, type?, direction?): VaporRelationship[]`

Get all relationship edges for a record. Optional filters:
- `type`: only edges of this relationship type
- `direction`: `'outgoing'` | `'incoming'` | `'both'` (default: `'both'`)

---

### `query<T>(options: QueryOptions): QueryResult<T>`

Execute a query. Multiple `where` filters combine with `logic` (default `'AND'`).
`keywords` free-text is AND-ed with `where` results.

Operators are validated against the declared index strategy at query time. Calling
`eq` on a `range`-indexed field throws `VaporQueryError`.

---

### `traverse<T>(options: TraversalOptions): TraversalResult<T>`

BFS traversal from a starting node. Respects the `direction` and `depth` limits.
Optional `filter` is applied at each hop to include/exclude nodes.

The starting node is never included in the results.

---

### `findPath(options: PathOptions): string[] | null`

BFS shortest path between two records. Returns an ordered array of record IDs
(including both start and end), or `null` if no path exists within `maxDepth`.

If `from === to`, returns `[from]`.

---

### `stats(): VaporStats`

Returns current memory and record statistics. The `memoryEstimateBytes` field is
a rough heuristic based on record counts and index sizes — not a precise
measurement.

---

### `snapshot(): VaporSnapshot`

Capture the full state as a plain object. Safe to `JSON.stringify`. Does not write
to disk.

---

### `restore(snapshot: VaporSnapshot): VaporInstance`

Return a **new** instance hydrated from a snapshot. The original instance is
unchanged. Throws `VaporError` if the snapshot's schema hash does not match the
current instance's schema hash.

New record IDs are generated during restore — the IDs in the snapshot are remapped
to new IDs in the fresh instance.

---

### `destroy(): void`

Release all references held by the index. After calling, all further method calls
throw `VaporDestroyedError`. Safe to call multiple times (subsequent calls are
no-ops).

---

## Index strategy reference

| Strategy  | Data structure             | Space per entry         | Best for                     |
|-----------|---------------------------|-------------------------|------------------------------|
| `none`    | None (stored only)        | 0 bytes                 | Display-only fields          |
| `exact`   | `HashMap<value, Set<id>>` | ~100 bytes              | Status, category, boolean    |
| `keyword` | Inverted index `Map<"field:token", Set<id>>` | ~80 bytes/token | Text, descriptions, labels |
| `prefix`  | Character trie            | ~120 bytes/node         | Paths, namespaces, prefixes  |
| `range`   | Sorted `(orderedBits, id)[]` | ~48 bytes/entry      | Numbers, coordinates, dates  |

The `range` index uses a sign-aware bit transformation (`f64_to_ordered_u64` in
Rust) to ensure correct ordering of negative numbers. All three implementations
(TypeScript, Python, Rust) handle negative floats correctly.

---

## Cardinality enforcement

| Cardinality    | What it enforces                                    |
|----------------|-----------------------------------------------------|
| `one-to-one`   | A source can have at most one outgoing edge of this type; a target can have at most one incoming edge of this type |
| `one-to-many`  | A source can have multiple outgoing edges of this type; a target can have at most one incoming edge (not currently enforced — treated as many-to-many) |
| `many-to-many` | No cardinality enforcement                          |

---

## Python-specific notes

The Python package uses dataclasses for all types:

```python
from vapor_idx import (
    VaporSchema, TypeDefinition, FieldDefinition, RelationshipDefinition,
    VaporRecord, VaporRelationship,
    QueryOptions, QueryResult, FieldFilter,
    TraversalOptions, TraversalResult, TraversalEntry,
    PathOptions, VaporStats, IndexStats, VaporSnapshot,
    VaporError, VaporSchemaError, VaporQueryError, VaporDestroyedError,
)
```

`QueryOptions` uses `order_by: tuple[str, Literal['asc', 'desc']]` instead of
`orderBy: { field, direction }`.

`TraversalOptions` uses `from_id` instead of `from` (Python keyword conflict).

`PathOptions` uses `from_id` and `to_id`.

The `create_vapor(schema_dict)` factory accepts plain Python dicts (same shape as
the TypeScript schema) and converts them to typed dataclasses internally.

---

## Rust-specific notes

`create_vapor(schema)` returns `VaporResult<VaporInstance>`. Use `.expect()` or
`?` to unwrap.

All query methods on `VaporInstance` take `&QueryOptions` (borrowed reference).

`QueryOptions` uses `..Default::default()` for fields not explicitly set.

The `range` index uses `f64_to_ordered_u64()` internally to convert floats to
ordered `u64` values for binary search. This is transparent to callers.

`VaporError` implements `std::error::Error` and `Display`.
