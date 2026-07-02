import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createDialpadClient } from '../../../src/dialpad/client/client.js';
import type { Limiter } from '../../../src/dialpad/client/limiter.js';
import { createRootLogger } from '../../../src/logging/logger.js';
import { makeTestConfig } from '../../_config.js';

const passLimiter: Limiter = { acquire: () => Promise.resolve() };

/** A recognisable transcript body with planted "content" + fake PII we must never leak. */
const PLANTED = 'CUSTOMER_SAID_secret_account_9999 and my SSN is 111-22-3333';

function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createRootLogger> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createRootLogger({ level: 'debug', destination: stream });
  return { lines, logger };
}

describe('Dialpad client never leaks transcript content', () => {
  it('keeps planted content out of retry logs and thrown error messages', async () => {
    const { lines, logger } = collectingLogger();
    const config = makeTestConfig({
      DIALPAD_API_KEY: 'k',
      DIALPAD_API_MAX_RETRIES: 2,
      DIALPAD_API_BACKOFF_MS: 1,
    });

    // First a 5xx whose body echoes the planted content (Dialpad error pages can), then a
    // 200 whose body is NOT valid transcript JSON but contains the planted content — forcing
    // an api_changed whose error must stay generic.
    let i = 0;
    const responses = [
      new Response(PLANTED, { status: 503 }),
      new Response(`<html>${PLANTED}</html>`, { status: 200 }),
    ];
    const fetchImpl = vi.fn(() => Promise.resolve(responses[Math.min(i++, responses.length - 1)]));

    const client = createDialpadClient({
      config,
      limiter: passLimiter,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    let thrown: unknown;
    try {
      await client.fetchTranscript('c-1');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(PLANTED);
    expect((thrown as Error).message).not.toContain('secret_account_9999');
    // Nothing the client logged (retry warnings, etc.) may contain the planted content.
    expect(lines.join('')).not.toContain(PLANTED);
    expect(lines.join('')).not.toContain('secret_account_9999');
    expect(lines.join('')).not.toContain('111-22-3333');
  });

  it('returns ready transcript content only as the value, never logging it', async () => {
    const { lines, logger } = collectingLogger();
    const config = makeTestConfig({ DIALPAD_API_KEY: 'k' });
    const body = JSON.stringify({ lines: [{ content: PLANTED }] });
    const fetchImpl = vi.fn((_url: string) => Promise.resolve(new Response(body, { status: 200 })));

    const client = createDialpadClient({
      config,
      limiter: passLimiter,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.fetchTranscript('c-1');
    // The content is faithfully returned (to be encrypted at rest by the caller)...
    expect(result).toMatchObject({ kind: 'ready' });
    // ...but it was never written to a log line.
    expect(lines.join('')).not.toContain(PLANTED);
  });
});
