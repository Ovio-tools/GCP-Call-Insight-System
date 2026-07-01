import { metadataPreFilterHandler } from './metadata-prefilter.js';
import { defaultStageHandlers, type StageHandlers } from './stages.js';

/**
 * The real stage handler set used in production: the pure stub handlers with the live
 * `metadata-pre-filter` handler swapped in. Kept in its own module so `stages.ts` (which
 * `metadata-prefilter.ts` imports for types) never imports back into the handler — no
 * import cycle. As later stages get real handlers (fetch-transcript, redact, …), swap
 * them in here.
 */
export const productionStageHandlers: StageHandlers = {
  ...defaultStageHandlers,
  'metadata-pre-filter': metadataPreFilterHandler,
};
