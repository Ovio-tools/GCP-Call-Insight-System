import { describe, expect, it } from 'vitest';
import {
  CLASSIFY_OUTPUT_FORMAT,
  EXTRACT_OUTPUT_FORMAT,
  TECHNICIAN_NOTE_OUTPUT_FORMAT,
} from '../../src/anthropic/client.js';

/**
 * Offline conformance gates over EVERY structured-output schema we send.
 *
 * These exist because the note generator shipped with a wire schema the API rejects outright:
 * 31 union-typed (nullable) parameters against a hard limit of 16, so every note request failed
 * with HTTP 400 before a single token was generated. The whole technician-note suite stayed green
 * throughout — it drives a stubbed model client, so the real schema was never sent anywhere.
 *
 * Both rules below are properties of the WIRE schema alone. They need no API key, no network, and
 * no model: they are pure walks over an exported constant, and they would have caught that bug at
 * zero cost. Anything asserted here is a rule the API enforces but our types cannot.
 */

/** Every schema we put on the wire, by the name a failure should point at. */
const OUTPUT_FORMATS = [
  ['CLASSIFY_OUTPUT_FORMAT', CLASSIFY_OUTPUT_FORMAT],
  ['EXTRACT_OUTPUT_FORMAT', EXTRACT_OUTPUT_FORMAT],
  ['TECHNICIAN_NOTE_OUTPUT_FORMAT', TECHNICIAN_NOTE_OUTPUT_FORMAT],
] as const;

/**
 * The API's ceiling on union-typed parameters per schema, from the 400 the note schema earned:
 * "Schemas contains too many parameters with union types ... (limit: 16 parameters with unions)".
 * Compilation cost is exponential in this count, which is why it is capped rather than merely
 * discouraged.
 */
const MAX_UNION_PARAMETERS = 16;

interface SchemaNode {
  type?: unknown;
  anyOf?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/**
 * Count parameters the API considers union-typed: a type ARRAY (`{type: ['string','null']}`) or an
 * `anyOf`. Both forms are accepted on the wire and both count toward the same limit, so the
 * counter must not privilege either encoding.
 */
function countUnionParameters(node: SchemaNode | undefined): number {
  if (node === undefined || node === null || typeof node !== 'object') return 0;
  let count = Array.isArray(node.type) || Array.isArray(node.anyOf) ? 1 : 0;
  for (const child of Object.values(node.properties ?? {})) count += countUnionParameters(child);
  count += countUnionParameters(node.items);
  return count;
}

describe('structured-output wire limits', () => {
  // A counter that always returned 0 would make every assertion below vacuously true — exactly
  // the failure mode that let the original bug ship. These two cases pin it to a schema whose
  // answer is known by inspection, in both accepted encodings and at both nesting depths.
  it('the union counter actually counts (self-test)', () => {
    expect(
      countUnionParameters({
        type: 'object',
        properties: {
          plain: { type: 'string' },
          typeArray: { type: ['string', 'null'] },
          viaAnyOf: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          nested: {
            type: 'object',
            properties: { deep: { type: ['boolean', 'null'] }, alsoPlain: { type: 'boolean' } },
          },
          list: { type: 'array', items: { type: ['string', 'null'] } },
        },
      }),
    ).toBe(4);

    expect(countUnionParameters({ type: 'object', properties: { a: { type: 'string' } } })).toBe(0);
  });

  it.each(OUTPUT_FORMATS)('%s stays within the union-parameter limit', (_name, format) => {
    expect(countUnionParameters(format.schema as SchemaNode)).toBeLessThanOrEqual(
      MAX_UNION_PARAMETERS,
    );
  });

  // Structured outputs reject JSON Schema length and range keywords. Every such bound in this
  // codebase therefore lives in the zod layer instead, where breaching it becomes a retryable
  // `schema_invalid` rather than a silent truncation. Until now that rule was only a code comment.
  it.each(OUTPUT_FORMATS)('%s carries no length or range keywords', (_name, format) => {
    const serialized = JSON.stringify(format);
    for (const keyword of [
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'minimum',
      'maximum',
      'multipleOf',
      'pattern',
    ]) {
      expect(serialized).not.toContain(keyword);
    }
  });
});
