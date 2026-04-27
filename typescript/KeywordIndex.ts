// =============================================================================
// vapor-idx — indexes/KeywordIndex.ts
// Tokenised inverted index: "field:token" → Set<recordId>
// Supports: contains (field-scoped), free-text search (any keyword field)
// All query tokens are AND-ed: every token must appear for a match.
// =============================================================================

const EMPTY_SET: ReadonlySet<string> = new Set();

export class KeywordIndex {
  // "field:token" → Set<id>
  private readonly index: Map<string, Set<string>> = new Map();
  // id → Set<"field:token"> — required for O(degree) removal without full scan
  private readonly recordKeys: Map<string, Set<string>> = new Map();

  // ── Mutation ───────────────────────────────────────────────────────────────

  add(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    const rawValues = Array.isArray(value) ? value : [value];
    const tokens    = rawValues.flatMap(v => tokenise(String(v)));

    if (tokens.length === 0) return;

    let keySet = this.recordKeys.get(id);
    if (keySet === undefined) {
      keySet = new Set();
      this.recordKeys.set(id, keySet);
    }

    for (const token of tokens) {
      const compositeKey = `${field}:${token}`;

      let idSet = this.index.get(compositeKey);
      if (idSet === undefined) {
        idSet = new Set();
        this.index.set(compositeKey, idSet);
      }

      idSet.add(id);
      keySet.add(compositeKey);
    }
  }

  /** Remove all keyword index entries for a given record id. */
  remove(id: string): void {
    const keys = this.recordKeys.get(id);
    if (keys === undefined) return;

    for (const key of keys) {
      const idSet = this.index.get(key);
      if (idSet !== undefined) {
        idSet.delete(id);
        if (idSet.size === 0) this.index.delete(key);
      }
    }

    this.recordKeys.delete(id);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  /**
   * Free-text search across all keyword-indexed fields.
   * Returns records that contain ALL query tokens, in any keyword field.
   */
  search(query: string | string[]): Set<string> {
    const tokens = Array.isArray(query)
      ? query.flatMap(tokenise)
      : tokenise(query);

    if (tokens.length === 0) return EMPTY_SET as Set<string>;

    const perToken: Set<string>[] = tokens.map(token => {
      const merged = new Set<string>();
      for (const [key, ids] of this.index) {
        if (key.endsWith(`:${token}`)) {
          for (const id of ids) merged.add(id);
        }
      }
      return merged;
    });

    return intersectAll(perToken);
  }

  /**
   * Field-scoped keyword search.
   * All query tokens must appear in the specified field.
   */
  contains(field: string, query: string | string[]): Set<string> {
    const tokens = Array.isArray(query)
      ? query.flatMap(tokenise)
      : tokenise(query);

    if (tokens.length === 0) return EMPTY_SET as Set<string>;

    const perToken: Set<string>[] = tokens.map(token => {
      return this.index.get(`${field}:${token}`) ?? (EMPTY_SET as Set<string>);
    });

    return intersectAll(perToken);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  clear(): void {
    this.index.clear();
    this.recordKeys.clear();
  }

  get tokenCount(): number {
    return this.index.size;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Tokenises a string value into lowercase alphanumeric tokens.
 * Numbers are preserved. Short stop-words (≤ 2 chars) are excluded.
 */
export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s\-_.,;:!?'"()\[\]{}<>/\\|@#$%^&*+=~`]+/)
    .filter(t => t.length > 2);
}

function intersectAll(sets: ReadonlySet<string>[]): Set<string> {
  if (sets.length === 0) return new Set();

  // Start from the smallest set for efficiency
  const sorted = [...sets].sort((a, b) => a.size - b.size);
  const result = new Set<string>(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    for (const id of result) {
      if (!sorted[i].has(id)) result.delete(id);
    }
    if (result.size === 0) break;
  }

  return result;
}
