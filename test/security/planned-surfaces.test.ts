import { describe, expect, it } from 'vitest';
import { REGISTRY_PLANNED_PLACEHOLDERS } from './_registry.js';

/**
 * The gated placeholder for surfaces that are NOT yet live (Task 9.1, findings #2/#3), so an absent
 * surface cannot silently skip the cross-cutting suite. Status, review, Dialpad, and knowledge-base
 * are ALL live on `origin/main` and covered by real suites (internal-surfaces + dialpad-webhook-
 * surface) — they are NOT here. Only ServiceTitan (Task 12.1, Phase 12) remains, and it does NOT
 * gate 9.1 signoff.
 *
 * The placeholder-name set is derived from the registry so it can never drift from it; the
 * conformance guard independently pins the registry's planned set to exactly `{servicetitan-
 * webhook}` and asserts no LIVE surface is left as a placeholder. When 12.1 lands, its real
 * `servicetitan-webhook-surface` suite replaces this and the name drops out of both sets.
 */

/** The placeholder names this file declares — tied to the registry (single source of truth). */
export const PLACEHOLDER_NAMES: readonly string[] = REGISTRY_PLANNED_PLACEHOLDERS;

describe('planned surfaces — gated placeholders (not blocking 9.1 signoff)', () => {
  it('declares exactly the registry planned set (no live surface left as a todo)', () => {
    expect([...PLACEHOLDER_NAMES].sort()).toEqual(['servicetitan-webhook']);
  });

  // ServiceTitan webhook receiver (Task 12.1, Phase 12) — future, not a 9.1 dependency. Enumerated
  // so the real suite has a concrete contract to satisfy before the surface goes live. Gated on the
  // 12.1 prerequisites (12.0 scaffold, addendum, sandbox API access, consent) — NOT on 9.1.
  describe.todo(
    'servicetitan-webhook-surface (Task 12.1) — real receiver: supported webhook auth verified at build time',
  );
  describe.todo('servicetitan-webhook-surface (Task 12.1): a weak match writes nothing');
  describe.todo(
    'servicetitan-webhook-surface (Task 12.1): a strong match writes exactly one additive note',
  );
  describe.todo('servicetitan-webhook-surface (Task 12.1): a rerun updates rather than duplicates');
  describe.todo('servicetitan-webhook-surface (Task 12.1): human notes are never overwritten');
  describe.todo(
    'servicetitan-webhook-surface (Task 12.1): no sentiment/confidence leaves the system',
  );
  describe.todo(
    'servicetitan-webhook-surface (Task 12.1): auth/match/write failures emit SERVICETITAN_AUTH_FAILED / SERVICETITAN_MATCH_WEAK / SERVICETITAN_WRITE_FAILED',
  );
  describe.todo(
    'servicetitan-webhook-surface (Task 12.1): no PII leaks in response, logs, or stored rows',
  );
});
