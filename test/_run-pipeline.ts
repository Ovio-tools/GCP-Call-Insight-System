import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { runPipeline as runPipelineImpl } from '../src/pipeline/state-machine.js';
import type { StageHandlers } from '../src/pipeline/stages.js';
import { testSlaMinutesFor } from './_config.js';

/**
 * Test-only shim preserving the pre-Task-6.1 positional `runPipeline(pool, callId, logger,
 * handlers?)` signature. Injects the fixed test SLA resolver ({@link testSlaMinutesFor}) so the
 * many pipeline tests need not each thread `slaMinutesFor` — the "shared test helper" the plan
 * calls for. Production code calls the real `runPipeline` with an explicit resolver (the worker
 * builds it from config).
 */
export function runPipeline(
  pool: Pool,
  callId: string,
  logger: Logger,
  handlers?: StageHandlers,
): Promise<void> {
  return runPipelineImpl(pool, callId, logger, {
    ...(handlers !== undefined ? { handlers } : {}),
    slaMinutesFor: testSlaMinutesFor,
  });
}
