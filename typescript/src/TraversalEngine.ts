// =============================================================================
// vapor-idx — TraversalEngine.ts
// BFS-based relationship traversal with depth control, direction awareness,
// optional per-hop filtering, and shortest-path (BFS) between two nodes.
// =============================================================================

import {
  TraversalOptions,
  TraversalResult,
  TraversalEntry,
  PathOptions,
  VaporRecord,
  VaporError,
} from './types.js';
import { RecordStore }        from './RecordStore.js';
import { RelationshipStore }  from './RelationshipStore.js';
import { QueryEngine }        from './QueryEngine.js';

export class TraversalEngine {
  constructor(
    private readonly records:       RecordStore,
    private readonly relationships: RelationshipStore,
    private readonly query:         QueryEngine
  ) {}

  // ── Traversal ──────────────────────────────────────────────────────────────

  traverse<T extends Record<string, unknown>>(options: TraversalOptions): TraversalResult<T> {
    const {
      from,
      relationship,
      direction = 'outgoing',
      depth     = 1,
      filter,
    } = options;

    if (!this.records.has(from)) {
      throw new VaporError(`Traversal start record "${from}" does not exist.`);
    }

    const visited:  Set<string>            = new Set([from]);
    const entries:  TraversalEntry<T>[]    = [];
    const records:  VaporRecord<T>[]       = [];

    // BFS queue: [currentId, currentDepth, pathSoFar]
    const queue: [string, number, string[]][] = [[from, 0, []]];

    while (queue.length > 0) {
      const [currentId, currentDepth, via] = queue.shift()!;

      if (currentDepth >= depth) continue;

      const neighbourIds = this.relationships.getNeighbourIds(
        currentId,
        relationship,
        direction
      );

      for (const neighbourId of neighbourIds) {
        if (visited.has(neighbourId)) continue;
        visited.add(neighbourId);

        const record = this.records.get(neighbourId) as VaporRecord<T> | null;
        if (record === null) continue;

        // Apply optional filter
        if (filter) {
          const matchSet = this.query.query({ ...filter }).records;
          const inMatch  = matchSet.some(r => r.id === neighbourId);
          if (!inMatch) continue;
        }

        const entry: TraversalEntry<T> = {
          record,
          depth: currentDepth + 1,
          via:   [...via, currentId],
        };

        entries.push(entry);
        records.push(record);

        if (currentDepth + 1 < depth) {
          queue.push([neighbourId, currentDepth + 1, [...via, currentId]]);
        }
      }
    }

    return { records, entries };
  }

  // ── Shortest path ──────────────────────────────────────────────────────────

  findPath(options: PathOptions): string[] | null {
    const { from, to, relationship, maxDepth = 10 } = options;

    if (!this.records.has(from)) {
      throw new VaporError(`Path start record "${from}" does not exist.`);
    }
    if (!this.records.has(to)) {
      throw new VaporError(`Path end record "${to}" does not exist.`);
    }
    if (from === to) return [from];

    // BFS
    const visited = new Set<string>([from]);
    // queue: [currentId, pathToHere]
    const queue: [string, string[]][] = [[from, [from]]];

    while (queue.length > 0) {
      const [currentId, path] = queue.shift()!;

      if (path.length - 1 >= maxDepth) continue;

      const edges = this.relationships.getEdgesForRecord(currentId, relationship, 'both');

      for (const edge of edges) {
        const neighbourId = edge.sourceId === currentId ? edge.targetId : edge.sourceId;

        if (visited.has(neighbourId)) continue;
        visited.add(neighbourId);

        const newPath = [...path, neighbourId];

        if (neighbourId === to) return newPath;

        queue.push([neighbourId, newPath]);
      }
    }

    return null;
  }
}
