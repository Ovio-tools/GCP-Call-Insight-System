import { describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createMaintenanceController } from '../../src/key-lifecycle/maintenance-controller.js';
import { makeTestConfig } from '../_config.js';

/**
 * `begin()` must be atomic: it sets the Redis maintenance flag and then pauses the queue. If the
 * pause fails, the flag must NOT leak — a stuck flag makes every worker's backstop re-delay jobs
 * forever, stalling the pipeline with no rotation in progress.
 */
describe('createMaintenanceController.begin', () => {
  it('rolls back the maintenance flag when pausing the queue fails', async () => {
    const ops: string[] = [];
    const redis = {
      set: () => {
        ops.push('set');
        return Promise.resolve('OK');
      },
      del: () => {
        ops.push('del');
        return Promise.resolve(1);
      },
    } as unknown as Redis;
    const queue = {
      pause: () => {
        ops.push('pause');
        return Promise.reject(new Error('redis down'));
      },
    } as unknown as Queue;
    const controller = createMaintenanceController({ redis, queue, config: makeTestConfig() });

    await expect(controller.begin()).rejects.toThrow('redis down');
    // Flag set, pause attempted and failed, flag rolled back — never left set.
    expect(ops).toEqual(['set', 'pause', 'del']);
  });
});
