import type { NerConfig } from '../../src/redaction/ner-detector.js';

/**
 * Model-gated NER suites mirror the `hasTestDb` pattern: they run only when
 * TEST_NER_MODEL_DIR points at a directory containing the vendored model
 * (`npm run model:fetch` with REDACTION_NER_MODEL_DIR=<dir>). Under CI the
 * ci-guard test makes the gate mandatory, so the recall suite can never
 * silently skip.
 */
export const nerModelDir = process.env.TEST_NER_MODEL_DIR;
export const hasNerModel = Boolean(nerModelDir);

export function makeNerConfig(overrides: Partial<NerConfig> = {}): NerConfig {
  return {
    modelId: 'Xenova/bert-base-NER',
    modelDir: nerModelDir ?? 'models',
    minScore: 0.7,
    chunkChars: 1500,
    chunkOverlapChars: 250,
    entityScope: new Set(['person', 'numbered_location']),
    ...overrides,
  };
}
