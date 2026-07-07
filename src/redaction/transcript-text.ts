import { transcriptResponseSchema } from '../dialpad/client/schemas.js';

/**
 * Derive the redaction INPUT — the spoken conversation text — from a stored raw
 * transcript blob (Task 4.1 privacy boundary).
 *
 * The raw blob is the verbatim Dialpad response, kept envelope-encrypted for audit
 * (`raw_transcripts`). Its JSON envelope carries per-line STRUCTURAL metadata —
 * epoch-ms `time`, numeric `user_id` — that is not customer speech. Redacting and
 * residual-scanning the whole envelope makes the scan hold every real call on
 * metadata `digit_run`s (a single lines[] body has one 13-digit epoch timestamp per
 * line). This extracts only the human text fields (`lines[].content` plus the
 * speaker `name`), so the redactor and the independent residual scan see what the
 * model will see — the conversation, not the transport envelope.
 *
 * Egress-safe by construction: the clean transcript is derived ONLY from what this
 * returns, and everything this returns (content + speaker names) still passes
 * through the full detector stack + residual scan. Dropping non-content fields can
 * only REDUCE what reaches the clean store, never leak — a field we don't extract
 * never becomes model-visible text.
 *
 * Fail-safe: any blob that is not a recognised transcript envelope (a plain-text
 * transcript, an unknown JSON shape, or a lines[] body with no spoken content) falls
 * back to the RAW string unchanged. We never redact LESS than the pre-existing
 * whole-blob behaviour on an unrecognised shape.
 */
export function transcriptToRedactableText(raw: string): string {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Not JSON — a flat plain-text transcript. Redact it verbatim, as before.
    return raw;
  }

  const parsed = transcriptResponseSchema.safeParse(json);
  if (!parsed.success) return raw;

  const { lines, transcript } = parsed.data;

  if (Array.isArray(lines)) {
    const parts: string[] = [];
    for (const line of lines) {
      const content = typeof line.content === 'string' ? line.content.trim() : '';
      if (content.length === 0) continue;
      const name = typeof line.name === 'string' ? line.name.trim() : '';
      parts.push(name.length > 0 ? `${name}: ${content}` : content);
    }
    const text = parts.join('\n');
    // A lines[] container with no spoken content is unrecognised for our purposes —
    // fall back rather than hand the redactor an empty string.
    if (text.length > 0) return text;
  }

  if (typeof transcript === 'string' && transcript.trim().length > 0) return transcript;

  return raw;
}
