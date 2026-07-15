import { describe, expect, it } from 'vitest';
import { classifyDedupRow } from '../../src/scripts/dedupe-call-legs-core.js';

describe('classifyDedupRow', () => {
  it('keeps a real call (canonical equals leg id)', () => {
    expect(classifyDedupRow('c1', { kind: 'ready', transcript: 'T', canonicalCallId: 'c1' }, true))
      .toEqual({ action: 'keep' });
  });
  it('unresolved when the transcript is unavailable', () => {
    expect(classifyDedupRow('c1', { kind: 'not_ready' }, false))
      .toEqual({ action: 'unresolved', why: 'transcript_unavailable' });
  });
  it('unresolved when canonical id is absent', () => {
    expect(classifyDedupRow('c1', { kind: 'ready', transcript: 'T' }, false))
      .toEqual({ action: 'unresolved', why: 'no_canonical_id' });
  });
  it('canonical_missing when the canonical row is absent', () => {
    expect(classifyDedupRow('leg', { kind: 'ready', transcript: 'T', canonicalCallId: 'master' }, false))
      .toEqual({ action: 'canonical_missing', canonicalCallId: 'master' });
  });
  it('supersede when leg differs and canonical exists', () => {
    expect(classifyDedupRow('leg', { kind: 'ready', transcript: 'T', canonicalCallId: 'master' }, true))
      .toEqual({ action: 'supersede', canonicalCallId: 'master' });
  });
});
