// =============================================================================
// vapor-idx — index.ts
// FIX: VaporSchema used only as a type in createVapor — must be `import type`.
// =============================================================================

export { VaporInstance } from "./VaporInstance.js";

export type {
  VaporSchema,
  TypeDefinition,
  FieldDefinition,
  RelationshipDefinition,
  FieldType,
  IndexStrategy,
  PrimitiveType,
  VaporRecord,
  VaporRelationship,
  QueryOptions,
  QueryResult,
  FieldFilter,
  FilterOp,
  TraversalOptions,
  TraversalResult,
  TraversalEntry,
  PathOptions,
  VaporStats,
  IndexStats,
  VaporSnapshot,
} from "./types.js";

export {
  VaporError,
  VaporSchemaError,
  VaporQueryError,
  VaporDestroyedError,
} from "./types.js";

import { VaporInstance } from "./VaporInstance.js";
import type { VaporSchema } from "./types.js";

/**
 * Create a new Vapor index instance bound to the provided schema.
 * Records live in RAM as JavaScript objects. Nothing is written to disk.
 */
export function createVapor(schema: VaporSchema): VaporInstance {
  return new VaporInstance(schema);
}
