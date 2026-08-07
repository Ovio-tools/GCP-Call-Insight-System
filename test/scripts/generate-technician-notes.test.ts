import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/scripts/generate-technician-notes.js';

/**
 * Argument parsing for the note batch generator. Pure — the entrypoint guards `main()` behind an
 * `import.meta.url` check, so importing the module runs nothing.
 *
 * The category scope is validated HERE, at the earliest possible moment, rather than being passed
 * to SQL and quietly matching nothing: a typo'd category would otherwise look exactly like a
 * corpus with no such calls in it, and the operator would read "0 eligible" as an answer.
 */
describe('parseArgs', () => {
  it('defaults to the whole corpus with no dry-run and no regenerate', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, regenerate: false });
  });

  it('--categories=a,b scopes the run to an explicit trimmed set', () => {
    expect(parseArgs(['--categories=grinder_pump, water_heater ,']).categories).toEqual([
      'grinder_pump',
      'water_heater',
    ]);
  });

  it('accepts the same set as a space-separated value', () => {
    expect(parseArgs(['--categories', 'grinder_pump,water_heater']).categories).toEqual([
      'grinder_pump',
      'water_heater',
    ]);
  });

  it('refuses a category that is not a real service category', () => {
    expect(() => parseArgs(['--categories=grinder_pumps'])).toThrow(/grinder_pumps/);
  });

  it('refuses an empty --categories rather than silently meaning "all"', () => {
    expect(() => parseArgs(['--categories='])).toThrow(/--categories/);
  });

  it('leaves categories absent when the flag is not given', () => {
    expect(parseArgs(['--dry-run', '--limit', '5'])).toEqual({
      dryRun: true,
      regenerate: false,
      limit: 5,
    });
  });
});
