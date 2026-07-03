import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The redact stage's output contract (Task 4.1): downstream model stages read
 * ONLY clean_transcripts — never raw_transcripts, never the vault. This guard
 * makes the contract mechanical: it parses the import specifiers of every module
 * under src/pipeline/ and fails if anything outside the allowlist imports a
 * module that exposes raw/vault access — including BARRELS (`db/index.js`,
 * `db/repositories/index.js`, `db/restricted/*`) which re-export them. Pipeline
 * modules must import the specific repos they are allowed to touch
 * (clean-transcripts-repo, call-state-repo, model-invocations-repo, ...).
 * No live DB needed; future classify/extract code physically can't reach raw
 * text or the vault.
 */
const PIPELINE_DIR = fileURLToPath(new URL('../../src/pipeline/', import.meta.url));

/** Modules that legitimately touch raw transcripts / the vault. `mark-retention-eligible.ts`
 * (Task 5.3) stamps their retention METADATA only — no decrypt, no content, no token→value
 * read — but still addresses both tables, so it belongs on the allowlist. */
const ALLOWLIST = new Set(['fetch-transcript.ts', 'redact.ts', 'mark-retention-eligible.ts']);

/** Import specifiers (relative to src/pipeline/) that expose raw/vault access. */
const FORBIDDEN_SPECIFIER =
  /(?:^|\/)db\/(?:index\.js|repositories\/(?:index\.js|raw-transcripts-repo\.js)|restricted\/[^'"]*)$/;

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

describe('model-stage import guard', () => {
  it('pipeline modules other than fetch-transcript/redact cannot reach raw transcripts or the vault', () => {
    const files = readdirSync(PIPELINE_DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const offenders: string[] = [];
    for (const rel of files) {
      if (ALLOWLIST.has(rel)) continue;
      const source = readFileSync(join(PIPELINE_DIR, rel), 'utf8');
      for (const m of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = m[1]!;
        if (FORBIDDEN_SPECIFIER.test(specifier)) {
          offenders.push(`${rel} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard itself recognizes the forbidden shapes (self-test)', () => {
    for (const bad of [
      '../db/index.js',
      '../db/repositories/index.js',
      '../db/repositories/raw-transcripts-repo.js',
      '../db/restricted/token-vault-repo.js',
      '../db/restricted/restricted-context.js',
      '../db/restricted/index.js',
    ]) {
      expect(FORBIDDEN_SPECIFIER.test(bad), bad).toBe(true);
    }
    for (const ok of [
      '../db/repositories/clean-transcripts-repo.js',
      '../db/repositories/call-state-repo.js',
      '../db/repositories/model-invocations-repo.js',
      '../db/enums.js',
      './stages.js',
    ]) {
      expect(FORBIDDEN_SPECIFIER.test(ok), ok).toBe(false);
    }
  });
});
