/*
 * schema-validator.js — minimal JSON Schema (draft 2020-12 subset) validator.
 *
 * Supports exactly the keywords the V2 schemas in data/schemas/ use and throws on any
 * keyword it does not know, so a schema change can never be silently ignored.
 * Shared by the runtime data layer (every write is validated) and by
 * migration/validate.js, so there is one validator.
 */

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', 'title', '$defs', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'minLength', 'minimum', 'exclusiveMinimum',
  '$ref', 'format'
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/**
 * makeSchemaValidator({ 'food.schema.json': {...}, ... })
 * returns validate(value, schemaFile, where) -> string[] (empty when valid)
 */
export function makeSchemaValidator(schemasByFile) {
  function resolveRef(ref, rootSchema) {
    if (ref.startsWith('#/')) {
      return { schema: ref.slice(2).split('/').reduce((o, k) => o[k], rootSchema), root: rootSchema };
    }
    const target = schemasByFile[ref];
    if (!target) throw new Error(`schema $ref not found: ${ref}`);
    return { schema: target, root: target };
  }

  function check(value, schema, root, where, errors) {
    for (const k of Object.keys(schema)) {
      if (!KNOWN_KEYWORDS.has(k)) throw new Error(`schema keyword not supported by validator: ${k}`);
    }
    if (schema.$ref) {
      const r = resolveRef(schema.$ref, root);
      check(value, r.schema, r.root, where, errors);
      return;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeMatches(value, t))) {
        errors.push(`${where}: expected type ${types.join('|')}, got ${typeOf(value)}`);
        return;
      }
    }
    if (schema.enum && !schema.enum.some((e) => e === value)) {
      errors.push(`${where}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    }
    if (schema.const !== undefined && value !== schema.const) {
      errors.push(`${where}: expected const ${JSON.stringify(schema.const)}`);
    }
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: shorter than minLength`);
      if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${where}: not a date`);
      if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) errors.push(`${where}: not a date-time`);
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
      if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) errors.push(`${where}: must be > ${schema.exclusiveMinimum}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: fewer than ${schema.minItems} items`);
      if (schema.items) value.forEach((v, i) => check(v, schema.items, root, `${where}[${i}]`, errors));
    }
    if (typeOf(value) === 'object') {
      for (const r of schema.required || []) if (!(r in value)) errors.push(`${where}: missing required "${r}"`);
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) check(v, props[k], root, `${where}.${k}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${where}: unexpected property "${k}"`);
      }
    }
  }

  return function validate(value, schemaFile, where) {
    const schema = schemasByFile[schemaFile];
    if (!schema) throw new Error(`unknown schema ${schemaFile}`);
    const errors = [];
    check(value, schema, schema, where, errors);
    return errors;
  };
}
