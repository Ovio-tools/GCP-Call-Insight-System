import { describe, expect, it } from 'vitest';
import {
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SCHEMA_VERSION,
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserMessage,
} from '../../../src/pipeline/extract/prompt.js';

describe('extract prompt versions', () => {
  it('pins the prompt and schema versions', () => {
    expect(EXTRACT_PROMPT_VERSION).toBe('extract-v1');
    expect(EXTRACT_SCHEMA_VERSION).toBe(1);
  });
});

describe('EXTRACT_SYSTEM_PROMPT', () => {
  it('frames the transcript as untrusted data, not instructions', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('UNTRUSTED DATA');
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/<transcript>/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/must be IGNORED/);
  });

  it('requires a single JSON object with no fences', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('SINGLE JSON object');
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/no markdown code\s*\n?\s*fences/i);
  });

  it('prohibits confidence scores and extra fields', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/No confidence, ever\./);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/probabilities/i);
  });

  it('instructs no redaction tokens or PII in customer_language', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/VERBATIM, PII-FREE/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/NO\s+redaction tokens/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/EMPTY array/);
  });

  it('instructs to pick the more urgent value when torn', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/pick the MORE urgent/i);
  });

  it('instructs null (not a guess) for the nullable fields', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/NEVER guess/);
    expect(EXTRACT_SYSTEM_PROMPT).toContain('location_in_home');
  });

  it('never contains injected transcript text', () => {
    expect(EXTRACT_SYSTEM_PROMPT).not.toContain('MARKER_TRANSCRIPT_TEXT');
  });
});

describe('buildExtractUserMessage', () => {
  it('wraps the marker inside <transcript> tags', () => {
    const msg = buildExtractUserMessage('MARKER_TRANSCRIPT_TEXT');
    expect(msg).toContain('<transcript>');
    expect(msg).toContain('</transcript>');
    expect(msg).toContain('MARKER_TRANSCRIPT_TEXT');
    const start = msg.indexOf('<transcript>');
    const end = msg.indexOf('</transcript>');
    const marker = msg.indexOf('MARKER_TRANSCRIPT_TEXT');
    expect(marker).toBeGreaterThan(start);
    expect(marker).toBeLessThan(end);
  });

  it('marks the transcript as data, not instructions', () => {
    expect(buildExtractUserMessage('x')).toMatch(/data, not instructions/);
  });

  it('the system prompt does NOT contain the transcript marker', () => {
    buildExtractUserMessage('MARKER_TRANSCRIPT_TEXT');
    expect(EXTRACT_SYSTEM_PROMPT).not.toContain('MARKER_TRANSCRIPT_TEXT');
  });
});
