/** App-role repositories, namespaced per table (several share helper names like
 * `listByCall`, so a flat re-export would collide). */
export * as callState from './call-state-repo.js';
export * as cleanTranscripts from './clean-transcripts-repo.js';
export * as structuredKnowledge from './structured-knowledge-repo.js';
export * as redactionFindings from './redaction-findings-repo.js';
export * as reviewQueue from './review-queue-repo.js';
export * as operatorActions from './operator-actions-repo.js';
export * as modelInvocations from './model-invocations-repo.js';
export * as dailyCostUsage from './daily-cost-usage-repo.js';
export * as alertEvents from './alert-events-repo.js';
export * as backfillRuns from './backfill-runs-repo.js';
export * as consentGates from './consent-gates-repo.js';
export * as processingLog from './processing-log-repo.js';
export * as deadLetter from './dead-letter-repo.js';
export * as rawWebhookEvents from './raw-webhook-events-repo.js';
export * as keyVersions from './key-versions-repo.js';
export * as rawTranscripts from './raw-transcripts-repo.js';
