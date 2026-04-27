// =============================================================================
// vapor-idx — indexes/RangeIndex.ts
// Sorted numeric index: field → sorted array of [value, id] pairs
// Supports: gt, lt, gte, lte
// Binary search for O(log n) range bound location.
// =============================================================================

const EMPTY_SET: ReadonlySet<string> = new Set();

interface Entry {
  value: number;
  id:    string;
}

export class RangeIndex {
  // field → sorted entries (ascending by value, ties broken by id)
  private readonly index: Map<string, Entry[]> = new Map();

  // ── Mutation ───────────────────────────────────────────────────────────────

  add(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    const rawValues = Array.isArray(value) ? value : [value];

    for (const raw of rawValues) {
      const num = toNumber(raw);
      if (num === null) continue;

      let entries = this.index.get(field);
      if (entries === undefined) {
        entries = [];
        this.index.set(field, entries);
      }

      const pos = insertionPoint(entries, num, id);
      entries.splice(pos, 0, { value: num, id });
    }
  }

  remove(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    const rawValues = Array.isArray(value) ? value : [value];
    const entries   = this.index.get(field);
    if (entries === undefined) return;

    for (const raw of rawValues) {
      const num = toNumber(raw);
      if (num === null) continue;

      // Find the exact entry and remove it
      const start = lowerBound(entries, num);
      for (let i = start; i < entries.length && entries[i].value === num; i++) {
        if (entries[i].id === id) {
          entries.splice(i, 1);
          break;
        }
      }
    }

    if (entries.length === 0) this.index.delete(field);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  gt(field: string, threshold: number): Set<string> {
    const entries = this.index.get(field);
    if (entries === undefined) return EMPTY_SET as Set<string>;

    // Find first index where value > threshold
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].value <= threshold) lo = mid + 1;
      else hi = mid;
    }

    return collectFrom(entries, lo);
  }

  gte(field: string, threshold: number): Set<string> {
    const entries = this.index.get(field);
    if (entries === undefined) return EMPTY_SET as Set<string>;

    const lo = lowerBound(entries, threshold);
    return collectFrom(entries, lo);
  }

  lt(field: string, threshold: number): Set<string> {
    const entries = this.index.get(field);
    if (entries === undefined) return EMPTY_SET as Set<string>;

    // All entries before first entry >= threshold
    const hi = lowerBound(entries, threshold);
    return collectTo(entries, hi);
  }

  lte(field: string, threshold: number): Set<string> {
    const entries = this.index.get(field);
    if (entries === undefined) return EMPTY_SET as Set<string>;

    // Find first index where value > threshold
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].value <= threshold) lo = mid + 1;
      else hi = mid;
    }

    return collectTo(entries, lo);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  clear(): void {
    this.index.clear();
  }

  get entryCount(): number {
    let n = 0;
    for (const arr of this.index.values()) n += arr.length;
    return n;
  }

  /**
   * Returns all entries for a field, sorted ascending — used by orderBy.
   */
  getSorted(field: string): Entry[] {
    return this.index.get(field) ?? [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

/** Returns the leftmost position where entries[pos].value >= target */
function lowerBound(entries: Entry[], target: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].value < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Returns the correct sorted insertion position for (value, id). */
function insertionPoint(entries: Entry[], value: number, id: string): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const e   = entries[mid];
    if (e.value < value || (e.value === value && e.id < id)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function collectFrom(entries: Entry[], start: number): Set<string> {
  const result = new Set<string>();
  for (let i = start; i < entries.length; i++) result.add(entries[i].id);
  return result;
}

function collectTo(entries: Entry[], end: number): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < end; i++) result.add(entries[i].id);
  return result;
}
