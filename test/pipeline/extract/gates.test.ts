import { describe, expect, it } from 'vitest';
import {
  scanPhrasesForResidual,
  verbatimGate,
  tokenGate,
  emergencyRule,
} from '../../../src/pipeline/extract/gates.js';
import type { ExtractionRecord } from '../../../src/pipeline/extract/parse.js';
import { URGENCY } from '../../../src/db/enums.js';

/** A neutral base record; individual tests override only the fields they exercise. */
function baseRecord(overrides: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    call_intent: 'general',
    service_category: 'other',
    problem_statement: 'general question',
    symptoms: [],
    customer_language: [],
    competitor_mentions: [],
    concerns: [],
    location_in_home: null,
    access_or_scheduling_notes: null,
    prior_attempts: null,
    acquisition_source: null,
    urgency: 'routine',
    sentiment: 'neutral',
    ...overrides,
  };
}

describe('verbatimGate', () => {
  const transcript = 'Caller: my water heater stopped making hot water this morning.';

  it('passes an exact-match phrase', () => {
    expect(verbatimGate(['stopped making hot water'], transcript)).toEqual({ ok: true });
  });

  it('passes a case/whitespace-variant phrase', () => {
    expect(verbatimGate(['STOPPED   MAKING  hot water'], transcript)).toEqual({ ok: true });
  });

  it('fails a fabricated phrase and reports counts only (no phrase text)', () => {
    const result = verbatimGate(['this was never said'], transcript);
    expect(result).toEqual({ ok: false, mismatchCount: 1, phraseCount: 1 });
    expect(JSON.stringify(result)).not.toContain('never said');
  });

  it('passes an empty list', () => {
    expect(verbatimGate([], transcript)).toEqual({ ok: true });
  });
});

describe('scanPhrasesForResidual (residual PII)', () => {
  const denyTerms = ['acmeplumbco'];

  it('hits a planted digit-run phrase and returns counts only', () => {
    const result = scanPhrasesForResidual(['call me at 5551234567 anytime'], denyTerms);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.counts.digit_run).toBeGreaterThan(0);
    }
    // counts only — no phrase text
    expect(JSON.stringify(result)).not.toContain('5551234567');
  });

  it('hits spelled-out digits', () => {
    const result = scanPhrasesForResidual(
      ['five five five one two three four five six seven'],
      denyTerms,
    );
    expect(result.hit).toBe(true);
    if (result.hit) expect(result.counts.spelled_out_digits).toBeGreaterThan(0);
  });

  it('hits an injected deny-term', () => {
    const result = scanPhrasesForResidual(['I usually go with AcmePlumbCo instead'], denyTerms);
    expect(result.hit).toBe(true);
    if (result.hit) expect(result.counts.deny_list_term).toBeGreaterThan(0);
  });

  it('passes a clean phrase', () => {
    expect(scanPhrasesForResidual(['stopped making hot water this morning'], denyTerms)).toEqual({
      hit: false,
    });
  });

  it('scans the ORIGINAL phrase — risky text adjacent to a token still hits', () => {
    // The residual scan strips tokens then scans; the digit run beside [PHONE_1] still trips.
    const result = scanPhrasesForResidual(['reach me [PHONE_1] or at 5551234567'], denyTerms);
    expect(result.hit).toBe(true);
    if (result.hit) expect(result.counts.digit_run).toBeGreaterThan(0);
  });

  it('merges counts across phrases', () => {
    const result = scanPhrasesForResidual(
      ['digits 5551234567', 'more digits 9876543210'],
      denyTerms,
    );
    expect(result.hit).toBe(true);
    if (result.hit) expect(result.counts.digit_run).toBe(2);
  });

  it('PRECEDENCE: a phrase that is BOTH non-verbatim AND has planted PII is reported by the scan', () => {
    // scanPhrasesForResidual is what the handler consults FIRST (PII precedence over
    // the verbatim mismatch). The phrase is not in the transcript, yet the scan hits.
    const transcript = 'Caller: the sink is leaking.';
    const phrase = 'phone number 5551234567 not in transcript';

    const scan = scanPhrasesForResidual([phrase], denyTerms);
    expect(scan.hit).toBe(true);
    if (scan.hit) expect(scan.counts.digit_run).toBeGreaterThan(0);

    // Verbatim would also fail, but PII precedence means the scan's hit is decisive.
    expect(verbatimGate([phrase], transcript).ok).toBe(false);
  });
});

describe('tokenGate', () => {
  it('drops phrases containing redaction tokens and retains clean ones', () => {
    const phrases = [
      'call me at [PHONE_1]',
      'ask for [NAME_1]',
      'I live at [STREET_ADDRESS_2]',
      'you can reach [NAME_3] at the shop',
      'my water heater is broken',
    ];
    const result = tokenGate(phrases);
    expect(result.droppedCount).toBe(4);
    expect(result.phrases).toEqual(['my water heater is broken']);
  });

  it('is not fooled by TOKEN_PATTERN statefulness across repeated calls', () => {
    const phrases = ['has [PHONE_1] token', 'clean phrase', 'another [NAME_2] token'];
    const first = tokenGate(phrases);
    const second = tokenGate(phrases);
    expect(first).toEqual(second);
    expect(first.droppedCount).toBe(2);
    expect(first.phrases).toEqual(['clean phrase']);
  });

  it('returns no phrase text in the dropped count path', () => {
    const result = tokenGate(['secret [PHONE_1]']);
    expect(result.phrases).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });
});

describe('emergencyRule', () => {
  it('model urgency=emergency trips → emergency + hold', () => {
    const record = baseRecord({ urgency: 'emergency' });
    const result = emergencyRule(record, 'nothing notable here');
    expect(result.urgency).toBe('emergency');
    expect(result.hold).toBe(true);
    expect(result.triggers).toContain('model_urgency');
  });

  it('call_intent=emergency with model urgency=routine trips AND upgrades to emergency + hold', () => {
    const record = baseRecord({ call_intent: 'emergency', urgency: 'routine' });
    const result = emergencyRule(record, 'nothing notable here');
    expect(result.urgency).toBe('emergency');
    expect(result.hold).toBe(true);
    expect(result.triggers).toContain('call_intent');
  });

  describe('emergency keyword classes', () => {
    const keywords = [
      'gas leak',
      'carbon monoxide',
      'sewage backup',
      'burst pipe',
      'flooding',
      'water everywhere',
    ];

    for (const kw of keywords) {
      it(`"${kw}" trips via redactedText`, () => {
        const result = emergencyRule(baseRecord(), `Caller: there is a ${kw} in the kitchen.`);
        expect(result.urgency).toBe('emergency');
        expect(result.hold).toBe(true);
        expect(result.triggers).toContain('emergency_keyword');
      });

      it(`"${kw}" trips via a symptoms[] entry`, () => {
        const record = baseRecord({ symptoms: [`observed ${kw} in the home`] });
        const result = emergencyRule(record, 'plain transcript, no keyword');
        expect(result.urgency).toBe('emergency');
        expect(result.triggers).toContain('emergency_keyword');
      });

      it(`"${kw}" trips via problem_statement`, () => {
        const record = baseRecord({ problem_statement: `there is a ${kw} right now` });
        const result = emergencyRule(record, 'plain transcript, no keyword');
        expect(result.urgency).toBe('emergency');
        expect(result.triggers).toContain('emergency_keyword');
      });

      it(`"${kw}" trips via a concerns[] entry only`, () => {
        const record = baseRecord({ concerns: [`worried about the ${kw}`] });
        const result = emergencyRule(record, 'plain transcript, no keyword');
        expect(result.urgency).toBe('emergency');
        expect(result.triggers).toContain('emergency_keyword');
      });
    }
  });

  describe('ambiguous upgrades (one level)', () => {
    const ambiguous = [
      'active leak',
      'cannot shut off the water',
      "water won't stop",
      'no usable toilet',
      'no water at all',
    ];

    for (const kw of ambiguous) {
      it(`"${kw}" upgrades routine → urgent (no hold)`, () => {
        const result = emergencyRule(baseRecord({ urgency: 'routine' }), `Caller: ${kw}.`);
        expect(result.urgency).toBe('urgent');
        expect(result.hold).toBe(false);
        expect(result.triggers).toEqual(['ambiguous_upgrade']);
      });
    }

    it('ambiguous + model urgency=urgent → emergency + hold', () => {
      const result = emergencyRule(baseRecord({ urgency: 'urgent' }), 'Caller: active leak.');
      expect(result.urgency).toBe('emergency');
      expect(result.hold).toBe(true);
      expect(result.triggers).toContain('ambiguous_upgrade');
    });

    it('a curly apostrophe (U+2019) in "won’t shut off" still triggers the upgrade', () => {
      // Real ASR/typed transcripts render won't/can't with U+2019; the normalizer
      // folds it to a straight apostrophe so the keyword literal still matches.
      const result = emergencyRule(
        baseRecord({ urgency: 'routine' }),
        'Caller: the main valve won’t shut off.',
      );
      expect(result.urgency).toBe('urgent');
      expect(result.triggers).toEqual(['ambiguous_upgrade']);
    });
  });

  it('emergency wins when both an emergency and an ambiguous trigger match', () => {
    // "gas leak" (emergency) + "active leak" (ambiguous) both present.
    const result = emergencyRule(
      baseRecord({ urgency: 'routine' }),
      'Caller: there is a gas leak and an active leak.',
    );
    expect(result.urgency).toBe('emergency');
    expect(result.hold).toBe(true);
    expect(result.triggers).toContain('emergency_keyword');
    expect(result.triggers).toContain('ambiguous_upgrade');
  });

  it('no signal passes the model urgency through unchanged with no hold', () => {
    const result = emergencyRule(
      baseRecord({ urgency: 'routine' }),
      'Caller: routine maintenance.',
    );
    expect(result).toEqual({ urgency: 'routine', hold: false, triggers: [] });
  });

  it('plain "leak" alone does NOT trigger', () => {
    const result = emergencyRule(
      baseRecord({ urgency: 'routine' }),
      'Caller: I have a small leak.',
    );
    expect(result.urgency).toBe('routine');
    expect(result.triggers).toEqual([]);
  });

  it('plain "no water" alone does NOT trigger (only the exact ambiguous phrase does)', () => {
    const result = emergencyRule(
      baseRecord({ urgency: 'routine' }),
      'Caller: there is no water pressure upstairs.',
    );
    expect(result.urgency).toBe('routine');
    expect(result.triggers).toEqual([]);
  });

  it('triggers are the exact constant ids, never matched text', () => {
    const result = emergencyRule(baseRecord(), 'Caller: gas leak in the kitchen.');
    expect(result.triggers).toEqual(['emergency_keyword']);
    for (const t of result.triggers) {
      expect(t).not.toContain('gas');
      expect(t).not.toContain('kitchen');
    }
  });
});

describe('URGENCY_LADDER drift guard (behavioral)', () => {
  // The ladder is DERIVED from URGENCY (reversed). These upgrade behaviors would
  // break if the enum ever drifted from a routine→urgent→emergency ordering, so they
  // pin the derivation against db/enums.ts without exporting the ladder.
  it('every non-top urgency upgrades exactly one level via the ambiguous tier', () => {
    // routine → urgent
    expect(emergencyRule(baseRecord({ urgency: 'routine' }), 'Caller: active leak.').urgency).toBe(
      'urgent',
    );
    // urgent → emergency
    expect(emergencyRule(baseRecord({ urgency: 'urgent' }), 'Caller: active leak.').urgency).toBe(
      'emergency',
    );
    // emergency stays emergency (top of the ladder; also emergency tier fires)
    expect(
      emergencyRule(baseRecord({ urgency: 'emergency' }), 'Caller: active leak.').urgency,
    ).toBe('emergency');
  });

  it('URGENCY covers exactly the three ladder rungs', () => {
    expect(new Set(URGENCY)).toEqual(new Set(['routine', 'urgent', 'emergency']));
    expect(URGENCY.length).toBe(3);
  });
});
