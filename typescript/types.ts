// =============================================================================
// vapor-idx — types.ts
// All public type declarations. This is the contract of the library.
// =============================================================================

// ── Field primitives ──────────────────────────────────────────────────────────

export type PrimitiveType = 'string' | 'number' | 'boolean';
export type FieldType     = PrimitiveType | 'string[]' | 'number[]';

/**
 * How a field is indexed in memory.
 *
 *   none     → stored but not indexed; only accessible via full scan
 *   exact    → equality / set-membership (eq / neq / in / notIn)
 *   keyword  → tokenised inverted index (contains / free-text search)
 *   prefix   → trie-based prefix match (startsWith)
 *   range    → sorted numeric array (gt / lt / gte / lte)
 *
 * A field may have at most one strategy. Choose based on your query patterns.
 */
export type IndexStrategy = 'none' | 'exact' | 'keyword' | 'prefix' | 'range';

// ── Schema declarations ───────────────────────────────────────────────────────

export interface FieldDefinition {
  /** Runtime type of the value stored for this field. */
  type:      FieldType;
  /** Index strategy. Must be declared explicitly — there is no default. */
  index:     IndexStrategy;
  /** When true, store() rejects records missing this field. */
  required?: boolean;
}

export interface RelationshipDefinition {
  /**
   * Types that are allowed as the target of this relationship.
   * Use ['*'] to allow any declared type.
   */
  targetTypes:  string[];
  /**
   * true  → directed (outgoing from source only)
   * false → bidirectional; relate() creates edges in both directions
   */
  directed:     boolean;
  cardinality: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

export interface TypeDefinition {
  fields:         Record<string, FieldDefinition>;
  relationships?: Record<string, RelationshipDefinition>;
}

/**
 * The schema you pass to createVapor().
 * Every type your skill uses must be declared here before storing records.
 */
export interface VaporSchema {
  types: Record<string, TypeDefinition>;
}

// ── Records ───────────────────────────────────────────────────────────────────

export interface VaporRecord<
  T extends Record<string, unknown> = Record<string, unknown>
> {
  readonly id:         string;
  readonly type:       string;
  readonly data:       Readonly<T>;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

// ── Relationships ─────────────────────────────────────────────────────────────

export interface VaporRelationship {
  readonly id:               string;
  readonly relationshipType: string;
  readonly sourceId:         string;
  readonly targetId:         string;
  readonly metadata:         Readonly<Record<string, unknown>>;
  readonly _createdAt:       number;
}

// ── Query DSL ─────────────────────────────────────────────────────────────────

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'startsWith'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte';

export interface FieldFilter {
  field: string;
  op:    FilterOp;
  value: unknown;
}

export interface QueryOptions {
  /** Restrict results to one or more declared types. */
  type?:     string | string[];
  /**
   * One or more field filters.
   * When an array, filters combine via `logic` (default: AND).
   */
  where?:    FieldFilter | FieldFilter[];
  /**
   * Free-text keyword search across all keyword-indexed fields.
   * Multiple tokens are AND-ed: every token must appear somewhere in the record.
   */
  keywords?: string | string[];
  /** How multiple where filters combine. Default: 'AND'. */
  logic?:    'AND' | 'OR';
  limit?:    number;
  offset?:   number;
  orderBy?:  { field: string; direction: 'asc' | 'desc' };
}

export interface TraversalOptions {
  /** Starting record ID. */
  from:         string;
  /** Declared relationship type name to follow. */
  relationship: string;
  /** Which direction to follow edges. Default: 'outgoing'. */
  direction?:   'outgoing' | 'incoming' | 'both';
  /** Maximum number of hops from the start node. Default: 1. */
  depth?:       number;
  /** Optional query filter applied to each node encountered during traversal. */
  filter?:      Omit<QueryOptions, 'limit' | 'offset' | 'orderBy'>;
}

export interface PathOptions {
  from:          string;
  to:            string;
  /** Only follow edges of this relationship type. Omit to allow any. */
  relationship?: string;
  /** Maximum path length in hops. Default: 10. */
  maxDepth?:     number;
}

// ── Results ───────────────────────────────────────────────────────────────────

export interface QueryResult<
  T extends Record<string, unknown> = Record<string, unknown>
> {
  records: VaporRecord<T>[];
  total:   number;
}

export interface TraversalEntry<
  T extends Record<string, unknown> = Record<string, unknown>
> {
  record: VaporRecord<T>;
  depth:  number;
  /** IDs of nodes traversed to reach this record (not including this record). */
  via:    string[];
}

export interface TraversalResult<
  T extends Record<string, unknown> = Record<string, unknown>
> {
  records: VaporRecord<T>[];
  entries: TraversalEntry<T>[];
}

// ── Stats & snapshots ─────────────────────────────────────────────────────────

export interface IndexStats {
  exactEntries:   number;
  keywordTokens:  number;
  prefixNodes:    number;
  rangeEntries:   number;
}

export interface VaporStats {
  totalRecords:        number;
  recordsByType:       Record<string, number>;
  totalRelationships:  number;
  relationshipsByType: Record<string, number>;
  indexStats:          IndexStats;
  memoryEstimateBytes: number;
}

export interface VaporSnapshot {
  records:       VaporRecord[];
  relationships: VaporRelationship[];
  schema:        VaporSchema;
  _takenAt:      number;
  _schemaHash:   string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class VaporError extends Error {
  constructor(message: string) {
    super(`[vapor-idx] ${message}`);
    this.name = 'VaporError';
  }
}

export class VaporSchemaError extends VaporError {
  constructor(message: string) {
    super(message);
    this.name = 'VaporSchemaError';
  }
}

export class VaporQueryError extends VaporError {
  constructor(message: string) {
    super(message);
    this.name = 'VaporQueryError';
  }
}

export class VaporDestroyedError extends VaporError {
  constructor() {
    super('This VaporInstance has been destroyed. Create a new instance.');
    this.name = 'VaporDestroyedError';
  }
}
