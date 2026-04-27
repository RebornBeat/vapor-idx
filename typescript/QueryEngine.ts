// =============================================================================
// vapor-idx — QueryEngine.ts
// Executes queries against RecordStore indexes.
// Handles type filtering, field filters (by index strategy), keyword search,
// AND/OR logic, ordering, limit, and offset.
// =============================================================================

import {
  VaporRecord,
  QueryOptions,
  QueryResult,
  FieldFilter,
  FilterOp,
  VaporQueryError,
} from './types.js';
import { RecordStore }   from './RecordStore.js';
import { validateFilter } from './SchemaValidator.js';

// Ops that read from the range index for numeric ordering support
const RANGE_OPS = new Set<FilterOp>(['gt', 'lt', 'gte', 'lte']);

export class QueryEngine {
  constructor(private readonly store: RecordStore) {}

  query<T extends Record<string, unknown>>(options: QueryOptions): QueryResult<T> {
    const types = resolveTypes(options.type, this.store.getTypes());

    // 1. Start with candidate ID sets per type, then union
    let candidateIds: Set<string> | null = null;

    for (const typeName of types) {
      const typeDef   = this.store['schema'].types[typeName];
      const typeIdSet = new Set(this.store.getTypeIdSet(typeName));

      if (typeIdSet.size === 0) continue;

      // Apply where filters for this type
      const filters = normaliseFilters(options.where);

      // Validate filters against the type
      for (const filter of filters) {
        validateFilter(filter, typeName, typeDef);
      }

      const filtered = this.applyFilters(typeName, typeIdSet, filters, options.logic ?? 'AND');

      // Apply keywords
      const afterKeywords = this.applyKeywords(typeName, filtered, options.keywords);

      // Merge across types
      if (candidateIds === null) {
        candidateIds = afterKeywords;
      } else {
        for (const id of afterKeywords) candidateIds.add(id);
      }
    }

    if (candidateIds === null || candidateIds.size === 0) {
      return { records: [], total: 0 };
    }

    // 2. Hydrate records
    let records = [...candidateIds]
      .map(id => this.store.get(id))
      .filter((r): r is VaporRecord<T> => r !== null) as VaporRecord<T>[];

    // 3. Apply orderBy
    if (options.orderBy) {
      records = sortRecords(records, options.orderBy.field, options.orderBy.direction);
    }

    const total = records.length;

    // 4. Apply offset and limit
    const offset = options.offset ?? 0;
    const limit  = options.limit;

    records = records.slice(offset, limit !== undefined ? offset + limit : undefined);

    return { records, total };
  }

  // ── Filter application ─────────────────────────────────────────────────────

  private applyFilters(
    typeName:  string,
    seed:      Set<string>,
    filters:   FieldFilter[],
    logic:     'AND' | 'OR'
  ): Set<string> {
    if (filters.length === 0) return seed;

    const ti = this.store.getIndexes(typeName)!;

    if (logic === 'AND') {
      let current = seed;
      for (const filter of filters) {
        const matched = this.applyFilter(filter, typeName);
        current       = intersection(current, matched);
        if (current.size === 0) break;
      }
      return current;
    } else {
      // OR: union results of each filter, then intersect with seed
      const unionResult = new Set<string>();
      for (const filter of filters) {
        const matched = this.applyFilter(filter, typeName);
        for (const id of matched) {
          if (seed.has(id)) unionResult.add(id);
        }
      }
      return unionResult;
    }
  }

  private applyFilter(filter: FieldFilter, typeName: string): Set<string> {
    const ti = this.store.getIndexes(typeName)!;
    const { field, op, value } = filter;

    switch (op as FilterOp) {
      case 'eq':         return ti.exact.eq(field, value);
      case 'neq':        return ti.exact.neq(field, value);
      case 'in':         return ti.exact.findIn(field, value as unknown[]);
      case 'notIn':      return ti.exact.notIn(field, value as unknown[]);
      case 'contains':   return ti.keyword.contains(field, value as string);
      case 'startsWith': return ti.prefix.startsWith(field, value as string);
      case 'gt':         return ti.range.gt(field, value as number);
      case 'lt':         return ti.range.lt(field, value as number);
      case 'gte':        return ti.range.gte(field, value as number);
      case 'lte':        return ti.range.lte(field, value as number);
      default:
        throw new VaporQueryError(`Unknown filter operator "${op}".`);
    }
  }

  private applyKeywords(
    typeName: string,
    seed:     Set<string>,
    keywords: string | string[] | undefined
  ): Set<string> {
    if (!keywords || (Array.isArray(keywords) && keywords.length === 0)) return seed;

    const ti      = this.store.getIndexes(typeName)!;
    const matched = ti.keyword.search(keywords);
    return intersection(seed, matched);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveTypes(
  typeOption: string | string[] | undefined,
  allTypes:   string[]
): string[] {
  if (typeOption === undefined) return allTypes;
  if (Array.isArray(typeOption)) return typeOption;
  return [typeOption];
}

function normaliseFilters(where: QueryOptions['where']): FieldFilter[] {
  if (!where) return [];
  if (Array.isArray(where)) return where;
  return [where];
}

function intersection(a: Set<string>, b: Set<string>): Set<string> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const result         = new Set<string>();
  for (const id of small) {
    if (large.has(id)) result.add(id);
  }
  return result;
}

function sortRecords<T extends Record<string, unknown>>(
  records:   VaporRecord<T>[],
  field:     string,
  direction: 'asc' | 'desc'
): VaporRecord<T>[] {
  return [...records].sort((a, b) => {
    const av = a.data[field] as string | number | boolean | null | undefined;
    const bv = b.data[field] as string | number | boolean | null | undefined;

    if (av === null || av === undefined) return direction === 'asc' ? 1 : -1;
    if (bv === null || bv === undefined) return direction === 'asc' ? -1 : 1;

    if (typeof av === 'number' && typeof bv === 'number') {
      return direction === 'asc' ? av - bv : bv - av;
    }

    const as = String(av).toLowerCase();
    const bs = String(bv).toLowerCase();
    const cmp = as < bs ? -1 : as > bs ? 1 : 0;
    return direction === 'asc' ? cmp : -cmp;
  });
}
