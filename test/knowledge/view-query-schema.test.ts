import { describe, expect, it } from 'vitest';
import { makeExportQuerySchema, makeViewQuerySchema } from '../../src/knowledge/query.js';
import { makeTestConfig } from '../_config.js';

/**
 * The view page-size bounds are per-environment config, so `makeViewQuerySchema(config)` must read
 * the PASSED config, not hardcoded constants (Finding 2). Export omits pagination and rejects a
 * stray `page`/`page_size` via `.strict()`.
 */
const config = makeTestConfig({
  KNOWLEDGE_PAGE_SIZE_DEFAULT: 25,
  KNOWLEDGE_PAGE_SIZE_MAX: 100,
});

describe('makeViewQuerySchema', () => {
  const schema = makeViewQuerySchema(config);

  it('defaults page to 1 and page_size to the config default when omitted', () => {
    const parsed = schema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.page_size).toBe(25);
  });

  it('clamps page_size to the config max', () => {
    expect(schema.parse({ page_size: '500' }).page_size).toBe(100);
  });

  it('coerces numeric strings for page and page_size', () => {
    const parsed = schema.parse({ page: '3', page_size: '10' });
    expect(parsed.page).toBe(3);
    expect(parsed.page_size).toBe(10);
  });

  it('rejects a non-positive / non-integer page or page_size', () => {
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(schema.safeParse({ page: bad }).success, `page=${bad}`).toBe(false);
      expect(schema.safeParse({ page_size: bad }).success, `page_size=${bad}`).toBe(false);
    }
  });

  it('accepts the validated enum filters and echoes them', () => {
    const parsed = schema.parse({
      service_category: 'water_heater',
      call_intent: 'new_booking',
      urgency: 'routine',
    });
    expect(parsed.service_category).toBe('water_heater');
    expect(parsed.call_intent).toBe('new_booking');
    expect(parsed.urgency).toBe('routine');
  });

  it('rejects an unknown enum value', () => {
    expect(schema.safeParse({ service_category: 'nope' }).success).toBe(false);
    expect(schema.safeParse({ urgency: 'whenever' }).success).toBe(false);
  });

  it('rejects unknown query keys (strict)', () => {
    expect(schema.safeParse({ sentiment: 'negative' }).success).toBe(false);
    expect(schema.safeParse({ model_id: 'x' }).success).toBe(false);
  });

  it('trims and bounds the free-text q', () => {
    expect(schema.parse({ q: '  leak  ' }).q).toBe('leak');
    expect(schema.safeParse({ q: 'x'.repeat(1000) }).success).toBe(false);
  });

  it('treats empty-string filter values (an untouched HTML form field) as absent', () => {
    // A GET form submits every unset select as `name=` and every blank date box as `from=`. That
    // empty string must parse as "no filter", not fail `.strict()` as an invalid enum/date.
    const parsed = schema.parse({
      q: '',
      service_category: '',
      call_intent: '',
      urgency: '',
      from: '',
      to: '',
    });
    expect(parsed.service_category).toBeUndefined();
    expect(parsed.call_intent).toBeUndefined();
    expect(parsed.urgency).toBeUndefined();
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
  });

  it('parses a real text search alongside untouched (empty) dropdowns and dates', () => {
    // The exact shape the form submits when a user types in `q` and leaves everything else on "Any".
    const parsed = schema.parse({
      q: 'leak',
      service_category: '',
      call_intent: '',
      urgency: '',
      from: '',
      to: '',
    });
    expect(parsed.q).toBe('leak');
    expect(parsed.service_category).toBeUndefined();
  });

  it('still rejects a non-empty invalid enum value', () => {
    // Emptiness is the only tolerance — a real bogus value must still fail.
    expect(schema.safeParse({ service_category: 'nope' }).success).toBe(false);
  });
});

describe('makeExportQuerySchema', () => {
  const schema = makeExportQuerySchema();

  it('accepts the same filters as the view', () => {
    const parsed = schema.parse({ service_category: 'toilet', q: 'clog' });
    expect(parsed.service_category).toBe('toilet');
    expect(parsed.q).toBe('clog');
  });

  it('rejects page / page_size (export returns all rows)', () => {
    expect(schema.safeParse({ page: '2' }).success).toBe(false);
    expect(schema.safeParse({ page_size: '5' }).success).toBe(false);
  });

  it('treats empty-string filter values as absent (export href built from a filtered form)', () => {
    const parsed = schema.parse({ service_category: '', urgency: '', from: '', to: '' });
    expect(parsed.service_category).toBeUndefined();
    expect(parsed.urgency).toBeUndefined();
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
  });
});
