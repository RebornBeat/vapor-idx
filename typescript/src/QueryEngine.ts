// =============================================================================
// vapor-idx — QueryEngine.ts
// FIX: uses store.schema (via public getter) instead of store['schema']
//      (bracket-notation bypass of TypeScript private access control).
// =============================================================================

import {
  VaporRecord,
  QueryOptions,
  QueryResult,
  FieldFilter,
  FilterOp,
  VaporQueryError,
} from "./types.js";
import { RecordStore } from "./RecordStore.js";
import { validateFilter } from "./SchemaValidator.js";

export class QueryEngine {
  constructor(private readonly store: RecordStore) {}

  query<T extends Record<string, unknown>>(
    options: QueryOptions,
  ): QueryResult<T> {
    const types = resolveTypes(options.type, this.store.getTypes());
    let candidateIds: Set<string> | null = null;

    for (const typeName of types) {
      const typeDef = this.store.schema.types[typeName]; // via public getter
      const typeIdSet = new Set(this.store.getTypeIdSet(typeName));
      if (typeIdSet.size === 0) continue;

      const filters = normaliseFilters(options.where);
      for (const filter of filters) {
        validateFilter(filter, typeName, typeDef);
      }

      const filtered = this.applyFilters(
        typeName,
        typeIdSet,
        filters,
        options.logic ?? "AND",
      );
      const afterKeywords = this.applyKeywords(
        typeName,
        filtered,
        options.keywords,
      );

      if (candidateIds === null) {
        candidateIds = afterKeywords;
      } else {
        for (const id of afterKeywords) candidateIds.add(id);
      }
    }

    if (candidateIds === null || candidateIds.size === 0)
      return { records: [], total: 0 };

    let records = [...candidateIds]
      .map((id) => this.store.get(id))
      .filter((r): r is VaporRecord<T> => r !== null) as VaporRecord<T>[];

    if (options.orderBy) {
      records = sortRecords(
        records,
        options.orderBy.field,
        options.orderBy.direction,
      );
    }

    const total = records.length;
    const offset = options.offset ?? 0;
    const limit = options.limit;
    records = records.slice(
      offset,
      limit !== undefined ? offset + limit : undefined,
    );
    return { records, total };
  }

  private applyFilters(
    typeName: string,
    seed: Set<string>,
    filters: FieldFilter[],
    logic: "AND" | "OR",
  ): Set<string> {
    if (filters.length === 0) return seed;
    if (logic === "AND") {
      let current = seed;
      for (const filter of filters) {
        current = intersection(current, this.applyFilter(filter, typeName));
        if (current.size === 0) break;
      }
      return current;
    } else {
      const union = new Set<string>();
      for (const filter of filters) {
        for (const id of this.applyFilter(filter, typeName)) {
          if (seed.has(id)) union.add(id);
        }
      }
      return union;
    }
  }

  private applyFilter(filter: FieldFilter, typeName: string): Set<string> {
    const ti = this.store.getIndexes(typeName)!;
    const { field, op, value } = filter;
    switch (op as FilterOp) {
      case "eq":
        return ti.exact.eq(field, value);
      case "neq":
        return ti.exact.neq(field, value);
      case "in":
        return ti.exact.findIn(field, value as unknown[]);
      case "notIn":
        return ti.exact.notIn(field, value as unknown[]);
      case "contains":
        return ti.keyword.contains(field, value as string);
      case "startsWith":
        return ti.prefix.startsWith(field, value as string);
      case "gt":
        return ti.range.gt(field, value as number);
      case "lt":
        return ti.range.lt(field, value as number);
      case "gte":
        return ti.range.gte(field, value as number);
      case "lte":
        return ti.range.lte(field, value as number);
      default:
        throw new VaporQueryError(`Unknown filter operator "${op}".`);
    }
  }

  private applyKeywords(
    typeName: string,
    seed: Set<string>,
    keywords: string | string[] | undefined,
  ): Set<string> {
    if (!keywords || (Array.isArray(keywords) && keywords.length === 0))
      return seed;
    return intersection(
      seed,
      this.store.getIndexes(typeName)!.keyword.search(keywords),
    );
  }
}

function resolveTypes(
  t: string | string[] | undefined,
  all: string[],
): string[] {
  if (t === undefined) return all;
  return Array.isArray(t) ? t : [t];
}

function normaliseFilters(where: QueryOptions["where"]): FieldFilter[] {
  if (!where) return [];
  return Array.isArray(where) ? where : [where];
}

function intersection(a: Set<string>, b: Set<string>): Set<string> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const result = new Set<string>();
  for (const id of small) {
    if (large.has(id)) result.add(id);
  }
  return result;
}

function sortRecords<T extends Record<string, unknown>>(
  records: VaporRecord<T>[],
  field: string,
  direction: "asc" | "desc",
): VaporRecord<T>[] {
  return [...records].sort((a, b) => {
    const av = a.data[field] as string | number | boolean | null | undefined;
    const bv = b.data[field] as string | number | boolean | null | undefined;
    if (av == null) return direction === "asc" ? 1 : -1;
    if (bv == null) return direction === "asc" ? -1 : 1;
    if (typeof av === "number" && typeof bv === "number")
      return direction === "asc" ? av - bv : bv - av;
    const cmp =
      String(av).toLowerCase() < String(bv).toLowerCase()
        ? -1
        : String(av).toLowerCase() > String(bv).toLowerCase()
          ? 1
          : 0;
    return direction === "asc" ? cmp : -cmp;
  });
}
