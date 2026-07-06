import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/index.js';
import {
  checkUrlFor,
  checkUrlVar,
  requireCheckUrl,
  type HeartbeatComponent,
} from '../../src/heartbeat/index.js';
import { makeTestConfig } from '../_config.js';

const URLS = {
  worker: 'https://checks.example.com/ping/worker',
  'reconciliation-cron': 'https://checks.example.com/ping/recon',
  'retention-cron': 'https://checks.example.com/ping/retention',
  'evaluation-cron': 'https://checks.example.com/ping/evaluation',
  backfill: 'https://checks.example.com/ping/backfill',
} as const;

const VARS = {
  worker: 'WORKER_CHECK_URL',
  'reconciliation-cron': 'RECONCILIATION_CHECK_URL',
  'retention-cron': 'RETENTION_CHECK_URL',
  'evaluation-cron': 'EVALUATION_CHECK_URL',
  backfill: 'BACKFILL_CHECK_URL',
} as const;

const COMPONENTS: readonly HeartbeatComponent[] = [
  'worker',
  'reconciliation-cron',
  'retention-cron',
  'evaluation-cron',
  'backfill',
];

describe('checkUrlFor / checkUrlVar', () => {
  it('maps each component to its own var and never to another component’s URL', () => {
    for (const c of COMPONENTS) {
      const config = makeTestConfig({ [VARS[c]]: URLS[c] });
      expect(checkUrlVar(c)).toBe(VARS[c]);
      expect(checkUrlFor(config, c)).toBe(URLS[c]);
      // Crosstalk guard: only c's var is set, so EVERY other component resolves to undefined —
      // one component's ping can never be routed to another's URL.
      for (const other of COMPONENTS) {
        if (other !== c) expect(checkUrlFor(config, other)).toBeUndefined();
      }
    }
  });
});

describe('requireCheckUrl', () => {
  for (const env of ['staging', 'production'] as const) {
    for (const c of COMPONENTS) {
      it(`${env}: a missing ${VARS[c]} for ${c} throws ConfigError naming the exact var`, () => {
        const config = makeTestConfig({ NODE_ENV: env, [VARS[c]]: undefined });
        expect(() => requireCheckUrl(config, c)).toThrowError(ConfigError);
        expect(() => requireCheckUrl(config, c)).toThrowError(
          new RegExp(`CONFIG_MISSING_OR_INVALID.*${VARS[c]}`),
        );
      });

      it(`${env}: a present ${VARS[c]} for ${c} passes`, () => {
        const config = makeTestConfig({ NODE_ENV: env, [VARS[c]]: URLS[c] });
        expect(() => requireCheckUrl(config, c)).not.toThrow();
      });
    }
  }

  for (const c of COMPONENTS) {
    it(`dev/test: a missing ${VARS[c]} for ${c} is allowed (ping simply skipped)`, () => {
      const config = makeTestConfig({ [VARS[c]]: undefined });
      expect(() => requireCheckUrl(config, c)).not.toThrow();
    });
  }
});
