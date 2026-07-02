import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { DialpadClient } from '../dialpad/client/index.js';
import type { DelayedRetryQueue } from '../queue/pipeline-queue.js';
import {
  type Clock,
  createFetchTranscriptHandler,
  createTranscriptAvailabilityHandler,
} from './fetch-transcript.js';
import { metadataPreFilterHandler } from './metadata-prefilter.js';
import { createRedactionHandler } from './redact.js';
import { defaultStageHandlers, type StageHandlers } from './stages.js';

/**
 * The pre-filter-only handler set: stubs with the live `metadata-pre-filter` swapped in. Used
 * where no external dependencies are wired (e.g. focused tests that only exercise the
 * pre-filter). Production uses {@link buildProductionStageHandlers}, which additionally wires
 * the real fetch-transcript + transcript-availability stages. Kept in its own module so
 * `stages.ts` never imports back into a handler — no import cycle.
 */
export const productionStageHandlers: StageHandlers = {
  ...defaultStageHandlers,
  'metadata-pre-filter': metadataPreFilterHandler,
};

export interface ProductionHandlerDeps {
  client: DialpadClient;
  keyProvider: KeyProvider;
  queue: DelayedRetryQueue;
  config: Config;
  clock?: Clock;
}

/**
 * Build the production stage handler set with all real handlers wired from their runtime
 * dependencies (Dialpad client, key provider, retry queue). As later stages get real
 * handlers (redact, classify, …), add them here.
 */
export function buildProductionStageHandlers(deps: ProductionHandlerDeps): StageHandlers {
  return {
    ...defaultStageHandlers,
    'metadata-pre-filter': metadataPreFilterHandler,
    'fetch-transcript': createFetchTranscriptHandler(deps),
    'transcript-availability': createTranscriptAvailabilityHandler({ config: deps.config }),
    // Validates redaction config (hash key, deny-list readability) at factory time —
    // a bad config fails handler construction, never a per-call retry loop.
    redact: createRedactionHandler({ keyProvider: deps.keyProvider, config: deps.config }),
  };
}
