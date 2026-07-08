import { describe, expect, it } from 'vitest';
import { residualScan } from '../../src/redaction/residual-scan.js';
import { transcriptToRedactableText } from '../../src/redaction/transcript-text.js';

/** A realistic Dialpad `lines[]` transcript: spoken `content` plus per-line STRUCTURAL
 *  metadata (epoch-ms `time`, numeric `user_id`) that is NOT customer speech. */
const linesTranscript = JSON.stringify({
  call_id: 123,
  lines: [
    { name: 'Agent', content: 'How can I help you today', time: 1700000000123, user_id: 42 },
    { name: 'Customer', content: 'the water heater is leaking', time: 1700000009999, user_id: 88 },
  ],
});

describe('transcriptToRedactableText', () => {
  it('extracts spoken content from a lines[] transcript, dropping structural metadata numerics', () => {
    const text = transcriptToRedactableText(linesTranscript);
    expect(text).toContain('How can I help you today');
    expect(text).toContain('the water heater is leaking');
    // The epoch-ms timestamps and numeric user ids are envelope metadata, not speech.
    expect(text).not.toContain('1700000000123');
    expect(text).not.toContain('1700000009999');
    expect(text).not.toContain('user_id');
  });

  it('keeps speaker names so they still flow through redaction/scan (fail-closed on PII names)', () => {
    const text = transcriptToRedactableText(linesTranscript);
    expect(text).toContain('Agent');
    expect(text).toContain('Customer');
  });

  it('the extracted text no longer floods the residual scan with metadata digit runs', () => {
    // The whole point: scanning the raw JSON envelope trips digit_run on every epoch-ms
    // timestamp; scanning the extracted spoken content does not.
    const rawDigitRuns = residualScan({
      redactedText: linesTranscript,
      vaultPlaintexts: [],
      denyTerms: [],
    }).counts.digit_run;
    expect(rawDigitRuns).toBeGreaterThanOrEqual(2); // the two epoch timestamps

    const extracted = transcriptToRedactableText(linesTranscript);
    const extractedDigitRuns =
      residualScan({ redactedText: extracted, vaultPlaintexts: [], denyTerms: [] }).counts
        .digit_run ?? 0;
    expect(extractedDigitRuns).toBe(0);
  });

  it('skips Dialpad AI moment lines — their content is a label, not speech', () => {
    // Observed on real staging payloads (follow-up #31): lines with type "moment"
    // carry labels like "ner"/"call_purpose" as content. Repeated labels get one
    // vaulted (NER tags them) and the rest reintroduced -> spurious residual holds.
    const withMoments = JSON.stringify({
      call_id: 456,
      lines: [
        { name: 'Agent', content: 'How can I help you today', type: 'transcript' },
        { name: 'Agent', content: 'ner', type: 'moment' },
        { name: 'Agent', content: 'call_purpose', type: 'moment' },
        { name: 'Customer', content: 'the water heater is leaking', type: 'transcript' },
        { name: 'Customer', content: 'pii_number', type: 'moment' },
      ],
    });
    const text = transcriptToRedactableText(withMoments);
    expect(text).toContain('How can I help you today');
    expect(text).toContain('the water heater is leaking');
    expect(text).not.toContain('ner');
    expect(text).not.toContain('call_purpose');
    expect(text).not.toContain('pii_number');
  });

  it('keeps lines with unknown or absent types (fail safe: scan MORE, not less)', () => {
    const unknownTypes = JSON.stringify({
      lines: [
        { name: 'Agent', content: 'words with no type field' },
        { name: 'Customer', content: 'words with a novel type', type: 'sentence' },
      ],
    });
    const text = transcriptToRedactableText(unknownTypes);
    expect(text).toContain('words with no type field');
    expect(text).toContain('words with a novel type');
  });

  it('falls back to RAW when a lines[] envelope contains ONLY moment lines', () => {
    const momentsOnly = JSON.stringify({
      lines: [{ name: 'Agent', content: 'ner', type: 'moment' }],
    });
    expect(transcriptToRedactableText(momentsOnly)).toBe(momentsOnly);
  });

  it('returns a flat `transcript` string as-is', () => {
    const flat = JSON.stringify({ call_id: 1, transcript: 'plain spoken words about a job' });
    expect(transcriptToRedactableText(flat)).toBe('plain spoken words about a job');
  });

  it('falls back to the RAW string for non-JSON transcripts (never redacts LESS than before)', () => {
    const plain = 'just a plain-text transcript mentioning 5551234567';
    expect(transcriptToRedactableText(plain)).toBe(plain);
  });

  it('falls back to the RAW string for an unrecognised JSON shape (fail-safe)', () => {
    const weird = JSON.stringify({ some: 'unknown', shape: [1, 2, 3] });
    expect(transcriptToRedactableText(weird)).toBe(weird);
  });

  it('falls back to RAW when a lines[] envelope carries no spoken content at all', () => {
    const emptyContent = JSON.stringify({ lines: [{ name: 'Agent', time: 1700000000000 }] });
    expect(transcriptToRedactableText(emptyContent)).toBe(emptyContent);
  });

  it('preserves PII inside spoken content so it is still redacted downstream', () => {
    const raw = JSON.stringify({
      lines: [{ name: 'Customer', content: 'my number is 9165551234', time: 1700000000000 }],
    });
    const text = transcriptToRedactableText(raw);
    expect(text).toContain('9165551234');
    expect(
      residualScan({ redactedText: text, vaultPlaintexts: [], denyTerms: [] }).counts.digit_run,
    ).toBe(1);
  });
});
