import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Mechanical guard that the note-review surface can NEVER reach the raw store or the key provider.
 *
 * Unlike `test/knowledge/no-restricted-data.test.ts` and
 * `test/pipeline/model-stage-import-guard.test.ts`, which scan the DIRECT imports of one directory,
 * this walks the module graph TRANSITIVELY from `src/notes/**`. A direct-import scan only proves the
 * surface does not name a forbidden module itself; it says nothing about a helper two hops away that
 * pulls in a barrel. The transitive walk is what makes "this surface cannot decrypt a raw
 * transcript" a property of the build rather than a habit.
 *
 * The forbidden set EXTENDS the knowledge guard's, which predates ADR 0008: raw transcripts and the
 * vault now live in DB-B, reached through `db/raw-store.ts`, and the key material comes from
 * `crypto/` + `key-lifecycle/`. All three are added here.
 *
 * There is deliberately NO allowlist. If this test ever fails, the fix is to stop importing the
 * offending module — not to add an exception.
 */

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const NOTES_DIR = join(SRC_DIR, 'notes');

/**
 * Module paths (relative to `src/`) that expose raw-transcript, vault, or key-material access:
 *  - `db/index.ts` + `db/repositories/index.ts` — barrels that RE-EXPORT the raw/restricted repos,
 *    so importing either hands the caller the whole raw surface.
 *  - `db/raw-store.ts` — the DB-B pool family (ADR 0008 Move 2).
 *  - `db/repositories/raw-transcripts-repo.ts` and everything under `db/restricted/`.
 *  - `crypto/**` and `key-lifecycle/**` — the key provider and its lifecycle CLIs.
 */
const FORBIDDEN_MODULE =
  /^db\/(?:index|raw-store)\.ts$|^db\/repositories\/(?:index|raw-transcripts-repo)\.ts$|^db\/restricted\/|^crypto\/|^key-lifecycle\//;

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Table names that must never appear in this surface's own source. */
const FORBIDDEN_TABLES = [
  'raw_transcripts',
  'token_vault',
  'match_keys',
  'raw_webhook_events',
  'recording',
];

/** Function names that would mean this surface decrypts or reveals raw content. */
const FORBIDDEN_CALLS = [
  'performReveal',
  'createRawAppPool',
  'createRestrictedRunner',
  'buildServiceKeyProvider',
];

/**
 * Strip comments before the table/call/wildcard scans.
 *
 * The doc comments on this surface deliberately NAME what it refuses to touch ("never
 * `raw_transcripts`, never `performReveal`", "no `SELECT *` here because…"). Scanning raw source
 * would flag exactly the prose that documents the guarantee — pressuring a future author to delete
 * the explanation to get the suite green, which is the wrong direction. Only CODE is scanned; the
 * same reasoning drives the clause-anchored regex in `test/db/restricted-import-guard.test.ts`.
 *
 * The `[^:]` guard on the line-comment rule keeps a `://` in a URL from starting a comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

function notesFiles(): string[] {
  return readdirSync(NOTES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(NOTES_DIR, f));
}

/** Resolve one import specifier to an absolute `.ts` path inside `src/`, or undefined for a
 * bare package specifier (zod, pg, fastify …) or anything outside the tree. */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const abs = resolve(dirname(fromFile), specifier);
  // Source is ESM-with-.js-extensions; the file on disk is the .ts.
  for (const candidate of [abs.replace(/\.js$/, '.ts'), `${abs}.ts`, join(abs, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every `src/` module reachable from `src/notes/**`, plus each edge for reporting. */
function walk(): { reachable: Set<string>; edges: string[] } {
  const reachable = new Set<string>();
  const edges: string[] = [];
  const queue = notesFiles();

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(IMPORT_SPECIFIER)) {
      const target = resolveSpecifier(file, m[1]!);
      if (target === undefined) continue;
      edges.push(`${relative(SRC_DIR, file)} -> ${relative(SRC_DIR, target)}`);
      if (!reachable.has(target)) queue.push(target);
    }
  }
  return { reachable, edges };
}

describe('note-review surface cannot reach the raw store or the key provider (ADR 0009)', () => {
  const { reachable, edges } = walk();

  it('the walk actually traverses the graph (sanity — a broken resolver cannot vacuously pass)', () => {
    const rels = [...reachable].map((f) => relative(SRC_DIR, f));
    // Own modules, a first-hop dependency, and a SECOND-hop one reached only through another
    // module — the hop that a direct-import scan would miss.
    expect(rels).toContain('notes/routes.ts');
    expect(rels).toContain('notes/sanitize.ts');
    expect(rels).toContain('redaction/residual-scan.ts');
    expect(rels).toContain('ui/cards.ts'); // reached via notes/render.ts only
    expect(rels).toContain('db/repositories/clean-transcripts-repo.ts');
    expect(reachable.size).toBeGreaterThan(15);
  });

  it('no module reachable from src/notes/ is a raw-store, vault, or key-provider module', () => {
    const offenders = [...reachable]
      .map((f) => relative(SRC_DIR, f))
      .filter((rel) => FORBIDDEN_MODULE.test(rel));
    expect(offenders, `reachable via:\n${edges.join('\n')}`).toEqual([]);
  });

  it('the guard recognizes the forbidden shapes (self-test)', () => {
    for (const bad of [
      'db/index.ts',
      'db/raw-store.ts',
      'db/repositories/index.ts',
      'db/repositories/raw-transcripts-repo.ts',
      'db/restricted/token-vault-repo.ts',
      'db/restricted/restricted-context.ts',
      'crypto/key-store.ts',
      'key-lifecycle/readiness.ts',
    ]) {
      expect(FORBIDDEN_MODULE.test(bad), bad).toBe(true);
    }
    for (const ok of [
      'db/repositories/clean-transcripts-repo.ts',
      'db/repositories/technician-notes-repo.ts',
      'db/repositories/note-feedback-repo.ts',
      'db/enums.ts',
      'notes/routes.ts',
      'redaction/residual-scan.ts',
    ]) {
      expect(FORBIDDEN_MODULE.test(ok), ok).toBe(false);
    }
  });

  it('no notes module names a restricted/raw table or a reveal/key-provider call', () => {
    const offenders: string[] = [];
    for (const file of notesFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const rel = relative(SRC_DIR, file);
      for (const table of FORBIDDEN_TABLES) {
        if (code.includes(table)) offenders.push(`${rel} -> table ${table}`);
      }
      for (const call of FORBIDDEN_CALLS) {
        if (code.includes(call)) offenders.push(`${rel} -> ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the comment stripper does not blind the scan (self-test)', () => {
    // The stripper is load-bearing for the two scans above, so prove it removes ONLY comments: a
    // forbidden token in real code must still be found, or those tests pass vacuously.
    expect(stripComments(`const t = 'raw_transcripts'; // raw_transcripts`)).toContain(
      'raw_transcripts',
    );
    expect(stripComments(`// never raw_transcripts\nconst ok = 1;`)).not.toContain(
      'raw_transcripts',
    );
    expect(stripComments(`/* performReveal is not used */ const ok = 1;`)).not.toContain(
      'performReveal',
    );
    expect(stripComments(`const u = 'https://example.test/x'; // note`)).toContain('https://');
  });

  it('the surface read model avoids SELECT * and addresses only its own tables', () => {
    const repoFile = join(SRC_DIR, 'db/repositories/technician-notes-repo.ts');
    const source = readFileSync(repoFile, 'utf8');
    const marker = '// --- Note-review surface read model (ADR 0009) ---';
    const idx = source.indexOf(marker);
    expect(idx, 'read-model section marker present').toBeGreaterThan(-1);
    // `getTechnicianNote` ABOVE the marker keeps its wildcard select (it is the generator's read,
    // round-tripping the row it just wrote); the surface's own queries below must name their
    // columns, so a column added to the table later cannot silently start egressing.
    const readSection = stripComments(source.slice(idx));

    expect(readSection).not.toContain('SELECT *');
    expect(readSection).toContain('technician_notes');
    for (const table of FORBIDDEN_TABLES) {
      expect(readSection, `read section references ${table}`).not.toContain(table);
    }
  });
});
