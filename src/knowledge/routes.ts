import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { httpFailure } from '../http/failures.js';
import { getCsrfToken, scriptNonce } from '../http/index.js';
import {
  aggregateStructuredKnowledge,
  countStructuredKnowledge,
  listStructuredKnowledgeForExport,
  searchStructuredKnowledge,
  type KnowledgeQueryFilters,
  type KnowledgeReadRow,
} from '../db/repositories/structured-knowledge-repo.js';
import type { KnowledgeExport, KnowledgeRecord, KnowledgeView } from './dto.js';
import {
  makeExportQuerySchema,
  makeViewQuerySchema,
  toEchoedFilters,
  toRepoFilters,
  type EchoedFilters,
} from './query.js';
import {
  scanKnowledgeQuery,
  serializeKnowledgeExport,
  serializeKnowledgeView,
} from './sanitize.js';
import { buildSummary } from './summary.js';
import { buildKnowledgeCsv } from './csv.js';
import { renderKnowledgePage } from './render.js';

/**
 * The authenticated, read-only knowledge-base surface routes (Task 10.1). Mounted on a
 * `createInternalApp` app so auth/sessions/CSRF/rate-limits/body-limits/error-shaping all come from
 * the Task 2.3 middleware; no route opts out with `config.public`. Four GET routes: a paginated HTML
 * view + its JSON twin, and two all-rows exports (CSV, JSON).
 *
 * Every route runs, in order: parse the schema → the pure query scan (BEFORE any DB read or response)
 * → repo read → the matching serialize guard → respond. A residual-PII-shaped `q` fails
 * `REQUEST_MALFORMED` before it can reflect into a response, an export href, the form, or a log.
 */
export interface KnowledgeRouteDeps {
  pool: Pool;
  config: Config;
  denyTerms: readonly string[];
  logger: Logger;
}

/** Map a raw read row to the DTO record (created_at → ISO string). Enum casts are safe: DB CHECK
 * constraints enforce the vocab and the serializer re-parses through zod. */
function toDtoRecord(row: KnowledgeReadRow): KnowledgeRecord {
  return {
    call_id: row.call_id,
    created_at: row.created_at.toISOString(),
    call_intent: row.call_intent as KnowledgeRecord['call_intent'],
    service_category: row.service_category as KnowledgeRecord['service_category'],
    urgency: row.urgency as KnowledgeRecord['urgency'],
    problem_statement: row.problem_statement,
    symptoms: row.symptoms,
    customer_language: row.customer_language,
    concerns: row.concerns,
    competitor_mentions: row.competitor_mentions,
    acquisition_source: row.acquisition_source,
    location_in_home: row.location_in_home,
    access_or_scheduling_notes: row.access_or_scheduling_notes,
    prior_attempts: row.prior_attempts,
  };
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): void {
  const { pool, config, denyTerms } = deps;
  const env = config.NODE_ENV;
  const viewSchema = makeViewQuerySchema(config);
  const exportSchema = makeExportQuerySchema();

  /** Parse + scan the free text, throwing REQUEST_MALFORMED before any DB read. Returns the echoed
   * filters and the repo filters. */
  function guard(parsed: EchoedFilters): { echoed: EchoedFilters; filters: KnowledgeQueryFilters } {
    const echoed = toEchoedFilters(parsed);
    const scan = scanKnowledgeQuery(echoed, denyTerms);
    if (!scan.safe) throw httpFailure('REQUEST_MALFORMED', env);
    return { echoed, filters: toRepoFilters(parsed) };
  }

  async function buildView(
    parsed: { page: number; page_size: number } & EchoedFilters,
  ): Promise<KnowledgeView> {
    const { echoed, filters } = guard(parsed);
    const total = await countStructuredKnowledge(pool, filters);
    const totalPages = total === 0 ? 0 : Math.ceil(total / parsed.page_size);
    const offset = (parsed.page - 1) * parsed.page_size;
    const rows = await searchStructuredKnowledge(pool, filters, {
      limit: parsed.page_size,
      offset,
    });
    const aggregate = await aggregateStructuredKnowledge(pool, filters);
    const view: KnowledgeView = {
      filters: echoed,
      page: parsed.page,
      page_size: parsed.page_size,
      total,
      total_pages: totalPages,
      results: rows.map(toDtoRecord),
      summary: buildSummary(aggregate),
    };
    return serializeKnowledgeView(view, denyTerms);
  }

  /** Assemble the all-rows export DTO + the truncation signal (cap+1 detection). */
  async function buildExport(
    parsed: EchoedFilters,
  ): Promise<{ dto: KnowledgeExport; truncated: boolean; total: number }> {
    const { echoed, filters } = guard(parsed);
    const cap = config.KNOWLEDGE_MAX_EXPORT_ROWS;
    const rows = await listStructuredKnowledgeForExport(pool, filters, { cap });
    const truncated = rows.length > cap;
    const kept = truncated ? rows.slice(0, cap) : rows;
    const total = truncated ? await countStructuredKnowledge(pool, filters) : rows.length;
    const dto: KnowledgeExport = {
      filters: echoed,
      total,
      truncated,
      results: kept.map(toDtoRecord),
    };
    return { dto: serializeKnowledgeExport(dto, denyTerms), truncated, total };
  }

  /** Parse a view request or throw REQUEST_MALFORMED. */
  function parseView(query: unknown): { page: number; page_size: number } & EchoedFilters {
    const parsed = viewSchema.safeParse(query ?? {});
    if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);
    return parsed.data;
  }

  /** Parse an export request (rejects page/page_size via `.strict()`) or throw REQUEST_MALFORMED. */
  function parseExport(query: unknown): EchoedFilters {
    const parsed = exportSchema.safeParse(query ?? {});
    if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);
    return parsed.data;
  }

  // --- View (HTML) ---
  app.get('/knowledge', async (request, reply) => {
    const dto = await buildView(parseView(request.query));
    const html = renderKnowledgePage(dto, {
      csrfToken: getCsrfToken(request) ?? '',
      nonce: scriptNonce(reply),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // --- View (JSON) ---
  app.get('/knowledge.json', async (request, reply) => {
    const dto = await buildView(parseView(request.query));
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });

  // --- Export (CSV) ---
  app.get('/knowledge/export.csv', async (request, reply) => {
    const { dto, truncated, total } = await buildExport(parseExport(request.query));
    const csv = buildKnowledgeCsv(dto.results);
    return sendCsv(reply, csv, { truncated, returned: dto.results.length, total });
  });

  // --- Export (JSON) ---
  app.get('/knowledge/export.json', async (request, reply) => {
    const { dto } = await buildExport(parseExport(request.query));
    return reply
      .header('Content-Disposition', 'attachment; filename="knowledge-export.json"')
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(dto));
  });
}

/** Send the CSV body with the attachment + truncation headers (body stays header + record rows). */
function sendCsv(
  reply: FastifyReply,
  csv: string,
  meta: { truncated: boolean; returned: number; total: number },
): FastifyReply {
  return reply
    .header('Content-Disposition', 'attachment; filename="knowledge-export.csv"')
    .header('X-Export-Truncated', String(meta.truncated))
    .header('X-Export-Returned-Rows', String(meta.returned))
    .header('X-Export-Total-Rows', String(meta.total))
    .type('text/csv; charset=utf-8')
    .send(csv);
}
