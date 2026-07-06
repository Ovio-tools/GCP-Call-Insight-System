import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { createAppPool } from '../db/index.js';
import { loadDenyList } from '../redaction/deny-list.js';
import {
  assertStagingResources,
  markSample,
  seedLabeledBaseline,
  type MarkSampleInput,
} from '../sample-validation/index.js';

/**
 * Mark a sample-validation call correct/wrong and (optionally) seed the Phase 6.3 labeled baseline
 * (Task 11.1). Staging-only, like the run itself. The mark records a review + operator-action audit
 * row; `--seed` then mines every recorded mark into `labeled_examples` via `syncLabeledExamples`.
 *
 * Usage:
 *   node dist/scripts/mark-sample.js --call <id> --task classify --verdict correct \
 *     --bucket customer [--notes "..."] [--seed]
 *   node dist/scripts/mark-sample.js --call <id> --task extract --verdict wrong \
 *     --intent new_booking --category water_heater --urgency routine --sentiment neutral [--seed]
 */
function parseArgs(argv: readonly string[]): { input: MarkSampleInput; seed: boolean } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const req = (flag: string): string => {
    const v = get(flag);
    if (v === undefined) throw new Error(`missing required ${flag}`);
    return v;
  };

  const taskType = req('--task');
  if (taskType !== 'classify' && taskType !== 'extract') {
    throw new Error('--task must be classify or extract');
  }
  const verdict = req('--verdict');
  if (verdict !== 'correct' && verdict !== 'wrong') {
    throw new Error('--verdict must be correct or wrong');
  }

  const notes = get('--notes');
  const input: MarkSampleInput = {
    callId: req('--call'),
    taskType,
    verdict,
    actor: get('--actor') ?? 'sample-validation-operator',
    ...(notes !== undefined ? { notes } : {}),
  };

  if (taskType === 'classify') {
    const bucket = req('--bucket');
    if (bucket !== 'customer' && bucket !== 'non-customer' && bucket !== 'spam') {
      throw new Error('--bucket must be customer, non-customer, or spam');
    }
    input.classifyBucket = bucket;
  } else {
    input.extractEnums = {
      call_intent: req('--intent'),
      service_category: req('--category'),
      urgency: req('--urgency'),
      sentiment: req('--sentiment'),
    };
  }

  return { input, seed: argv.includes('--seed') };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'mark-sample' });
  // Marking (and its seeding) writes validation artifacts to review_queue / operator_actions /
  // labeled_examples, so it needs the SAME staging-only + no-production-resource guard as the run,
  // before any DB connection. It uses no queue, so no Redis readiness is required.
  assertStagingResources(config);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const { input, seed } = parseArgs(process.argv.slice(2));
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);
  const pool = createAppPool(config.DATABASE_URL);

  try {
    // denyTerms gates any reviewer note through the residual-PII scan before it is stored.
    const { reviewQueueId, operatorActionId } = await markSample(pool, input, { denyTerms });
    // Ids are low-sensitivity correlation keys; no content, no reviewer notes in the log.
    logger.info({ reviewQueueId, operatorActionId, task: input.taskType }, 'sample marked');

    if (seed) {
      const summary = await seedLabeledBaseline(pool, { denyTerms, logger });
      logger.info({ ...summary }, 'labeled baseline seeded from marks');
    }
  } finally {
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`mark-sample failed: ${String(err)}\n`);
    process.exit(1);
  });
}
