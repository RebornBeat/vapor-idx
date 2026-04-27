// =============================================================================
// vapor-idx — RecordStore.ts
// Primary record storage and per-type index management.
// Owns all four index types; routes field writes to the correct index.
// =============================================================================

import { VaporRecord, VaporSchema, TypeDefinition, IndexStrategy, VaporError } from './types.js';
import { validateRecordData }   from './SchemaValidator.js';
import { ExactIndex }           from './indexes/ExactIndex.js';
import { KeywordIndex }         from './indexes/KeywordIndex.js';
import { PrefixIndex }          from './indexes/PrefixIndex.js';
import { RangeIndex }           from './indexes/RangeIndex.js';

// ── Per-type index bundle ─────────────────────────────────────────────────────

interface TypeIndexes {
  exact:   ExactIndex;
  keyword: KeywordIndex;
  prefix:  PrefixIndex;
  range:   RangeIndex;
  /** fieldName → IndexStrategy — derived from schema for fast routing */
  strategies: Map<string, IndexStrategy>;
}

// ── RecordStore ───────────────────────────────────────────────────────────────

export class RecordStore {
  // id → record
  private readonly records:    Map<string, VaporRecord> = new Map();
  // typeName → [id, ...]
  private readonly byType:     Map<string, Set<string>> = new Map();
  // typeName → TypeIndexes
  private readonly typeIndexes: Map<string, TypeIndexes> = new Map();

  private idCounter = 0;

  constructor(private readonly schema: VaporSchema) {
    this.initialiseTypeIndexes();
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  private initialiseTypeIndexes(): void {
    for (const [typeName, typeDef] of Object.entries(this.schema.types)) {
      this.typeIndexes.set(typeName, buildTypeIndexes(typeDef));
      this.byType.set(typeName, new Set());
    }
  }

  // ── Mutation ───────────────────────────────────────────────────────────────

  store(typeName: string, data: Record<string, unknown>): string {
    const typeDef = this.schema.types[typeName];
    if (typeDef === undefined) {
      throw new VaporError(`Unknown type "${typeName}". Declare it in the schema before storing records.`);
    }

    validateRecordData(typeName, typeDef, data);

    const id  = this.nextId();
    const now = Date.now();

    const record: VaporRecord = {
      id,
      type:       typeName,
      data:       Object.freeze({ ...data }),
      _createdAt: now,
      _updatedAt: now,
    };

    this.records.set(id, record);
    this.byType.get(typeName)!.add(id);
    this.indexRecord(typeName, id, data);

    return id;
  }

  update(id: string, partial: Record<string, unknown>): void {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new VaporError(`Record "${id}" does not exist.`);
    }

    const typeName = record.type;
    const typeDef  = this.schema.types[typeName]!;

    // Validate just the fields being updated
    validateRecordData(typeName, typeDef, { ...record.data, ...partial });

    // Remove old index entries for changed fields
    this.unindexFields(typeName, id, record.data as Record<string, unknown>, Object.keys(partial));

    const updatedData = Object.freeze({ ...record.data, ...partial });

    const updatedRecord: VaporRecord = {
      id,
      type:       typeName,
      data:       updatedData,
      _createdAt: record._createdAt,
      _updatedAt: Date.now(),
    };

    this.records.set(id, updatedRecord);

    // Re-index changed fields
    this.indexFields(typeName, id, updatedData as Record<string, unknown>, Object.keys(partial));
  }

  delete(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;

    this.unindexRecord(record.type, id, record.data as Record<string, unknown>);
    this.byType.get(record.type)?.delete(id);
    this.records.delete(id);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  get(id: string): VaporRecord | null {
    return this.records.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  getAll(): VaporRecord[] {
    return [...this.records.values()];
  }

  getAllByType(typeName: string): VaporRecord[] {
    const ids = this.byType.get(typeName);
    if (ids === undefined) return [];
    return [...ids].map(id => this.records.get(id)!).filter(Boolean);
  }

  getTypeIdSet(typeName: string): ReadonlySet<string> {
    return this.byType.get(typeName) ?? EMPTY_SET;
  }

  getIndexes(typeName: string): TypeIndexes | undefined {
    return this.typeIndexes.get(typeName);
  }

  /** Returns all declared type names */
  getTypes(): string[] {
    return [...this.byType.keys()];
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  private indexRecord(typeName: string, id: string, data: Record<string, unknown>): void {
    this.indexFields(typeName, id, data, Object.keys(data));
  }

  private indexFields(typeName: string, id: string, data: Record<string, unknown>, fields: string[]): void {
    const ti = this.typeIndexes.get(typeName)!;
    for (const fieldName of fields) {
      const value    = data[fieldName];
      const strategy = ti.strategies.get(fieldName);
      if (strategy === undefined || strategy === 'none') continue;

      switch (strategy) {
        case 'exact':   ti.exact.add(fieldName, value, id);   break;
        case 'keyword': ti.keyword.add(fieldName, value, id); break;
        case 'prefix':  ti.prefix.add(fieldName, value, id);  break;
        case 'range':   ti.range.add(fieldName, value, id);   break;
      }
    }
  }

  private unindexRecord(typeName: string, id: string, data: Record<string, unknown>): void {
    this.unindexFields(typeName, id, data, Object.keys(data));
  }

  private unindexFields(typeName: string, id: string, data: Record<string, unknown>, fields: string[]): void {
    const ti = this.typeIndexes.get(typeName)!;
    for (const fieldName of fields) {
      const value    = data[fieldName];
      const strategy = ti.strategies.get(fieldName);
      if (strategy === undefined || strategy === 'none') continue;

      switch (strategy) {
        case 'exact':   ti.exact.remove(fieldName, value, id);   break;
        case 'keyword': ti.keyword.remove(id);                    break;
        case 'prefix':  ti.prefix.remove(fieldName, value, id);  break;
        case 'range':   ti.range.remove(fieldName, value, id);   break;
      }
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  get totalRecords(): number {
    return this.records.size;
  }

  get recordCountsByType(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [type, ids] of this.byType) result[type] = ids.size;
    return result;
  }

  get indexStats(): { exactEntries: number; keywordTokens: number; prefixNodes: number; rangeEntries: number } {
    let exactEntries  = 0;
    let keywordTokens = 0;
    let prefixNodes   = 0;
    let rangeEntries  = 0;

    for (const ti of this.typeIndexes.values()) {
      exactEntries  += ti.exact.entryCount;
      keywordTokens += ti.keyword.tokenCount;
      prefixNodes   += ti.prefix.nodeCount;
      rangeEntries  += ti.range.entryCount;
    }

    return { exactEntries, keywordTokens, prefixNodes, rangeEntries };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  clear(): void {
    this.records.clear();
    for (const ti of this.typeIndexes.values()) {
      ti.exact.clear();
      ti.keyword.clear();
      ti.prefix.clear();
      ti.range.clear();
    }
    for (const ids of this.byType.values()) ids.clear();
  }

  // ── ID generation ──────────────────────────────────────────────────────────

  private nextId(): string {
    return `vpr_${Date.now().toString(36)}_${(++this.idCounter).toString(36)}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTypeIndexes(typeDef: TypeDefinition): TypeIndexes {
  const strategies = new Map<string, IndexStrategy>();
  for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
    strategies.set(fieldName, fieldDef.index);
  }
  return {
    exact:   new ExactIndex(),
    keyword: new KeywordIndex(),
    prefix:  new PrefixIndex(),
    range:   new RangeIndex(),
    strategies,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();
