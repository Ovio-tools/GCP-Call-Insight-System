import type { Redis } from 'ioredis';
import { createQueueConnection } from '../../src/queue/connection.js';

/** Set only when a real Redis is available. Absent locally → queue tests skip. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const hasTestRedis = Boolean(TEST_REDIS_URL);

/** A BullMQ-shaped connection bound to the test Redis. Callers quit() it in cleanup. */
export function makeQueueConnection(): Redis {
  return createQueueConnection(TEST_REDIS_URL as string);
}
