// =============================================================================
// vapor-idx — indexes/ExactIndex.ts
// Equality index: field → normalisedValue → Set<recordId>
// Supports: eq, neq, in, notIn
// =============================================================================

const EMPTY_SET: ReadonlySet<string> = new Set();

export class ExactIndex {
  // field → normalisedValue → Set<id>
  private readonly index: Map<string, Map<string, Set<string>>> = new Map();

  // ── Mutation ───────────────────────────────────────────────────────────────

  add(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      for (const item of value) this.addSingle(field, item, id);
    } else {
      this.addSingle(field, value, id);
    }
  }

  private addSingle(field: string, value: unknown, id: string): void {
    const key = normalise(value);

    let fieldMap = this.index.get(field);
    if (fieldMap === undefined) {
      fieldMap = new Map();
      this.index.set(field, fieldMap);
    }

    let idSet = fieldMap.get(key);
    if (idSet === undefined) {
      idSet = new Set();
      fieldMap.set(key, idSet);
    }

    idSet.add(id);
  }

  remove(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      for (const item of value) this.removeSingle(field, item, id);
    } else {
      this.removeSingle(field, value, id);
    }
  }

  private removeSingle(field: string, value: unknown, id: string): void {
    const key     = normalise(value);
    const fieldMap = this.index.get(field);
    if (fieldMap === undefined) return;

    const idSet = fieldMap.get(key);
    if (idSet === undefined) return;

    idSet.delete(id);

    if (idSet.size === 0) {
      fieldMap.delete(key);
      if (fieldMap.size === 0) this.index.delete(field);
    }
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  eq(field: string, value: unknown): Set<string> {
    return this.index.get(field)?.get(normalise(value)) ?? (EMPTY_SET as Set<string>);
  }

  neq(field: string, value: unknown): Set<string> {
    const excluded = normalise(value);
    const fieldMap  = this.index.get(field);
    if (fieldMap === undefined) return EMPTY_SET as Set<string>;

    const result = new Set<string>();
    for (const [v, ids] of fieldMap) {
      if (v !== excluded) {
        for (const id of ids) result.add(id);
      }
    }
    return result;
  }

  findIn(field: string, values: unknown[]): Set<string> {
    const result = new Set<string>();
    for (const value of values) {
      const ids = this.eq(field, value);
      for (const id of ids) result.add(id);
    }
    return result;
  }

  notIn(field: string, values: unknown[]): Set<string> {
    const excluded = new Set(values.map(normalise));
    const fieldMap  = this.index.get(field);
    if (fieldMap === undefined) return EMPTY_SET as Set<string>;

    const result = new Set<string>();
    for (const [v, ids] of fieldMap) {
      if (!excluded.has(v)) {
        for (const id of ids) result.add(id);
      }
    }
    return result;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  clear(): void {
    this.index.clear();
  }

  get entryCount(): number {
    let n = 0;
    for (const m of this.index.values()) n += m.size;
    return n;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalise(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}
