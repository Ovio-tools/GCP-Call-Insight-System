/** The authenticated note-review surface (ADR 0009) — see `routes.ts` for the invariants. */
export { registerNotesRoutes, type NotesRouteDeps } from './routes.js';
export {
  noteDetailSchema,
  noteFeedbackRequestSchema,
  noteFeedbackResponseSchema,
  noteListSchema,
  noteTallySchema,
  noteTranscriptSchema,
  type NoteDetail,
  type NoteFeedbackRequest,
  type NoteFeedbackResponse,
  type NoteList,
  type NoteListItem,
  type NoteTally,
  type NoteTranscript,
  type NoteVerdict,
} from './dto.js';
export {
  makeListQuerySchema,
  toEchoedFilters,
  toRepoFilters,
  type EchoedNoteFilters,
} from './query.js';
export {
  scanNoteQuery,
  scanFreeTextValue,
  sanitizeNoteDetail,
  serializeNoteDetail,
  serializeNoteList,
  serializeTranscript,
} from './sanitize.js';
export { renderNoteDetailPage, renderNoteMissingPage, renderNotesListPage } from './render.js';
