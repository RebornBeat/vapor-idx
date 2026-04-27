// =============================================================================
// vapor-idx — VaporInstance.ts
// The single entry point for all skill interactions with the index.
// Composes RecordStore, RelationshipStore, QueryEngine, and TraversalEngine.
// =============================================================================

import {
  VaporSchema,
  VaporRecord,
  VaporRelationship,
  QueryOptions,
  QueryResult,
  TraversalOptions,
  TraversalResult,
  PathOptions,
  VaporStats,
  VaporSnapshot,
  VaporDestroyedError,
  VaporError,
} from './types.js';
import { validateSchema, hashSchema } from './SchemaValidator.js';
import { RecordStore }                from './RecordStore.js';
import { RelationshipStore }          from './RelationshipStore.js';
import { QueryEngine }                from './QueryEngine.js';
import { TraversalEngine }            from './TraversalEngine.js';

export class VaporInstance {
  private readonly schema:        VaporSchema;
  private readonly schemaHash:    string;
  private readonly recordStore:   RecordStore;
  private readonly relStore:      RelationshipStore;
  private readonly queryEngine:   QueryEngine;
  private readonly traversal:     TraversalEngine;

  private destroyed = false;

  constructor(schema: VaporSchema) {
    validateSchema(schema);

    this.schema      = schema;
    this.schemaHash  = hashSchema(schema);

    this.recordStore  = new RecordStore(schema);
    this.relStore     = new RelationshipStore(schema);
    this.queryEngine  = new QueryEngine(this.recordStore);
    this.traversal    = new TraversalEngine(this.recordStore, this.relStore, this.queryEngine);
  }

  // ── Record CRUD ────────────────────────────────────────────────────────────

  /**
   * Store a new record of the given type.
   * Returns the generated record ID.
   */
  store(type: string, data: Record<string, unknown>): string {
    this.assertAlive();
    return this.recordStore.store(type, data);
  }

  /**
   * Retrieve a record by ID.
   * Returns null if not found.
   */
  get<T extends Record<string, unknown>>(id: string): VaporRecord<T> | null {
    this.assertAlive();
    return this.recordStore.get(id) as VaporRecord<T> | null;
  }

  /**
   * Update fields on an existing record.
   * Only the fields provided in `partial` are updated and re-indexed.
   */
  update(id: string, partial: Record<string, unknown>): void {
    this.assertAlive();
    this.recordStore.update(id, partial);
  }

  /**
   * Delete a record and all its relationship edges.
   */
  delete(id: string): void {
    this.assertAlive();
    this.relStore.removeForRecord(id);
    this.recordStore.delete(id);
  }

  // ── Relationships ──────────────────────────────────────────────────────────

  /**
   * Create a relationship edge from sourceId to targetId.
   * The relationship type must be declared on the source record's type.
   * Returns the edge ID.
   */
  relate(
    sourceId:         string,
    relationshipType: string,
    targetId:         string,
    metadata?:        Record<string, unknown>
  ): string {
    this.assertAlive();

    const source = this.recordStore.get(sourceId);
    if (source === null) throw new VaporError(`Source record "${sourceId}" does not exist.`);

    const target = this.recordStore.get(targetId);
    if (target === null) throw new VaporError(`Target record "${targetId}" does not exist.`);

    return this.relStore.relate(
      sourceId,
      source.type,
      relationshipType,
      targetId,
      target.type,
      metadata ?? {}
    );
  }

  /**
   * Remove a relationship edge by its edge ID.
   */
  unrelate(edgeId: string): void {
    this.assertAlive();
    this.relStore.unrelate(edgeId);
  }

  /**
   * Get all relationship edges for a record, optionally filtered by type and direction.
   */
  getRelationships(
    id:              string,
    relationshipType?: string,
    direction?:      'outgoing' | 'incoming' | 'both'
  ): VaporRelationship[] {
    this.assertAlive();
    return this.relStore.getEdgesForRecord(id, relationshipType, direction);
  }

  // ── Querying ───────────────────────────────────────────────────────────────

  /**
   * Execute a structured query against the index.
   */
  query<T extends Record<string, unknown>>(options: QueryOptions): QueryResult<T> {
    this.assertAlive();
    return this.queryEngine.query<T>(options);
  }

  // ── Traversal ──────────────────────────────────────────────────────────────

  /**
   * BFS traversal following relationship edges from a starting node.
   */
  traverse<T extends Record<string, unknown>>(options: TraversalOptions): TraversalResult<T> {
    this.assertAlive();
    return this.traversal.traverse<T>(options);
  }

  /**
   * Find the shortest path between two records via relationship edges.
   * Returns an ordered array of record IDs, or null if no path exists.
   */
  findPath(options: PathOptions): string[] | null {
    this.assertAlive();
    return this.traversal.findPath(options);
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /**
   * Returns memory and record statistics for this instance.
   */
  stats(): VaporStats {
    this.assertAlive();
    const is = this.recordStore.indexStats;
    return {
      totalRecords:        this.recordStore.totalRecords,
      recordsByType:       this.recordStore.recordCountsByType,
      totalRelationships:  this.relStore.totalEdges,
      relationshipsByType: this.relStore.edgeCountsByType,
      indexStats:          is,
      memoryEstimateBytes: estimateMemory(
        this.recordStore.totalRecords,
        this.relStore.totalEdges,
        is.exactEntries,
        is.keywordTokens,
        is.prefixNodes,
        is.rangeEntries
      ),
    };
  }

  // ── Snapshot / restore ─────────────────────────────────────────────────────

  /**
   * Capture the full index state as a serialisable snapshot.
   * Does not write to disk — that is the caller's responsibility.
   */
  snapshot(): VaporSnapshot {
    this.assertAlive();
    return {
      records:       this.recordStore.getAll(),
      relationships: this.relStore.getAll(),
      schema:        this.schema,
      _takenAt:      Date.now(),
      _schemaHash:   this.schemaHash,
    };
  }

  /**
   * Returns a new VaporInstance hydrated from a snapshot.
   * The snapshot must have been taken from an instance with the same schema hash.
   * The current instance is not modified.
   */
  restore(snapshot: VaporSnapshot): VaporInstance {
    this.assertAlive();

    if (snapshot._schemaHash !== this.schemaHash) {
      throw new VaporError(
        'Cannot restore snapshot: schema hash mismatch. ' +
        'The snapshot was taken from an instance with a different schema.'
      );
    }

    const fresh = new VaporInstance(this.schema);

    // Restore records in creation order
    const sorted = [...snapshot.records].sort((a, b) => a._createdAt - b._createdAt);

    // We need to remap old IDs → new IDs
    const idMap = new Map<string, string>();

    for (const record of sorted) {
      const newId = fresh.store(record.type, record.data as Record<string, unknown>);
      idMap.set(record.id, newId);
    }

    // Restore relationships
    for (const edge of snapshot.relationships) {
      // Skip reverse edges from bidirectional relationships (they are re-created automatically)
      if ((edge.metadata as Record<string, unknown>)['_reverse'] === true) continue;

      const newSource = idMap.get(edge.sourceId);
      const newTarget = idMap.get(edge.targetId);

      if (newSource && newTarget) {
        const { _reverse: _r, ...cleanMeta } = edge.metadata as Record<string, unknown>;
        fresh.relate(newSource, edge.relationshipType, newTarget, cleanMeta);
      }
    }

    return fresh;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Explicitly release all references held by this index.
   * All subsequent calls on this instance throw VaporDestroyedError.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.recordStore.clear();
    this.relStore.clear();
    this.destroyed = true;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this.destroyed) throw new VaporDestroyedError();
  }
}

// ── Memory estimate ───────────────────────────────────────────────────────────

/**
 * Very rough heuristic. JavaScript object overhead is environment-dependent.
 * This gives a ballpark to help skill authors reason about RAM budgets.
 */
function estimateMemory(
  records:        number,
  relationships:  number,
  exactEntries:   number,
  keywordTokens:  number,
  prefixNodes:    number,
  rangeEntries:   number
): number {
  // ~500 bytes per record (object overhead + frozen data copy)
  // ~200 bytes per relationship edge
  // ~100 bytes per exact index entry
  // ~80  bytes per keyword token
  // ~120 bytes per trie node
  // ~48  bytes per range entry
  return (
    records       * 500  +
    relationships * 200  +
    exactEntries  * 100  +
    keywordTokens * 80   +
    prefixNodes   * 120  +
    rangeEntries  * 48
  );
}
