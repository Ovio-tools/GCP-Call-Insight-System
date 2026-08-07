import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { filtersScript } from '../../src/ui/filters.js';

/**
 * Behavioural tests over the SHARED auto-apply filter script. The script ships as a string inside a
 * nonce'd `<script>` tag, so asserting on that string would only ever prove the text is present —
 * not that picking a drop-down actually navigates anywhere. Instead these tests EXECUTE the shipped
 * source in a `node:vm` context against a hand-written DOM stub and assert on where it navigated.
 *
 * The stub is deliberately literal about selectors (`document.querySelectorAll('form.filters')`
 * returns nothing for any other selector, and a form's field query filters by tag name), so a script
 * that reached for the wrong element fails here rather than silently matching everything.
 *
 * There is no jsdom in this repo and this must not add one — the whole point of these pages is that
 * they are self-contained server-rendered HTML with a few lines of vanilla DOM code.
 */

/* ==================================================================================================
 * DOM stub
 * ============================================================================================== */

interface StubField {
  tagName: string;
  name: string;
  value: string;
  type: string;
  addEventListener(type: string, fn: () => void): void;
  /** Test-side: simulate the user changing this control. */
  change(): void;
}

interface StubDetails {
  open: boolean;
}

interface StubForm {
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): StubField[];
  closest(selector: string): StubDetails | null;
}

function field(tagName: 'select' | 'input', name: string, value: string, type = 'text'): StubField {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    tagName: tagName.toUpperCase(),
    name,
    value,
    type: tagName === 'select' ? 'select-one' : type,
    addEventListener(evt, fn) {
      (listeners[evt] ??= []).push(fn);
    },
    change() {
      for (const fn of listeners['change'] ?? []) fn();
    },
  };
}

/** Match a comma-separated tag-name selector list ("select,input") against a field. */
function matchesTag(selector: string, f: StubField): boolean {
  return selector
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(f.tagName.toLowerCase());
}

function form(action: string, fields: StubField[], details?: StubDetails): StubForm {
  return {
    getAttribute: (name) => (name === 'action' ? action : null),
    querySelectorAll: (selector) => fields.filter((f) => matchesTag(selector, f)),
    closest: (selector) => (selector === 'details' ? (details ?? null) : null),
  };
}

interface RunResult {
  /** Every URL the script navigated to, in order. */
  navigations: string[];
}

/** Execute the shipped script source against the given forms. */
function run(forms: StubForm[], hash = ''): RunResult {
  const html = filtersScript({ nonce: 'N1' });
  const source = /<script\b[^>]*>([\s\S]*)<\/script>/.exec(html)?.[1];
  if (source === undefined || source.trim() === '') throw new Error('no script body to execute');

  const navigations: string[] = [];
  const sandbox = {
    document: {
      querySelectorAll: (selector: string): StubForm[] =>
        selector === 'form.filters' ? forms : [],
    },
    window: {
      location: {
        hash,
        assign: (url: string): void => {
          navigations.push(url);
        },
      },
    },
  };
  vm.runInNewContext(source, sandbox);
  return { navigations };
}

/* ==================================================================================================
 * Tests
 * ============================================================================================== */

describe('filtersScript — emitted markup', () => {
  it('is a single nonce-carrying inline script with no external source', () => {
    const html = filtersScript({ nonce: 'N1' });
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('nonce="N1"');
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });

  it('escapes the nonce rather than interpolating it raw', () => {
    expect(filtersScript({ nonce: '"><b>' })).toContain('nonce="&quot;&gt;&lt;b&gt;"');
  });

  it('still renders (inertly) when the page has no nonce', () => {
    expect(filtersScript({})).toContain('nonce=""');
  });
});

describe('filtersScript — drop-downs apply immediately', () => {
  it('navigates as soon as a drop-down changes', () => {
    const category = field('select', 'service_category', 'plumbing');
    const result = run([form('/knowledge', [category])]);

    expect(result.navigations).toEqual([]);
    category.change();
    expect(result.navigations).toEqual(['/knowledge?service_category=plumbing']);
  });

  it('carries the typed free-text and dates along with the drop-down', () => {
    const q = field('input', 'q', 'leak');
    const from = field('input', 'from', '2026-01-01');
    const urgency = field('select', 'urgency', 'emergency');
    const result = run([form('/knowledge', [q, urgency, from])]);

    urgency.change();
    expect(result.navigations).toEqual(['/knowledge?q=leak&urgency=emergency&from=2026-01-01']);
  });

  it('omits controls left empty so the address carries only real filters', () => {
    const q = field('input', 'q', '');
    const category = field('select', 'service_category', '');
    const urgency = field('select', 'urgency', 'emergency');
    const result = run([form('/notes', [q, category, urgency])]);

    urgency.change();
    expect(result.navigations).toEqual(['/notes?urgency=emergency']);
    expect(result.navigations[0]).not.toContain('service_category=');
    expect(result.navigations[0]).not.toContain('q=');
  });

  it('navigates to the bare path when every control is empty', () => {
    const category = field('select', 'service_category', '');
    const result = run([form('/notes', [category])]);

    category.change();
    expect(result.navigations).toEqual(['/notes']);
  });

  it('percent-encodes values so a stray & or # cannot forge a parameter', () => {
    const q = field('input', 'q', 'a&b#c');
    const urgency = field('select', 'urgency', 'routine');
    const result = run([form('/knowledge', [q, urgency])]);

    urgency.change();
    expect(result.navigations).toEqual(['/knowledge?q=a%26b%23c&urgency=routine']);
  });

  it('does NOT navigate when a typed box changes', () => {
    // Deliberate: a text `change` fires on blur, so auto-applying here would reload the page out
    // from under a click heading for a drop-down. Enter and the Search button still submit natively.
    const q = field('input', 'q', 'leak');
    const from = field('input', 'from', '2026-01-01');
    const result = run([form('/knowledge', [q, from])]);

    q.change();
    from.change();
    expect(result.navigations).toEqual([]);
  });

  it('ignores buttons rendered as inputs rather than sending them as filters', () => {
    const submit = field('input', 'go', 'Search', 'submit');
    const urgency = field('select', 'urgency', 'routine');
    const result = run([form('/calls', [submit, urgency])]);

    urgency.change();
    expect(result.navigations).toEqual(['/calls?urgency=routine']);
  });

  it('wires every filter form on the page, not just the first', () => {
    // /knowledge and /notes render the form TWICE — a desktop copy and a mobile one inside
    // <details>. Neither copy may be left dead.
    const desktop = field('select', 'urgency', 'emergency');
    const mobile = field('select', 'urgency', 'routine');
    const result = run([form('/notes', [desktop]), form('/notes', [mobile], { open: true })]);

    mobile.change();
    expect(result.navigations).toEqual(['/notes?urgency=routine#filters']);
  });

  it('ignores a second change while the first navigation is under way', () => {
    const a = field('select', 'urgency', 'emergency');
    const b = field('select', 'service_category', 'plumbing');
    const result = run([form('/notes', [a, b])]);

    a.change();
    b.change();
    expect(result.navigations).toHaveLength(1);
  });
});

describe('filtersScript — the mobile Filters panel stays open', () => {
  it('marks the address with #filters when the form is in an open panel', () => {
    const details = { open: true };
    const urgency = field('select', 'urgency', 'emergency');
    const result = run([form('/notes', [urgency], details)]);

    urgency.change();
    expect(result.navigations).toEqual(['/notes?urgency=emergency#filters']);
  });

  it('adds no marker for the desktop copy, which sits in no panel', () => {
    const urgency = field('select', 'urgency', 'emergency');
    const result = run([form('/notes', [urgency])]);

    urgency.change();
    expect(result.navigations[0]).not.toContain('#filters');
  });

  it('re-opens the panel on load when the address carries the marker', () => {
    const details = { open: false };
    run([form('/notes', [field('select', 'urgency', '')], details)], '#filters');
    expect(details.open).toBe(true);
  });

  it('leaves the panel alone when the address carries no marker', () => {
    const details = { open: false };
    run([form('/notes', [field('select', 'urgency', '')], details)], '');
    expect(details.open).toBe(false);
  });

  it('never collapses a panel the server already opened', () => {
    const details = { open: true };
    run([form('/notes', [field('select', 'urgency', 'emergency')], details)], '');
    expect(details.open).toBe(true);
  });
});

describe('filtersScript — hostile pages', () => {
  it('does nothing at all when the page has no filter form', () => {
    expect(() => run([])).not.toThrow();
    expect(run([]).navigations).toEqual([]);
  });
});
