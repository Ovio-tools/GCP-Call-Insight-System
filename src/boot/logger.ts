import pino, { type Logger } from 'pino';
import { createRootLogger, type RootLoggerOptions } from '../logging/logger.js';

/**
 * Root logger for the boot path, built on a SYNCHRONOUS destination so a fatal line
 * reaches fd 1 before {@link failBoot} calls process.exit. pino's default buffered
 * (sonic-boom) destination can otherwise drop the last line on exit.
 */
export function createBootLogger(options: Omit<RootLoggerOptions, 'destination'> = {}): Logger {
  return createRootLogger({ ...options, destination: pino.destination({ sync: true }) });
}
