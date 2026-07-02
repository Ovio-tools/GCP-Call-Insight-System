import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDenyListDetector, loadDenyList } from '../../src/redaction/deny-list.js';
import type { Detection } from '../../src/redaction/types.js';

function surface(text: string, d: Detection): string {
  return text.slice(d.start, d.end);
}

const dir = mkdtempSync(join(tmpdir(), 'deny-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadDenyList', () => {
  it('loads newline-delimited terms, skipping comments and blanks', () => {
    const path = join(dir, 'deny.txt');
    writeFileSync(
      path,
      '# client-specific terms\nAcme Plumbing\n\n  Golden State HVAC  \n# another comment\nRiverside\n',
    );
    expect(loadDenyList(path)).toEqual(['Acme Plumbing', 'Golden State HVAC', 'Riverside']);
  });

  it('returns an empty list when no path is configured', () => {
    expect(loadDenyList(undefined)).toEqual([]);
  });

  it('throws naming REDACTION_DENY_LIST_PATH for an unreadable path', () => {
    expect(() => loadDenyList('/nonexistent/deny.txt')).toThrow(/REDACTION_DENY_LIST_PATH/);
  });
});

describe('createDenyListDetector', () => {
  const detector = createDenyListDetector(['Acme Plumbing', 'Golden State HVAC']);

  it.each([
    ['we used Acme Plumbing before', 'Acme Plumbing'],
    ['we used acme  plumbing before', 'acme  plumbing'],
    ['we used ACME-PLUMBING before', 'ACME-PLUMBING'],
    ['we used Acme. Plumbing, before', 'Acme. Plumbing,'],
  ])('matches case/space/punctuation variants in %s', async (text, expected) => {
    const { detections } = await detector.detect(text);
    expect(detections).toHaveLength(1);
    expect(
      surface(text, detections[0]!)
        .trim()
        .replace(/[.,]+$/, ''),
    ).toBe(expected.trim().replace(/[.,]+$/, ''));
    expect(detections[0]!.entityType).toBe('deny_list');
    expect(detections[0]!.detector).toBe('deny_list');
  });

  it('maps normalized matches back to correct original offsets', async () => {
    const text = 'ok — golden   state hvac did the last job';
    const { detections } = await detector.detect(text);
    expect(detections).toHaveLength(1);
    expect(surface(text, detections[0]!)).toContain('golden   state hvac');
  });

  it('finds multiple, non-overlapping hits', async () => {
    const text = 'Acme Plumbing quoted less than Golden State HVAC';
    const { detections } = await detector.detect(text);
    expect(detections).toHaveLength(2);
  });

  it('does not match unrelated text and emits no risk signals', async () => {
    const { detections, riskSignals } = await detector.detect('the heater is out again');
    expect(detections).toHaveLength(0);
    expect(riskSignals).toHaveLength(0);
  });

  it('handles an empty term list', async () => {
    const empty = createDenyListDetector([]);
    const { detections } = await empty.detect('Acme Plumbing called');
    expect(detections).toHaveLength(0);
  });
});
