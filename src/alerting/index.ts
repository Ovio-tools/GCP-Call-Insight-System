/**
 * Alert delivery (Task 7.3). Composes ONLY Task 2.2 failure-model primitives — no new
 * formatting or severity logic — into: an application-level `emitAlert` (record + immediate
 * delivery), a retry sweep and escalation runner for the reconciliation cron, and the PII-safe
 * outbound webhook transport. Durable delivery state lives on `alert_events` (migration
 * 1782864000011) so no producer can persist an undeliverable alert.
 */
export {
  AlertWebhookError,
  type AlertWebhookPoster,
  httpPostAlert,
  sanitizeWebhookError,
} from './webhook.js';
export { type DeliverDeps, type DeliveryOutcome, deliverAlertRow } from './deliver.js';
export {
  type EmitAlertInput,
  type EmitAlertResult,
  emitAlert,
  requireAlertWebhookUrl,
} from './emit.js';
export {
  type EscalateAndDeliverDeps,
  type SweepResult,
  escalateAndDeliver,
  retryPendingDeliveries,
} from './sweep.js';
