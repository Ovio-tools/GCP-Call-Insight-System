import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { httpFailure } from '../http/failures.js';
import { getCsrfToken, scriptNonce } from '../http/index.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import {
  countTechnicianNotes,
  getTechnicianNoteDetail,
  searchTechnicianNotes,
  type NoteDetailReadRow,
  type NoteListReadRow,
  type NoteQueryFilters,
} from '../db/repositories/technician-notes-repo.js';
import {
  getLatestNoteFeedback,
  getReviewerTally,
  recordNoteFeedback,
} from '../db/repositories/note-feedback-repo.js';
import { TECHNICIAN_NOTE_PROMPT_VERSION } from '../technician-notes/prompt.js';
import {
  noteFeedbackRequestSchema,
  type NoteDetail,
  type NoteList,
  type NoteListItem,
  type NoteTally,
  type NoteVerdict,
} from './dto.js';
import {
  makeListQuerySchema,
  toEchoedFilters,
  toRepoFilters,
  type EchoedNoteFilters,
} from './query.js';
import {
  scanNoteQuery,
  serializeNoteDetail,
  serializeNoteList,
  serializeTranscript,
} from './sanitize.js';
import { renderNoteDetailPage, renderNoteMissingPage, renderNotesListPage } from './render.js';

/**
 * The authenticated note-review surface (ADR 0009). Mounted on a `createInternalApp` app so
 * auth/sessions/CSRF/rate-limits/body-limits/error-shaping all come from the Task 2.3 middleware;
 * no route opts out with `config.public`, and there is no CSRF code in this file — `requireCsrf` is
 * already a global preHandler by the time any route here runs.
 *
 * Every read route runs, in order: parse the schema → the pure query scan (BEFORE any DB read or
 * response) → repo read → the matching serialize guard → respond.
 *
 * What this surface CANNOT reach, by construction rather than by convention: `raw_transcripts`, the
 * token vault, the key provider, the restricted runner, and the queue. None of them is a dependency
 * and none is imported; `test/notes/module-graph.test.ts` walks the reachable module graph and fails
 * if one ever becomes reachable.
 */
export interface NotesRouteDeps {
  pool: Pool;
  config: Config;
  denyTerms: readonly string[];
  logger: Logger;
}

/** The first line of a dispatch summary — the technician's first impression, which is what the list
 * card judges. Splits at the first newline or sentence end, then bounds the length. */
function firstLine(summary: string | null): string | null {
  if (summary === null) return null;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return null;
  const cut = /^[\s\S]*?[.!?](?=\s|$)|^[^\n]*/.exec(trimmed)?.[0] ?? trimmed;
  const line = cut.trim();
  return line.length > 240 ? `${line.slice(0, 239).trimEnd()}…` : line;
}

function toListItem(row: NoteListReadRow): NoteListItem {
  return {
    call_id: row.call_id,
    created_at: row.created_at.toISOString(),
    // Enum casts are safe: DB CHECK constraints enforce the vocabulary and the serializer re-parses
    // the whole DTO through zod before it leaves.
    service_category: row.service_category as NoteListItem['service_category'],
    urgency: row.urgency as NoteListItem['urgency'],
    dispatch_summary_first_line: firstLine(row.dispatch_summary),
    not_established_count: row.not_established.length,
    review_state: row.review_state,
  };
}

function toDetail(row: NoteDetailReadRow, verdicts: NoteVerdict[], tally: NoteTally): NoteDetail {
  return {
    call_id: row.call_id,
    created_at: row.created_at.toISOString(),
    prompt_version: row.prompt_version,
    service_category: row.service_category as NoteDetail['service_category'],
    urgency: row.urgency as NoteDetail['urgency'],
    scope_signal: row.scope_signal,
    occupancy: row.occupancy,
    equipment: row.equipment,
    system_context: row.system_context,
    water_status: row.water_status,
    payer_authority: row.payer_authority,
    prior_work: row.prior_work,
    commitments_made: row.commitments_made,
    location_on_property: row.location_on_property,
    symptom_verbatim: row.symptom_verbatim,
    prior_attempts_detail: row.prior_attempts_detail,
    access_notes: row.access_notes,
    hazards: row.hazards,
    urgency_context: row.urgency_context,
    not_established: row.not_established,
    dispatch_summary: row.dispatch_summary,
    verdicts,
    tally,
  };
}

export function registerNotesRoutes(app: FastifyInstance, deps: NotesRouteDeps): void {
  const { pool, config, denyTerms } = deps;
  const env = config.NODE_ENV;
  const listSchema = makeListQuerySchema(config);

  /** The signed-in subject, or `AUTH_REQUIRED`. Every route needs it: reads show the reviewer their
   * OWN standing verdicts and tally, and a write must be attributable. */
  function actorOf(request: { user?: { id?: string } }): string {
    const actor = request.user?.id ?? '';
    if (!actor) throw httpFailure('AUTH_REQUIRED', env);
    return actor;
  }

  /** Parse + scan the free-text filters, throwing REQUEST_MALFORMED before any DB read. See
   * `FREE_TEXT_FILTER_KEYS` in `sanitize.ts` for why that set is empty on this surface today and
   * why the seam is kept here anyway. */
  function guard(parsed: EchoedNoteFilters): {
    echoed: EchoedNoteFilters;
    filters: NoteQueryFilters;
  } {
    const echoed = toEchoedFilters(parsed);
    // `EchoedNoteFilters` is a closed interface with no index signature; the scan takes a plain
    // record so it can be given whatever free-text keys a future filter adds without widening
    // that interface. The spread is the conversion, not a cast away from a real type.
    const scan = scanNoteQuery({ ...echoed }, denyTerms);
    if (!scan.safe) throw httpFailure('REQUEST_MALFORMED', env);
    return { echoed, filters: toRepoFilters(parsed) };
  }

  function parseList(query: unknown): { page: number; page_size: number } & EchoedNoteFilters {
    const parsed = listSchema.safeParse(query ?? {});
    if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);
    return parsed.data;
  }

  async function tallyFor(actor: string, promptVersion: string): Promise<NoteTally> {
    const t = await getReviewerTally(pool, {
      reviewerActor: actor,
      notePromptVersion: promptVersion,
    });
    return {
      fields_checked: t.fieldsChecked,
      marked_right: t.markedRight,
      note_prompt_version: promptVersion,
    };
  }

  async function buildList(
    parsed: { page: number; page_size: number } & EchoedNoteFilters,
    actor: string,
  ): Promise<NoteList> {
    const { echoed, filters } = guard(parsed);
    const total = await countTechnicianNotes(pool, filters);
    const totalPages = total === 0 ? 0 : Math.ceil(total / parsed.page_size);
    const rows = await searchTechnicianNotes(pool, filters, {
      limit: parsed.page_size,
      offset: (parsed.page - 1) * parsed.page_size,
    });
    // The LIST tally is scoped to the CURRENT prompt version rather than to any row on the page:
    // it is a standing figure about this reviewer, not about this page of results.
    const list: NoteList = {
      filters: echoed,
      page: parsed.page,
      page_size: parsed.page_size,
      total,
      total_pages: totalPages,
      results: rows.map(toListItem),
      tally: await tallyFor(actor, TECHNICIAN_NOTE_PROMPT_VERSION),
    };
    return serializeNoteList(list, denyTerms);
  }

  /** This reviewer's STANDING verdicts on one note, at that note's own prompt version. Other
   * reviewers' verdicts are persisted and counted by nobody here — the buttons reflect YOUR call. */
  async function verdictsFor(
    callId: string,
    promptVersion: string,
    actor: string,
  ): Promise<NoteVerdict[]> {
    const rows = await getLatestNoteFeedback(pool, callId, promptVersion);
    return rows
      .filter((r) => r.reviewer_actor === actor)
      .map((r) => ({
        field_path: r.field_path,
        verdict: r.verdict,
        corrected_enum_value: r.corrected_enum_value,
      }));
  }

  async function buildDetail(callId: string, actor: string): Promise<NoteDetail | undefined> {
    const row = await getTechnicianNoteDetail(pool, callId);
    if (!row) return undefined;
    const [verdicts, tally] = await Promise.all([
      verdictsFor(callId, row.prompt_version, actor),
      tallyFor(actor, row.prompt_version),
    ]);
    return serializeNoteDetail(toDetail(row, verdicts, tally), denyTerms);
  }

  // --- List (HTML) ---
  app.get('/notes', async (request, reply) => {
    const dto = await buildList(parseList(request.query), actorOf(request));
    const html = renderNotesListPage(dto, {
      csrfToken: getCsrfToken(request) ?? '',
      nonce: scriptNonce(reply),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // --- List (JSON) ---
  app.get('/notes.json', async (request, reply) => {
    const dto = await buildList(parseList(request.query), actorOf(request));
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });

  // --- Detail (HTML) ---
  app.get('/notes/:callId', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    const chrome = { csrfToken: getCsrfToken(request) ?? '', nonce: scriptNonce(reply) };
    const dto = await buildDetail(callId, actorOf(request));
    // A call with no note is an explanation, not an error: the generator counts a missing clean
    // transcript as a SKIP, so "no note" is an ordinary outcome the reader did nothing to cause.
    const html = dto ? renderNoteDetailPage(dto, chrome) : renderNoteMissingPage(chrome);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // --- Detail (JSON) ---
  app.get('/notes/:callId.json', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    const dto = await buildDetail(callId, actorOf(request));
    if (!dto) {
      return reply
        .type('application/json; charset=utf-8')
        .send(JSON.stringify({ available: false, reason: 'no_note' }));
    }
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });

  /**
   * The redacted transcript for the modal.
   *
   * Reads `getCleanTranscript` and NOTHING else — never `raw_transcripts`, never the key provider,
   * never `performReveal`. That repo's WHERE already excludes soft- and hard-deleted rows, so
   * absent / soft-deleted / hard-deleted all collapse to one `undefined`, and all three answer
   * `unavailable` with a 200. A 404 would make an ordinary retention outcome look like a mistake.
   *
   * The response carries NO existence signal: an unknown call id, a call with no note, and a purged
   * transcript are byte-identical, so enumerating ids discloses nothing about which calls exist.
   *
   * `serializeTranscript` fails CLOSED — a residual-scan hit withholds the body entirely rather
   * than sending a partially-trusted transcript.
   */
  app.get('/notes/:callId/transcript.json', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    actorOf(request);
    const row = await getCleanTranscript(pool, callId);
    const dto = serializeTranscript(row?.redacted_text, denyTerms);
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });

  /**
   * Record ONE verdict on ONE field. Appends to `note_feedback`; never mutates `technician_notes`.
   *
   * `note_prompt_version` comes from the NOTE, never from the request (the body schema is
   * `.strict()`, so a client that tries to supply one is rejected) — a verdict is always
   * attributable to the version it was given against.
   */
  app.post('/notes/:callId/feedback', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    const actor = actorOf(request);

    const parsed = noteFeedbackRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);

    const note = await getTechnicianNoteDetail(pool, callId);
    // A verdict on a note that does not exist is a malformed request, not a 404 — same reasoning as
    // the transcript route: no route on this surface gets a code that discloses existence.
    if (!note) throw httpFailure('REQUEST_MALFORMED', env);

    const row = await recordNoteFeedback(pool, {
      callId,
      notePromptVersion: note.prompt_version,
      reviewerActor: actor,
      fieldPath: parsed.data.field_path,
      verdict: parsed.data.verdict,
      correctedEnumValue: parsed.data.corrected_enum_value ?? null,
    });

    return reply.send({
      verdict: {
        field_path: row.field_path,
        verdict: row.verdict,
        corrected_enum_value: row.corrected_enum_value,
      },
      tally: await tallyFor(actor, note.prompt_version),
    });
  });
}
