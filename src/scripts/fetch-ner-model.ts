import { env, pipeline } from '@huggingface/transformers';

/**
 * Build-time NER model vendoring (Task 4.1). Downloads and caches the quantized
 * ONNX model into REDACTION_NER_MODEL_DIR so the runtime can stay fully offline
 * (`allowRemoteModels = false` in ner-detector.ts).
 *
 * This is the ONLY code path allowed network access for the model. It runs during
 * build/CI/deploy (`npm run model:fetch`, after `npm run build`), never in the
 * per-call path, and never sees transcript text. Idempotent: a warm cache makes
 * it a near-no-op.
 *
 * Reads the two relevant env vars directly (with the schema's defaults) instead
 * of loadConfig(): build environments don't carry the full runtime config, and
 * requiring NODE_ENV etc. here would couple the image build to runtime secrets.
 */
const modelId = process.env.REDACTION_NER_MODEL_ID ?? 'Xenova/bert-base-NER';
const modelDir = process.env.REDACTION_NER_MODEL_DIR ?? 'models';

env.allowRemoteModels = true;
env.cacheDir = modelDir;
env.localModelPath = modelDir;

process.stdout.write(`fetching NER model ${modelId} into ${modelDir} ...\n`);
await pipeline('token-classification', modelId, { dtype: 'q8' });
process.stdout.write(`NER model ${modelId} cached in ${modelDir}\n`);
