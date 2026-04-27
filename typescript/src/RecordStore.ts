// =============================================================================
// vapor-idx — RecordStore.ts
// FIX: renamed private field to _schema and added public `get schema()` getter.
//      QueryEngine accessed schema via this.store['schema'] bracket notation
//      (a TypeScript private-access hack). The getter is the correct approach.
// =============================================================================

import {
  VaporRecord,
  VaporSchema,
  TypeDefinition,
  IndexStrategy,
  VaporError,
} from "./types.js";
import { validateRecordData } from "./SchemaValidator.js";
import { ExactIndex } from "./indexes/ExactIndex.js";
import { KeywordIndex } from "./indexes/KeywordIndex.js";
import { PrefixIndex } from "./indexes/PrefixIndex.js";
import { RangeIndex } from "./indexes/RangeIndex.js";

interface TypeIndexes {
  exact: ExactIndex;
  keyword: KeywordIndex;
  prefix: PrefixIndex;
  range: RangeIndex;
  strategies: Map<string, IndexStrategy>;
}

export class RecordStore {
  private readonly records: Map<string, VaporRecord> = new Map();
  private readonly byType: Map<string, Set<string>> = new Map();
  private readonly typeIndexes: Map<string, TypeIndexes> = new Map();
  private idCounter = 0;

  // _schema is private storage; `get schema()` exposes it read-only to engines.
  private readonly _schema: VaporSchema;

  constructor(schema: VaporSchema) {
    this._schema = schema;
    this.initialiseTypeIndexes();
  }

  get schema(): VaporSchema {
    return this._schema;
  }

  private initialiseTypeIndexes(): void {
    for (const [typeName, typeDef] of Object.entries(this._schema.types)) {
      this.typeIndexes.set(typeName, buildTypeIndexes(typeDef));
      this.byType.set(typeName, new Set());
    }
  }

  store(typeName: string, data: Record<string, unknown>): string {
    const typeDef = this._schema.types[typeName];
    if (typeDef === undefined) {
      throw new VaporError(
        `Unknown type "${typeName}". Declare it in the schema before storing records.`,
      );
    }
    validateRecordData(typeName, typeDef, data);
    const id = this.nextId();
    const now = Date.now();
    const record: VaporRecord = {
      id,
      type: typeName,
      data: Object.freeze({ ...data }),
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
    if (record === undefined)
      throw new VaporError(`Record "${id}" does not exist.`);
    const typeName = record.type;
    const typeDef = this._schema.types[typeName]!;
    validateRecordData(typeName, typeDef, { ...record.data, ...partial });
    this.unindexFields(
      typeName,
      id,
      record.data as Record<string, unknown>,
      Object.keys(partial),
    );
    const updatedData = Object.freeze({ ...record.data, ...partial });
    this.records.set(id, {
      id,
      type: typeName,
      data: updatedData,
      _createdAt: record._createdAt,
      _updatedAt: Date.now(),
    });
    this.indexFields(
      typeName,
      id,
      updatedData as Record<string, unknown>,
      Object.keys(partial),
    );
  }

  delete(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.unindexRecord(record.type, id, record.data as Record<string, unknown>);
    this.byType.get(record.type)?.delete(id);
    this.records.delete(id);
  }

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
    return [...ids].map((id) => this.records.get(id)!).filter(Boolean);
  }

  getTypeIdSet(typeName: string): ReadonlySet<string> {
    return this.byType.get(typeName) ?? EMPTY_SET;
  }

  getIndexes(typeName: string): TypeIndexes | undefined {
    return this.typeIndexes.get(typeName);
  }

  getTypes(): string[] {
    return [...this.byType.keys()];
  }

  private indexRecord(
    typeName: string,
    id: string,
    data: Record<string, unknown>,
  ): void {
    this.indexFields(typeName, id, data, Object.keys(data));
  }

  private indexFields(
    typeName: string,
    id: string,
    data: Record<string, unknown>,
    fields: string[],
  ): void {
    const ti = this.typeIndexes.get(typeName)!;
    for (const fieldName of fields) {
      const value = data[fieldName];
      const strategy = ti.strategies.get(fieldName);
      if (strategy === undefined || strategy === "none") continue;
      switch (strategy) {
        case "exact":
          ti.exact.add(fieldName, value, id);
          break;
        case "keyword":
          ti.keyword.add(fieldName, value, id);
          break;
        case "prefix":
          ti.prefix.add(fieldName, value, id);
          break;
        case "range":
          ti.range.add(fieldName, value, id);
          break;
      }
    }
  }

  private unindexRecord(
    typeName: string,
    id: string,
    data: Record<string, unknown>,
  ): void {
    this.unindexFields(typeName, id, data, Object.keys(data));
  }

  private unindexFields(
    typeName: string,
    id: string,
    data: Record<string, unknown>,
    fields: string[],
  ): void {
    const ti = this.typeIndexes.get(typeName)!;
    for (const fieldName of fields) {
      const value = data[fieldName];
      const strategy = ti.strategies.get(fieldName);
      if (strategy === undefined || strategy === "none") continue;
      switch (strategy) {
        case "exact":
          ti.exact.remove(fieldName, value, id);
          break;
        case "keyword":
          ti.keyword.remove(id);
          break;
        case "prefix":
          ti.prefix.remove(fieldName, value, id);
          break;
        case "range":
          ti.range.remove(fieldName, value, id);
          break;
      }
    }
  }

  get totalRecords(): number {
    return this.records.size;
  }

  get recordCountsByType(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [type, ids] of this.byType) result[type] = ids.size;
    return result;
  }

  get indexStats() {
    let exactEntries = 0,
      keywordTokens = 0,
      prefixNodes = 0,
      rangeEntries = 0;
    for (const ti of this.typeIndexes.values()) {
      exactEntries += ti.exact.entryCount;
      keywordTokens += ti.keyword.tokenCount;
      prefixNodes += ti.prefix.nodeCount;
      rangeEntries += ti.range.entryCount;
    }
    return { exactEntries, keywordTokens, prefixNodes, rangeEntries };
  }

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

  private nextId(): string {
    return `vpr_${Date.now().toString(36)}_${(++this.idCounter).toString(36)}`;
  }
}

function buildTypeIndexes(typeDef: TypeDefinition): TypeIndexes {
  const strategies = new Map<string, IndexStrategy>();
  for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
    strategies.set(fieldName, fieldDef.index);
  }
  return {
    exact: new ExactIndex(),
    keyword: new KeywordIndex(),
    prefix: new PrefixIndex(),
    range: new RangeIndex(),
    strategies,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();
