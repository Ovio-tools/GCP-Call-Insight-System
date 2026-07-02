import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source files must stay plain text. An embedded NUL byte makes Git treat the
 * file as binary — diffs disappear from review and text tooling breaks (this
 * bit us once: a literal \x00 written into a template string). Escapes like
 * the six characters `\x00` in source are fine; a literal byte is not.
 */
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

describe('source hygiene', () => {
  it('no src/**/*.ts file contains a literal NUL byte', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const offenders = files.filter((rel) => readFileSync(join(SRC_DIR, rel)).includes(0));
    expect(offenders).toEqual([]);
  });
});
