import {
  findEmailLike,
  findGreetingNames,
  findLongDigitRuns,
  findSpelledDigitRuns,
} from './mirror-finders.js';
import type { Detection, Detector, DetectorResult, EntityType, RiskSignal } from './types.js';

/**
 * Layer-2 regex detection (Task 4.1): phones, emails, street addresses,
 * cross-streets, credit cards, government-ID shapes — including spacing, dot/dash,
 * parenthesis, and spelled-obfuscation variants ("john dot smith at gmail dot com",
 * "5 5 5, 1 2 3 4"). Patterns are compiled once at module load; every category
 * helper is exported for direct unit testing.
 *
 * Precision philosophy: over-detection is cheap (an extra vault token), a miss is a
 * privacy-boundary leak — so patterns lean broad, and the ambiguity that regexes
 * cannot resolve (address-like phrases with no street suffix) is surfaced as an
 * `address_like_ambiguous` risk signal instead of being ignored.
 */

/** Street/way suffix lexicon shared by the address + cross-street grammars. */
const SUFFIX =
  '(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|way|place|pl|circle|cir|terrace|ter|highway|hwy|parkway|pkwy)';

/** A word inside a street name: `Main`, `O'Brien`, `W`, or an ordinal like `5th`. */
const NAME_WORD = "(?:[A-Za-z][A-Za-z'.-]*|\\d{1,3}(?:st|nd|rd|th))";

const PHONE_PATTERNS: readonly RegExp[] = [
  // NANP shapes with optional +1 and mixed separators: (916) 555-1234, 916.555.1234, 9165551234
  /(?<!\d)(?:\+?1[\s.-])?\(?\d{3}\)?[\s./·-]?\d{3}[\s./·-]?\d{4}(?!\d)/g,
  // Digit-by-digit spoken numbers: "5 5 5, 1 2 3 4" (>= 7 single digits, short separators)
  /(?<!\d)\d(?:[\s,.-]{1,2}\d){6,}(?!\d)/g,
];

const EMAIL_STANDARD = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Obfuscated form: "john dot smith at gmail dot com", "john (at) example (dot) com".
// The domain must end in a known TLD word so ordinary "at ... dot ..." prose can't match.
const OB_AT = String.raw`(?:\s*\(\s*at\s*\)\s*|\s*\[\s*at\s*\]\s*|\s+at\s+)`;
const OB_DOT = String.raw`(?:\s*\(\s*dot\s*\)\s*|\s*\[\s*dot\s*\]\s*|\s+dot\s+)`;
const OB_TLD = '(?:com|net|org|edu|gov|io|co|us|biz|info)';
const EMAIL_OBFUSCATED = new RegExp(
  String.raw`\b[A-Za-z0-9_%+-]+(?:${OB_DOT}[A-Za-z0-9_%+-]+)*${OB_AT}[A-Za-z0-9-]+(?:${OB_DOT}[A-Za-z0-9-]+)*${OB_DOT}${OB_TLD}\b`,
  'gi',
);

const STREET_ADDRESS = new RegExp(
  String.raw`\b\d{1,6}\s+(?:${NAME_WORD}\s+){0,3}${SUFFIX}\b\.?` +
    String.raw`(?:,?\s+(?:apt|suite|ste|unit|#)\.?\s*[A-Za-z0-9-]+)?`,
  'gi',
);

// Cross-streets: "<Name> [suffix]? <connector> <Name> <suffix>" or the mirror with the
// suffix on the first street. At least one suffix is structurally required, so plain
// "Bob and Alice" never matches. Street-name words must be Capitalized (or ordinals) —
// case-SENSITIVE on purpose, so leading prose ("we are at ...") is never absorbed;
// all-lowercase street mentions are the NER/residual layers' problem, not this one's.
const CAP_WORD = String.raw`(?:[A-Z][A-Za-z'.-]*|\d{1,3}(?:st|nd|rd|th))`;
const SUFFIX_CI =
  '(?:[Ss]treet|[Ss]t|[Aa]venue|[Aa]ve|[Bb]oulevard|[Bb]lvd|[Rr]oad|[Rr]d|[Dd]rive|[Dd]r|' +
  '[Ll]ane|[Ll]n|[Cc]ourt|[Cc]t|[Ww]ay|[Pp]lace|[Pp]l|[Cc]ircle|[Cc]ir|[Tt]errace|[Tt]er|' +
  '[Hh]ighway|[Hh]wy|[Pp]arkway|[Pp]kwy)';
const CROSS_CONNECTOR = String.raw`(?:and|&|at|near|between|cross(?:ing)?\s+of)`;
const CROSS_STREET_PATTERNS: readonly RegExp[] = [
  // suffix on the SECOND street: "Main and 5th Street"
  new RegExp(
    String.raw`(?<![A-Za-z])(?:${CAP_WORD}\s+){1,3}(?:${SUFFIX_CI}\s+)?${CROSS_CONNECTOR}\s+(?:${CAP_WORD}\s+){0,3}${SUFFIX_CI}\b`,
    'g',
  ),
  // suffix on the FIRST street, optional on the second: "Elm Street and Oak"
  new RegExp(
    String.raw`(?<![A-Za-z])(?:${CAP_WORD}\s+){1,3}${SUFFIX_CI}\s+${CROSS_CONNECTOR}\s+${CAP_WORD}(?:\s+${CAP_WORD}){0,2}(?:\s+${SUFFIX_CI}\b)?`,
    'g',
  ),
];

const CREDIT_CARD_CANDIDATE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

const GOVERNMENT_ID_PATTERNS: readonly RegExp[] = [
  // SSN: 123-45-6789 (separators optional per shape; bare 9-digit runs over-match on purpose)
  /(?<!\d)\d{3}[-. ]?\d{2}[-. ]?\d{4}(?!\d)/g,
  // EIN: 12-3456789
  /(?<!\d)\d{2}-\d{7}(?!\d)/g,
];

// Contextual IDs: a keyword ("driver's license", "passport", ...) followed closely by an
// alphanumeric run. The `d` flag exposes the capture group's indices so the detection
// covers ONLY the ID, not the keyword.
const CONTEXTUAL_ID = new RegExp(
  String.raw`(?:ssn|social\s+security(?:\s+number)?|driver'?s?\s+licen[cs]e(?:\s+number)?|license\s+number|passport(?:\s+number)?)` +
    String.raw`(?:[^A-Za-z0-9]+(?:is|was|number|no|num)\b)?[^A-Za-z0-9]+([A-Za-z]{0,2}\d[A-Za-z0-9-]{4,})`,
  'dgi',
);

/** Luhn checksum over a string of digits (no separators). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function detection(start: number, end: number, entityType: EntityType): Detection {
  return { start, end, entityType, detector: 'regex' };
}

/** All matches of `pattern` over `text` as detections of `entityType`. */
function scan(text: string, pattern: RegExp, entityType: EntityType): Detection[] {
  const out: Detection[] = [];
  pattern.lastIndex = 0;
  for (const m of text.matchAll(pattern)) {
    out.push(detection(m.index, m.index + m[0].length, entityType));
  }
  return out;
}

/** Sort by start and drop spans fully contained in an earlier, longer span. */
function dedupe(detections: Detection[]): Detection[] {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Detection[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && d.start >= last.start && d.end <= last.end) continue;
    out.push(d);
  }
  return out;
}

export function detectPhones(text: string): Detection[] {
  return dedupe(PHONE_PATTERNS.flatMap((p) => scan(text, p, 'phone')));
}

export function detectEmails(text: string): Detection[] {
  return dedupe([
    ...scan(text, EMAIL_STANDARD, 'email'),
    ...scan(text, EMAIL_OBFUSCATED, 'email'),
    // ADR 0007: shapes only the residual email_like sub-scan accepted before —
    // unicode confusable at-signs (accounts＠example.com) and the mixed spoken
    // form ("john at gmail.com": spoken at, literal dot).
    ...findEmailLike(text).map((s) => detection(s.start, s.end, 'email')),
  ]);
}

export function detectStreetAddresses(text: string): Detection[] {
  return dedupe(scan(text, STREET_ADDRESS, 'street_address'));
}

export function detectCrossStreets(text: string): Detection[] {
  const raw = CROSS_STREET_PATTERNS.flatMap((p) => scan(text, p, 'cross_street'));
  // Trim trailing whitespace the grammar may have swallowed before an absent suffix.
  const trimmed = raw.map((d) => {
    let end = d.end;
    while (end > d.start && /\s/.test(text[end - 1] ?? '')) end -= 1;
    return { ...d, end };
  });
  return dedupe(trimmed);
}

export function detectCreditCards(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(CREDIT_CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      out.push(detection(m.index, m.index + m[0].length, 'credit_card'));
    }
  }
  return dedupe(out);
}

export function detectGovernmentIds(text: string): Detection[] {
  const out = GOVERNMENT_ID_PATTERNS.flatMap((p) => scan(text, p, 'government_id'));
  for (const m of text.matchAll(CONTEXTUAL_ID)) {
    const idIndices = m.indices?.[1];
    if (idIndices) out.push(detection(idIndices[0], idIndices[1], 'government_id'));
  }
  return dedupe(out);
}

/**
 * Generic long-number detection (ADR 0007): any run of >= 7 digits where only
 * non-alphanumerics intervene, mirroring the residual scan's digit_run rule —
 * the catch-all for real numbers that fit no specific shape (solid 7-, 8-, and
 * 11+-digit runs, grouped pairs, mixed separators). Long non-PII numbers
 * (order/invoice ids) are accepted over-redaction: any such run surviving to
 * the output would residual-hold the call today. The pooled detector suppresses
 * candidates a phone/card/gov-id detection already fully covers, so the common
 * shapes keep their specific entity types and tokens.
 */
export function detectLongNumbers(text: string): Detection[] {
  return findLongDigitRuns(text).map((s) => detection(s.start, s.end, 'number'));
}

/**
 * Spelled-out digit runs (ADR 0007): >= 7 spoken digits ("nine one six five
 * five five zero one four eight", with oh/double/triple), mirroring the
 * residual scan's spelled_out_digits automaton but REDACTING the run as a
 * phone (that is what a spoken digit run of this length is in a service call)
 * instead of leaving it for a residual hold. Ordinary number talk ("seventy
 * eight degrees", "ten minutes") has no run of 7 spoken digits and never fires.
 */
export function detectSpelledDigits(text: string): Detection[] {
  return findSpelledDigitRuns(text).map((s) => detection(s.start, s.end, 'phone'));
}

/**
 * Greeting-cue names (ADR 0007): the capitalized run after "my name is" /
 * "ask for" / "speaking with" (or a capitalized bigram after "this is" /
 * "it's") is redacted as a name — the deterministic backstop for names the
 * NER confidence gate drops (ADR 0006 accepted that gap; this closes the
 * greeting-shaped part of it and dominates the residual scan's
 * name_like_after_greeting hold). Lowercase after the cue never fires.
 */
export function detectGreetingNames(text: string): Detection[] {
  return findGreetingNames(text).map((s) => detection(s.start, s.end, 'name'));
}

// Address-like ambiguity: a number followed by capitalized words but NO street suffix.
// Regexes cannot decide whether "4482 Kensington Meadows" is an address, so the near-miss
// becomes a risk signal (fail closed) rather than a silent pass.
const ADDRESS_LIKE = /\b\d{2,6}\s+[A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){0,2}\b/g;

function addressLikeSignals(text: string, addresses: readonly Detection[]): RiskSignal[] {
  for (const m of text.matchAll(ADDRESS_LIKE)) {
    const start = m.index;
    const end = start + m[0].length;
    const covered = addresses.some((a) => a.start <= start && end <= a.end);
    if (!covered) return [{ reason: 'address_like_ambiguous' }];
  }
  return [];
}

/** The pooled layer-2 detector. */
export function createRegexDetector(): Detector {
  return {
    name: 'regex',
    detect(text: string): Promise<DetectorResult> {
      const addresses = detectStreetAddresses(text);
      const phones = detectPhones(text);
      const cards = detectCreditCards(text);
      const govIds = detectGovernmentIds(text);
      const specificNumeric = [...phones, ...cards, ...govIds];
      const numbers = detectLongNumbers(text).filter(
        (n) => !specificNumeric.some((c) => c.start <= n.start && n.end <= c.end),
      );
      const detections = dedupe([
        ...phones,
        ...detectSpelledDigits(text),
        ...detectGreetingNames(text),
        ...detectEmails(text),
        ...addresses,
        ...detectCrossStreets(text),
        ...cards,
        ...govIds,
        ...numbers,
      ]);
      return Promise.resolve({
        detections,
        riskSignals: addressLikeSignals(text, addresses),
      });
    },
  };
}
