import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { DialpadClient } from '../dialpad/client/index.js';
import { type DelayedRetryQueue, enqueueCall } from '../queue/pipeline-queue.js';
import {
  type ClassifyModelClient,
  type ExtractModelClient,
  createAnthropicClassifyClient,
  createAnthropicExtractClient,
} from '../anthropic/client.js';
import {
  type Clock,
  createFetchTranscriptHandler,
  createTranscriptAvailabilityHandler,
} from './fetch-transcript.js';
import { createClassifyHandler } from './classify/handler.js';
import { createExtractHandler } from './extract/handler.js';
import { createVerbatimPiiScanHandler } from './verbatim-pii-scan.js';
import { metadataPreFilterHandler } from './metadata-prefilter.js';
import { createRedactionHandler } from './redact.js';
import { storeHandler } from './store.js';
import { createMarkRetentionEligibleHandler } from './mark-retention-eligible.js';
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
  /** DB-B app pool (Task 8a): raw_transcripts + token_vault live only in the raw store. The
   * raw/vault-touching stages (fetch-transcript, transcript-availability, redact,
   * mark-retention-eligible) use this; all DB-A access stays on the per-call StageContext pool. */
  rawPool: Pool;
  /** Override the classify model client (tests inject a fake); production builds the
   * Anthropic client lazily so a missing ANTHROPIC_API_KEY only fails a real classify call,
   * never boot or an earlier stage. */
  getClassifyModel?: () => ClassifyModelClient;
  /** Override the extract model client (tests inject a fake); production builds the
   * Anthropic client lazily so a missing ANTHROPIC_API_KEY only fails a real extract call,
   * never boot or an earlier stage. */
  getExtractModel?: () => ExtractModelClient;
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

  // Same lazy memoization for the extract client: a disabled/gated call never constructs it
  // (the thunk is only invoked past extract's kill-switch + retention + classification +
  // transcript + cost-cap gates).
  let extractModel: ExtractModelClient | undefined;
  const getExtractModel =
    deps.getExtractModel ??
    ((): ExtractModelClient => {
      extractModel ??= createAnthropicExtractClient(deps.config);
      return extractModel;
    });

  return {
    ...defaultStageHandlers,
    'metadata-pre-filter': metadataPreFilterHandler,
    'fetch-transcript': createFetchTranscriptHandler({
      ...deps,
      enqueuePipelineJob: (cid: string) => enqueueCall(deps.queue, cid, deps.config),
    }),
    'transcript-availability': createTranscriptAvailabilityHandler({
      config: deps.config,
      rawPool: deps.rawPool,
    }),
    // Validates redaction config (hash key, deny-list readability) at factory time —
    // a bad config fails handler construction, never a per-call retry loop.
    redact: createRedactionHandler({
      keyProvider: deps.keyProvider,
      config: deps.config,
      rawPool: deps.rawPool,
    }),
    classify: createClassifyHandler({
      getModel: getClassifyModel,
      config: deps.config,
      ...(deps.clock ? { clock: deps.clock } : {}),
    }),
    // Validates its deny-list config at factory time (same as redact/verbatim-pii-scan).
    extract: createExtractHandler({
      getModel: getExtractModel,
      config: deps.config,
      ...(deps.clock ? { clock: deps.clock } : {}),
    }),
    'verbatim-pii-scan': createVerbatimPiiScanHandler({ config: deps.config }),
    // Task 5.3: copy the verified candidate into structured_knowledge (durable), then the
    // final stage stamps raw transcript + vault retention-eligible (deletes nothing).
    store: storeHandler,
    'mark-retention-eligible': createMarkRetentionEligibleHandler({ rawPool: deps.rawPool }),
  };
}
