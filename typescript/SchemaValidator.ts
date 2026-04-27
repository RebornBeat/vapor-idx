// =============================================================================
// vapor-idx — SchemaValidator.ts
// Validates schema declarations and incoming record data against the schema.
// =============================================================================

import {
  VaporSchema,
  TypeDefinition,
  FieldDefinition,
  FieldType,
  IndexStrategy,
  FilterOp,
  FieldFilter,
  VaporSchemaError,
  VaporQueryError,
} from './types.js';

// ── Valid combinations ────────────────────────────────────────────────────────

const VALID_FIELD_TYPES = new Set<FieldType>([
  'string', 'number', 'boolean', 'string[]', 'number[]',
]);

const VALID_INDEX_STRATEGIES = new Set<IndexStrategy>([
  'none', 'exact', 'keyword', 'prefix', 'range',
]);

// Which operations are valid for each index strategy
const OP_STRATEGY_MAP: Record<FilterOp, IndexStrategy[]> = {
  eq:         ['exact'],
  neq:        ['exact'],
  in:         ['exact'],
  notIn:      ['exact'],
  contains:   ['keyword'],
  startsWith: ['prefix'],
  gt:         ['range'],
  lt:         ['range'],
  gte:        ['range'],
  lte:        ['range'],
};

// Range ops only valid on numeric field types
const RANGE_OPS = new Set<FilterOp>(['gt', 'lt', 'gte', 'lte']);

// ── Schema validation ─────────────────────────────────────────────────────────

export function validateSchema(schema: VaporSchema): void {
  if (!schema || typeof schema !== 'object') {
    throw new VaporSchemaError('Schema must be a non-null object.');
  }
  if (!schema.types || typeof schema.types !== 'object') {
    throw new VaporSchemaError('Schema must have a "types" object.');
  }
  if (Object.keys(schema.types).length === 0) {
    throw new VaporSchemaError('Schema must declare at least one type.');
  }

  const declaredTypes = new Set(Object.keys(schema.types));

  for (const [typeName, typeDef] of Object.entries(schema.types)) {
    validateTypeName(typeName);
    validateTypeDef(typeName, typeDef, declaredTypes);
  }
}

function validateTypeName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new VaporSchemaError('Type names must be non-empty strings.');
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new VaporSchemaError(
      `Type name "${name}" must start with a letter and contain only letters, digits, and underscores.`
    );
  }
}

function validateTypeDef(
  typeName:      string,
  typeDef:       TypeDefinition,
  declaredTypes: Set<string>
): void {
  if (!typeDef.fields || typeof typeDef.fields !== 'object') {
    throw new VaporSchemaError(`Type "${typeName}" must have a "fields" object.`);
  }

  for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
    validateFieldDef(typeName, fieldName, fieldDef);
  }

  if (typeDef.relationships) {
    for (const [relName, relDef] of Object.entries(typeDef.relationships)) {
      if (!relDef.targetTypes || !Array.isArray(relDef.targetTypes) || relDef.targetTypes.length === 0) {
        throw new VaporSchemaError(
          `Relationship "${relName}" on type "${typeName}" must declare at least one targetType.`
        );
      }

      for (const target of relDef.targetTypes) {
        if (target !== '*' && !declaredTypes.has(target)) {
          throw new VaporSchemaError(
            `Relationship "${relName}" on type "${typeName}" references undeclared target type "${target}".`
          );
        }
      }

      if (typeof relDef.directed !== 'boolean') {
        throw new VaporSchemaError(
          `Relationship "${relName}" on type "${typeName}" must declare "directed" as a boolean.`
        );
      }

      const validCardinalities = ['one-to-one', 'one-to-many', 'many-to-many'];
      if (!validCardinalities.includes(relDef.cardinality)) {
        throw new VaporSchemaError(
          `Relationship "${relName}" on type "${typeName}" must declare cardinality as one of: ${validCardinalities.join(', ')}.`
        );
      }
    }
  }
}

function validateFieldDef(typeName: string, fieldName: string, fieldDef: FieldDefinition): void {
  if (!VALID_FIELD_TYPES.has(fieldDef.type)) {
    throw new VaporSchemaError(
      `Field "${fieldName}" on type "${typeName}" has invalid type "${fieldDef.type}". ` +
      `Valid types: ${[...VALID_FIELD_TYPES].join(', ')}.`
    );
  }

  if (!VALID_INDEX_STRATEGIES.has(fieldDef.index)) {
    throw new VaporSchemaError(
      `Field "${fieldName}" on type "${typeName}" has invalid index strategy "${fieldDef.index}". ` +
      `Valid strategies: ${[...VALID_INDEX_STRATEGIES].join(', ')}.`
    );
  }

  // Range index only valid on numeric types
  if (fieldDef.index === 'range' && !fieldDef.type.startsWith('number')) {
    throw new VaporSchemaError(
      `Field "${fieldName}" on type "${typeName}" uses "range" index but has type "${fieldDef.type}". ` +
      `Range index is only valid for "number" or "number[]" fields.`
    );
  }
}

// ── Record data validation ────────────────────────────────────────────────────

export function validateRecordData(
  typeName: string,
  typeDef:  TypeDefinition,
  data:     Record<string, unknown>
): void {
  // Check required fields
  for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
    if (fieldDef.required && !(fieldName in data)) {
      throw new VaporSchemaError(
        `Required field "${fieldName}" is missing on type "${typeName}".`
      );
    }
  }

  // Check types of provided values
  for (const [fieldName, value] of Object.entries(data)) {
    const fieldDef = typeDef.fields[fieldName];
    if (fieldDef === undefined) {
      // Unknown fields are allowed; they are stored but not indexed
      continue;
    }
    if (value === null || value === undefined) {
      if (fieldDef.required) {
        throw new VaporSchemaError(
          `Required field "${fieldName}" on type "${typeName}" must not be null or undefined.`
        );
      }
      continue;
    }
    validateFieldValue(typeName, fieldName, fieldDef.type, value);
  }
}

function validateFieldValue(
  typeName:  string,
  fieldName: string,
  fieldType: FieldType,
  value:     unknown
): void {
  switch (fieldType) {
    case 'string':
      if (typeof value !== 'string') {
        throw new VaporSchemaError(
          `Field "${fieldName}" on type "${typeName}" expects string, got ${typeof value}.`
        );
      }
      break;

    case 'number':
      if (typeof value !== 'number') {
        throw new VaporSchemaError(
          `Field "${fieldName}" on type "${typeName}" expects number, got ${typeof value}.`
        );
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new VaporSchemaError(
          `Field "${fieldName}" on type "${typeName}" expects boolean, got ${typeof value}.`
        );
      }
      break;

    case 'string[]':
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        throw new VaporSchemaError(
          `Field "${fieldName}" on type "${typeName}" expects string[], got ${typeof value}.`
        );
      }
      break;

    case 'number[]':
      if (!Array.isArray(value) || !value.every(item => typeof item === 'number')) {
        throw new VaporSchemaError(
          `Field "${fieldName}" on type "${typeName}" expects number[], got ${typeof value}.`
        );
      }
      break;
  }
}

// ── Query filter validation ───────────────────────────────────────────────────

export function validateFilter(
  filter:   FieldFilter,
  typeName: string,
  typeDef:  TypeDefinition
): void {
  const fieldDef = typeDef.fields[filter.field];
  if (fieldDef === undefined) {
    throw new VaporQueryError(
      `Query references field "${filter.field}" which is not declared on type "${typeName}".`
    );
  }

  const validStrategies = OP_STRATEGY_MAP[filter.op];
  if (!validStrategies) {
    throw new VaporQueryError(`Unknown filter operator "${filter.op}".`);
  }

  if (!validStrategies.includes(fieldDef.index)) {
    throw new VaporQueryError(
      `Operator "${filter.op}" requires index strategy [${validStrategies.join(', ')}] ` +
      `but field "${filter.field}" on type "${typeName}" uses "${fieldDef.index}".`
    );
  }

  if (RANGE_OPS.has(filter.op) && typeof filter.value !== 'number') {
    throw new VaporQueryError(
      `Operator "${filter.op}" requires a numeric value, got ${typeof filter.value}.`
    );
  }
}

// ── Schema hashing ────────────────────────────────────────────────────────────

export function hashSchema(schema: VaporSchema): string {
  // Simple deterministic hash of the schema structure for snapshot compatibility checks
  const serialised = JSON.stringify(schema, Object.keys(schema).sort());
  let hash = 0;
  for (let i = 0; i < serialised.length; i++) {
    hash = ((hash << 5) - hash) + serialised.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
