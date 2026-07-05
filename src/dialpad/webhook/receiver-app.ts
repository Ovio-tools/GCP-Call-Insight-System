import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import {
  createWebhookApp,
  type Clock,
  type RateStore,
  type ReplayStore,
  type WebhookApp,
} from '../../http/index.js';
import { installDialpadBodyParser, registerDialpadWebhook } from './route.js';
import type { DialpadIngestSink } from './sink.js';

/**
 * Assemble the Dialpad webhook-receiver app: the shared hardening middleware (Task 2.3), the
 * single install of the raw-body parser, and the Dialpad route. Side-effect free and dependency-
 * injected so it can be built with in-memory stores + a fake sink in tests and with Redis stores +
 * the Postgres sink in the entrypoint. The entrypoint owns listening and shutdown.
 */
export interface WebhookReceiverDeps {
  config: Config;
  replayStore: ReplayStore;
  rateStore: RateStore;
  sink: DialpadIngestSink;
  logger?: Logger;
  clock?: Clock;
}

export async function buildWebhookReceiverApp(deps: WebhookReceiverDeps): Promise<WebhookApp> {
  const webhookApp = await createWebhookApp({
    config: deps.config,
    replayStore: deps.replayStore,
    rateStore: deps.rateStore,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  // Single owner of the content-type parser, installed before the route is registered.
  installDialpadBodyParser(webhookApp.app);
  registerDialpadWebhook(webhookApp, {
    config: deps.config,
    sink: deps.sink,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  return webhookApp;
}
