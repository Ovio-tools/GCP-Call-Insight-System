import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Mechanical guard (Finding 6) that the knowledge surface reads ONLY `structured_knowledge`: no
 * knowledge module (or the new read functions in `structured-knowledge-repo.ts`) may import a
 * raw/vault/restricted repo or a db barrel, reference a restricted/raw/webhook table in SQL, or use
 * `SELECT *`. Mirrors `test/pipeline/model-stage-import-guard.test.ts`.
 */
const KNOWLEDGE_DIR = fileURLToPath(new URL('../../src/knowledge/', import.meta.url));
const REPO_FILE = fileURLToPath(
  new URL('../../src/db/repositories/structured-knowledge-repo.ts', import.meta.url),
);
const READ_MODEL_MARKER = '// --- Knowledge-base surface read model (Task 10.1) ---';

/** Import specifiers that expose raw/vault access (db barrels + restricted repos). */
const FORBIDDEN_SPECIFIER =
  /(?:^|\/)db\/(?:index\.js|repositories\/(?:index\.js|raw-transcripts-repo\.js)|restricted\/[^'"]*)$/;
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Tables that must never be referenced by name in knowledge SQL. */
const FORBIDDEN_TABLES = [
  'raw_transcripts',
  'token_vault',
  'match_keys',
  'raw_webhook_events',
  'recording',
];

function knowledgeFiles(): string[] {
  return readdirSync(KNOWLEDGE_DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.ts'),
  );
}

describe('knowledge surface reads only structured_knowledge (Task 10.1)', () => {
  it('no knowledge module imports a raw/vault/restricted repo or db barrel', () => {
    const offenders: string[] = [];
    for (const rel of knowledgeFiles()) {
      const source = readFileSync(join(KNOWLEDGE_DIR, rel), 'utf8');
      for (const m of source.matchAll(IMPORT_SPECIFIER)) {
        if (FORBIDDEN_SPECIFIER.test(m[1]!)) offenders.push(`${rel} -> ${m[1]!}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no knowledge module references a restricted/raw/webhook table by name', () => {
    const offenders: string[] = [];
    for (const rel of knowledgeFiles()) {
      const source = readFileSync(join(KNOWLEDGE_DIR, rel), 'utf8');
      for (const table of FORBIDDEN_TABLES) {
        if (source.includes(table)) offenders.push(`${rel} -> ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the new repo read functions avoid SELECT * and only address structured_knowledge', () => {
    const source = readFileSync(REPO_FILE, 'utf8');
    const idx = source.indexOf(READ_MODEL_MARKER);
    expect(idx, 'read-model section marker present').toBeGreaterThan(-1);
    const readSection = source.slice(idx);

    expect(readSection).not.toContain('SELECT *');
    expect(readSection).toContain('structured_knowledge');
    for (const table of FORBIDDEN_TABLES) {
      expect(readSection, `read section references ${table}`).not.toContain(table);
    }
  });
});
