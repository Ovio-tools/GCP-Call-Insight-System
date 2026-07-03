import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { DialpadClient } from '../dialpad/client/index.js';
import type { DelayedRetryQueue } from '../queue/pipeline-queue.js';
import { type ClassifyModelClient, createAnthropicClassifyClient } from '../anthropic/client.js';
import {
  type Clock,
  createFetchTranscriptHandler,
  createTranscriptAvailabilityHandler,
} from './fetch-transcript.js';
import { createClassifyHandler } from './classify/handler.js';
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
  /** Override the classify model client (tests inject a fake); production builds the
   * Anthropic client lazily so a missing ANTHROPIC_API_KEY only fails a real classify call,
   * never boot or an earlier stage. */
  getClassifyModel?: () => ClassifyModelClient;
}

/**
 * Build the production stage handler set with all real handlers wired from their runtime
 * dependencies (Dialpad client, key provider, retry queue, model client). As later stages
 * get real handlers (redact, extract, …), add them here.
 */
export function buildProductionStageHandlers(deps: ProductionHandlerDeps): StageHandlers {
  // Memoize the lazily-built Anthropic client so repeated classify calls in one worker share
  // one SDK instance, while a disabled/gated call never constructs it (the thunk is only
  // invoked past the classify kill-switch + cost-cap gates).
  let classifyModel: ClassifyModelClient | undefined;
  const getClassifyModel =
    deps.getClassifyModel ??
    ((): ClassifyModelClient => {
      classifyModel ??= createAnthropicClassifyClient(deps.config);
      return classifyModel;
    });

  return {
    ...defaultStageHandlers,
    'metadata-pre-filter': metadataPreFilterHandler,
    'fetch-transcript': createFetchTranscriptHandler(deps),
    'transcript-availability': createTranscriptAvailabilityHandler({ config: deps.config }),
    // Validates redaction config (hash key, deny-list readability) at factory time —
    // a bad config fails handler construction, never a per-call retry loop.
    redact: createRedactionHandler({ keyProvider: deps.keyProvider, config: deps.config }),
    classify: createClassifyHandler({
      getModel: getClassifyModel,
      config: deps.config,
      ...(deps.clock ? { clock: deps.clock } : {}),
    }),
  };
}
