import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, REMEDIATION_CATALOG } from '../../src/failure-model/index.js';

const RUNBOOK = readFileSync(
  fileURLToPath(new URL('../../docs/runbook.md', import.meta.url)),
  'utf8',
);

/** Explicit anchor markers, the runbook's authoritative section ids: `<!-- anchor: slug ... -->`. */
const anchors = new Set([...RUNBOOK.matchAll(/<!--\s*anchor:\s*([a-z0-9-]+)/g)].map((m) => m[1]));

const anchorOf = (runbookRef: string): string => runbookRef.replace(/^runbook#/, '');

describe('runbook resolution', () => {
  it('resolves every catalog runbookRef to a runbook section', () => {
    for (const code of ERROR_CODES) {
      const ref = REMEDIATION_CATALOG[code].runbookRef;
      expect(ref, `${code} runbookRef must be runbook#<anchor>`).toMatch(/^runbook#[a-z0-9-]+$/);
      expect(anchors, `runbook.md is missing a section for ${code} (${ref})`).toContain(
        anchorOf(ref),
      );
    }
  });

  it('has no orphan runbook section that no error code points to', () => {
    const catalogAnchors = new Set(
      Object.values(REMEDIATION_CATALOG).map((e) => anchorOf(e.runbookRef)),
    );
    for (const anchor of anchors) {
      expect(catalogAnchors, `runbook section '${anchor}' has no catalog entry`).toContain(anchor);
    }
  });
});
