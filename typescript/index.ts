// =============================================================================
// vapor-idx — index.ts
// Public API surface. Everything a skill author imports comes from here.
// =============================================================================

export { VaporInstance }             from './VaporInstance.js';
export type {
  // Schema
  VaporSchema,
  TypeDefinition,
  FieldDefinition,
  RelationshipDefinition,
  FieldType,
  IndexStrategy,
  PrimitiveType,

  // Records
  VaporRecord,
  VaporRelationship,

  // Query
  QueryOptions,
  QueryResult,
  FieldFilter,
  FilterOp,
  TraversalOptions,
  TraversalResult,
  TraversalEntry,
  PathOptions,

  // Introspection
  VaporStats,
  IndexStats,
  VaporSnapshot,
} from './types.js';

export {
  VaporError,
  VaporSchemaError,
  VaporQueryError,
  VaporDestroyedError,
} from './types.js';

// ── Factory function ──────────────────────────────────────────────────────────

import { VaporInstance } from './VaporInstance.js';
import { VaporSchema }   from './types.js';

/**
 * Create a new Vapor index instance bound to the provided schema.
 *
 * Every type, field, and relationship must be declared in the schema before
 * any records are stored. There are no defaults.
 *
 * The instance lives entirely in RAM. It produces no files, no network
 * requests, and no cross-skill state. Destroy it explicitly with
 * `vapor.destroy()` or let it go out of scope.
 *
 * @example
 * ```typescript
 * const vapor = createVapor({
 *   types: {
 *     Task: {
 *       fields: {
 *         title:    { type: 'string',  index: 'keyword' },
 *         priority: { type: 'number',  index: 'range'   },
 *         status:   { type: 'string',  index: 'exact'   },
 *         tags:     { type: 'string[]',index: 'keyword' },
 *       },
 *       relationships: {
 *         BLOCKS: {
 *           targetTypes: ['Task'],
 *           directed:    true,
 *           cardinality: 'many-to-many',
 *         },
 *       },
 *     },
 *   },
 * });
 * ```
 */
export function createVapor(schema: VaporSchema): VaporInstance {
  return new VaporInstance(schema);
}
