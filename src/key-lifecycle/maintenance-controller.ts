import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Config } from '../config/schema.js';
import {
  clearMaintenance,
  pauseQueue,
  resumeQueue,
  setMaintenance,
  waitForDrain,
} from './maintenance-lock.js';

/**
 * The pause/drain/resume seam rotation uses (Task 8.2), injectable so the DB-gated rotation test
 * runs without Redis. `begin` sets the Redis flag AND globally pauses the queue; `waitForDrain`
 * polls the active-job count; `end` clears the flag and resumes the queue.
 */
export interface MaintenanceController {
  begin(): Promise<void>;
  waitForDrain(): Promise<boolean>;
  end(): Promise<void>;
}

/** Production controller wiring the real Redis flag + BullMQ queue pause/resume + drain poll. */
export function createMaintenanceController(deps: {
  redis: Redis;
  queue: Queue;
  config: Config;
}): MaintenanceController {
  return {
    async begin() {
      await setMaintenance(deps.redis);
      try {
        await pauseQueue(deps.queue);
      } catch (err) {
        // Never leave the flag set if the pause failed — a stuck flag stalls the pipeline
        // (every worker backstop re-delays forever) with no rotation actually running.
        await clearMaintenance(deps.redis).catch(() => undefined);
        throw err;
      }
    },
    waitForDrain() {
      return waitForDrain(deps.queue, { timeoutMs: deps.config.KEY_ROTATION_DRAIN_TIMEOUT_MS });
    },
    async end() {
      await clearMaintenance(deps.redis);
      await resumeQueue(deps.queue);
    },
  };
}

/** No-op controller for tests / single-node runs where there is no live worker to pause. */
export const noopMaintenance: MaintenanceController = {
  begin: () => Promise.resolve(),
  waitForDrain: () => Promise.resolve(true),
  end: () => Promise.resolve(),
};
