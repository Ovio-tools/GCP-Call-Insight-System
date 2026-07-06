import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSyntheticDialpadFixture } from '../../src/backfill/synthetic-dialpad.js';
import { BackfillError } from '../../src/backfill/errors.js';

async function writeFixture(name: string, body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bf-fixture-'));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(body), 'utf8');
  return path;
}

describe('loadSyntheticDialpadFixture', () => {
  it('loads a valid fixture and lists / fetches from it (no network)', async () => {
    const path = await writeFixture('ok.json', {
      calls: [
        { callId: 'syn-1', startedAt: 1000, endedAt: 2000 },
        { callId: 'syn-2', startedAt: 3000, endedAt: 4000 },
      ],
      transcripts: { 'syn-1': 'hello world transcript', 'syn-2': 'another transcript' },
    });
    const client = await loadSyntheticDialpadFixture(path);
    const page = await client.listRecentlyConcludedCalls({ since: 0 });
    expect(page.calls.map((c) => c.callId).sort()).toEqual(['syn-1', 'syn-2']);
    const t = await client.fetchTranscript('syn-1');
    expect(t.kind).toBe('ready');
    if (t.kind === 'ready') expect(t.transcript).toContain('hello world');
  });

  it('filters the listed page by started_after (since)', async () => {
    const path = await writeFixture('since.json', {
      calls: [
        { callId: 'old', startedAt: 100, endedAt: 200 },
        { callId: 'new', startedAt: 5000, endedAt: 6000 },
      ],
      transcripts: { old: 'x', new: 'y' },
    });
    const client = await loadSyntheticDialpadFixture(path);
    const page = await client.listRecentlyConcludedCalls({ since: 1000 });
    expect(page.calls.map((c) => c.callId)).toEqual(['new']);
  });

  it('rejects a fixture whose transcript would be not-ready, BEFORE the run (R5 #2)', async () => {
    const path = await writeFixture('notready.json', {
      calls: [{ callId: 'syn-1', startedAt: 1000, endedAt: 2000 }],
      transcripts: { 'syn-1': '' }, // empty → would be not_ready
    });
    let caught: unknown;
    try {
      await loadSyntheticDialpadFixture(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackfillError);
    expect((caught as BackfillError).reason).toBe('invalid_synthetic_fixture');
  });

  it('rejects a fixture with a call missing a transcript entry', async () => {
    const path = await writeFixture('missing.json', {
      calls: [{ callId: 'syn-1', startedAt: 1000, endedAt: 2000 }],
      transcripts: {},
    });
    await expect(loadSyntheticDialpadFixture(path)).rejects.toBeInstanceOf(BackfillError);
  });

  it('rejects a malformed fixture (bad JSON / shape)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bf-fixture-'));
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json', 'utf8');
    await expect(loadSyntheticDialpadFixture(path)).rejects.toBeInstanceOf(BackfillError);
  });

  it('rejects a fixture call with no startedAt (backfill requires the scan axis)', async () => {
    const path = await writeFixture('nostart.json', {
      calls: [{ callId: 'syn-1', endedAt: 2000 }],
      transcripts: { 'syn-1': 'x' },
    });
    await expect(loadSyntheticDialpadFixture(path)).rejects.toBeInstanceOf(BackfillError);
  });
});
