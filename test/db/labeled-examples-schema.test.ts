import { describe, expect, it } from 'vitest';
import { insertLabeledExampleSchema } from '../../src/db/schemas/labeled-examples.js';

/**
 * `insertLabeledExampleSchema` is the repository-boundary guard (Task 6.3). It correlates the
 * `expectedOutput` shape with `taskType` and, via the strict expected schemas, rejects ANY extra
 * key — so no free text can ride alongside a label even through the repo. The DB CHECK mirrors this.
 */
const UUID = '00000000-0000-0000-0000-0000000000aa';
const base = {
  operatorActionId: UUID,
  reviewQueueId: UUID,
  callId: 'c1',
  heldReason: 'schema_invalid' as const,
  reviewerActor: 'r',
  redactedInput: 'redacted body',
  sourcePromptVersion: 'v1',
  promptVersionSource: 'current_constant' as const,
  modelIdSource: 'none' as const,
  evalSetVersion: 1,
  piiGateVersion: 1,
};
const VALID_EXTRACT = {
  call_intent: 'general',
  service_category: 'other',
  urgency: 'routine',
  sentiment: 'neutral',
};

const parse = (input: unknown): boolean => insertLabeledExampleSchema.safeParse(input).success;

describe('insertLabeledExampleSchema shape enforcement', () => {
  it('accepts a well-shaped classify and extract label', () => {
    expect(parse({ ...base, taskType: 'classify', expectedOutput: { bucket: 'spam' } })).toBe(true);
    expect(parse({ ...base, taskType: 'extract', expectedOutput: VALID_EXTRACT })).toBe(true);
  });

  it('rejects a task_type / expected_output shape mismatch', () => {
    expect(parse({ ...base, taskType: 'classify', expectedOutput: VALID_EXTRACT })).toBe(false);
    expect(parse({ ...base, taskType: 'extract', expectedOutput: { bucket: 'spam' } })).toBe(false);
  });

  it('rejects an out-of-vocabulary classify bucket', () => {
    expect(parse({ ...base, taskType: 'classify', expectedOutput: { bucket: 'held' } })).toBe(
      false,
    );
  });

  it('rejects an extra key beyond the exact set (no free text alongside the label)', () => {
    expect(
      parse({ ...base, taskType: 'classify', expectedOutput: { bucket: 'spam', note: 'x' } }),
    ).toBe(false);
    expect(
      parse({ ...base, taskType: 'extract', expectedOutput: { ...VALID_EXTRACT, raw: 'x' } }),
    ).toBe(false);
  });

  it('rejects an invalid controlled enum value', () => {
    expect(
      parse({
        ...base,
        taskType: 'extract',
        expectedOutput: { ...VALID_EXTRACT, urgency: 'nope' },
      }),
    ).toBe(false);
  });
});
