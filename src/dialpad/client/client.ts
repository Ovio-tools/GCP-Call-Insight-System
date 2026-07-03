import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import { buildDialpadAuthHeaders, requireDialpadApiKey } from './auth.js';
import { DialpadError } from './errors.js';
import type { Limiter } from './limiter.js';
import {
  classifyTranscript,
  recentCallsResponseSchema,
  transcriptResponseSchema,
} from './schemas.js';

/** The result of a transcript fetch. `ready` carries the raw transcript body (encrypted at rest). */
export type TranscriptResult = { kind: 'ready'; transcript: string } | { kind: 'not_ready' };

/** A recently-concluded call — metadata ONLY, no transcript, no PII. */
export interface RecentCall {
  callId: string;
  state?: string;
  direction?: string;
  duration?: number;
  /** Epoch ms the call CONCLUDED, when Dialpad provides `date_ended` in a parseable form.
   * Absent for in-progress calls (no end yet) and for unrecognised formats — consumers must
   * fail open on absence (the field name is provisional; see schemas.ts). */
  endedAt?: number;
}

export interface RecentCallsPage {
  calls: RecentCall[];
  /** Opaque cursor to fetch the next page, when more results remain. */
  cursor?: string;
}

export interface DialpadClient {
  /** Fetch the AI transcript for a call. Ready → raw body; not-ready → caller waits/retries. */
  fetchTranscript(callId: string): Promise<TranscriptResult>;
  /** List recently-concluded calls (metadata only) for the reconciliation sweep. */
  listRecentlyConcludedCalls(opts: {
    since: Date | number;
    cursor?: string;
    limit?: number;
  }): Promise<RecentCallsPage>;
}

type FetchImpl = typeof fetch;

export interface CreateDialpadClientOptions {
  config: Config;
  /** Shared rate limiter (Redis-backed in production; process-local in tests). */
  limiter: Limiter;
  logger?: Logger;
  /** Injectable fetch so tests never touch the network. Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Injectable backoff sleep so retry tests are instant/deterministic. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for full-jitter backoff. Defaults to `Math.random`. */
  random?: () => number;
  /**
   * Test-only escape hatch: skip the construction-time DIALPAD_API_KEY fail-fast check.
   * Production callers NEVER set this, so startup validation is independent of whether a
   * custom/instrumented `fetchImpl` is injected. Tests that intentionally run keyless set it.
   */
  skipAuthValidationForTests?: boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse Dialpad's `date_ended` (epoch ms number, numeric string, or ISO string) into epoch
 * ms; undefined when absent or unrecognisable — never a throw, the sweep fails open. */
function parseEndedAt(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  const asNumber = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : undefined;
}

/** Parse a `Retry-After` header (integer seconds) into ms, or null if absent/unparseable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/**
 * Build a Dialpad client bound to `config`'s base URL, credentials, timeouts and retry
 * budget. The client is a pure HTTP boundary: no DB, no failure-model — it throws
 * {@link DialpadError} (PII-free) and lets the caller map to the shared failure model.
 */
export function createDialpadClient(opts: CreateDialpadClientOptions): DialpadClient {
  const { config, limiter } = opts;
  // Fail fast at construction (i.e. worker / reconciliation-cron startup): a missing
  // DIALPAD_API_KEY must surface as CONFIG_MISSING_OR_INVALID now, not on the first request.
  // Always validated unless a test explicitly opts out — never inferred from fetchImpl.
  if (opts.skipAuthValidationForTests !== true) requireDialpadApiKey(config);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const base = config.DIALPAD_BASE_URL.replace(/\/+$/, '');
  const maxRetries = config.DIALPAD_API_MAX_RETRIES;

  /** Full-jitter exponential backoff; a present Retry-After wins. */
  function backoffMs(retryIndex: number, retryAfter: number | null): number {
    if (retryAfter !== null) return retryAfter;
    const raw = config.DIALPAD_API_BACKOFF_MS * 2 ** retryIndex;
    return Math.floor(random() * raw);
  }

  async function fetchOnce(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.DIALPAD_API_TIMEOUT_MS);
    try {
      return await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One request with the full limiter + retry policy. 401/403 → auth (no retry). 429 and
   * 5xx/network/timeout are retried with backoff, then surfaced as rate_limited / unavailable.
   * An unexpected non-404 4xx is a contract change. 2xx and 404 are returned to the caller.
   */
  async function request(
    endpoint: string,
    path: string,
  ): Promise<{ status: number; text: string }> {
    const url = `${base}${path}`;
    const headers = buildDialpadAuthHeaders(config);
    let attempts = 0;

    for (;;) {
      await limiter.acquire();

      let res: Response | undefined;
      try {
        res = await fetchOnce(url, headers);
      } catch {
        // Network error or timeout (AbortController). PII-free — never inspect the cause.
        res = undefined;
      }
      attempts += 1;

      // Transient: network/timeout, or a 5xx. Retry within budget, else unavailable.
      if (res === undefined || res.status >= 500) {
        if (attempts <= maxRetries) {
          opts.logger?.warn(
            { endpoint, status: res?.status ?? null, attempt: attempts },
            'dialpad request transient failure — retrying',
          );
          await sleep(backoffMs(attempts - 1, null));
          continue;
        }
        throw new DialpadError('unavailable', {
          endpoint,
          ...(res !== undefined ? { status: res.status } : {}),
          attempts,
        });
      }

      if (res.status === 401 || res.status === 403) {
        throw new DialpadError('auth', { endpoint, status: res.status, attempts });
      }

      if (res.status === 429) {
        if (attempts <= maxRetries) {
          opts.logger?.warn(
            { endpoint, status: 429, attempt: attempts },
            'dialpad rate-limited — backing off',
          );
          await sleep(backoffMs(attempts - 1, retryAfterMs(res)));
          continue;
        }
        throw new DialpadError('rate_limited', { endpoint, status: 429, attempts });
      }

      // An unexpected client error (e.g. 400/422) means the request/response contract moved.
      if (res.status >= 400 && res.status !== 404) {
        throw new DialpadError('api_changed', { endpoint, status: res.status, attempts });
      }

      return { status: res.status, text: await res.text() };
    }
  }

  return {
    async fetchTranscript(callId: string): Promise<TranscriptResult> {
      const { status, text } = await request(
        'transcripts',
        `/transcripts/${encodeURIComponent(callId)}`,
      );
      // 404 = the transcript resource isn't there yet; not a failure, the caller waits.
      if (status === 404) return { kind: 'not_ready' };

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new DialpadError('api_changed', { endpoint: 'transcripts', status, attempts: 1 });
      }
      const parsed = transcriptResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new DialpadError('api_changed', { endpoint: 'transcripts', status, attempts: 1 });
      }
      const readiness = classifyTranscript(parsed.data);
      // A shape we don't recognise is a contract change, surfaced now — not hidden as a
      // transcript that never becomes ready.
      if (readiness === 'unrecognized') {
        throw new DialpadError('api_changed', { endpoint: 'transcripts', status, attempts: 1 });
      }
      if (readiness === 'not_ready') return { kind: 'not_ready' };

      // Store the RAW response body verbatim — the faithful "original transcript text" the
      // redaction stage will work from. It is encrypted at rest by putTranscript and is never
      // logged. (The parse above is only to decide readiness.)
      return { kind: 'ready', transcript: text };
    },

    async listRecentlyConcludedCalls(o): Promise<RecentCallsPage> {
      const sinceMs = typeof o.since === 'number' ? o.since : o.since.getTime();
      const params = new URLSearchParams({ started_after: String(sinceMs) });
      if (o.cursor !== undefined) params.set('cursor', o.cursor);
      if (o.limit !== undefined) params.set('limit', String(o.limit));

      const { status, text } = await request('calls', `/calls?${params.toString()}`);
      if (status !== 200) {
        throw new DialpadError('api_changed', { endpoint: 'calls', status, attempts: 1 });
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new DialpadError('api_changed', { endpoint: 'calls', status, attempts: 1 });
      }
      const parsed = recentCallsResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new DialpadError('api_changed', { endpoint: 'calls', status, attempts: 1 });
      }

      const calls: RecentCall[] = parsed.data.items.map((item) => {
        const endedAt = parseEndedAt(item.date_ended);
        return {
          callId: String(item.call_id),
          ...(item.state !== undefined ? { state: item.state } : {}),
          ...(item.direction !== undefined ? { direction: item.direction } : {}),
          ...(item.duration !== undefined ? { duration: item.duration } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
        };
      });
      return { calls, ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}) };
    },
  };
}
