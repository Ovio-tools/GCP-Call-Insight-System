import type { KnowledgeAggregate } from '../db/repositories/structured-knowledge-repo.js';
import type { KnowledgeSummary } from './dto.js';

/**
 * Deterministic, model-free plain-language summary (Task 10.1, Finding 4) over the
 * {@link KnowledgeAggregate} for the WHOLE filtered set — never one page. Integers + humanized enum
 * labels only, so it is structurally PII-free; the route still passes it through the serialize guard.
 */

const TOP_CATEGORIES = 3;

/** `water_heater` → `Water heater`; `leak_detection_or_repair` → `Leak detection or repair`. */
export function humanizeLabel(key: string): string {
  const words = key.split('_');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/** `[{key,count}]` → `Toilet (2), Water heater (1)`. */
function labelCounts(entries: readonly { key: string; count: number }[]): string {
  return entries.map((e) => `${humanizeLabel(e.key)} (${e.count})`).join(', ');
}

export function buildSummary(aggregate: KnowledgeAggregate): KnowledgeSummary {
  const from = aggregate.minCreatedAt ? aggregate.minCreatedAt.toISOString() : null;
  const to = aggregate.maxCreatedAt ? aggregate.maxCreatedAt.toISOString() : null;

  let narrative: string;
  if (aggregate.total === 0) {
    narrative = 'No records match the current filters.';
  } else {
    const parts: string[] = [
      `${aggregate.total} record${aggregate.total === 1 ? '' : 's'} match the current filters.`,
    ];
    if (from && to) {
      parts.push(`Spanning ${from.slice(0, 10)} to ${to.slice(0, 10)}.`);
    }
    if (aggregate.byServiceCategory.length > 0) {
      parts.push(
        `Top service categories: ${labelCounts(aggregate.byServiceCategory.slice(0, TOP_CATEGORIES))}.`,
      );
    }
    if (aggregate.byCallIntent.length > 0) {
      parts.push(`Call intents: ${labelCounts(aggregate.byCallIntent)}.`);
    }
    if (aggregate.byUrgency.length > 0) {
      parts.push(`Urgency: ${labelCounts(aggregate.byUrgency)}.`);
    }
    narrative = parts.join(' ');
  }

  return {
    total: aggregate.total,
    date_span: { from, to },
    by_service_category: aggregate.byServiceCategory,
    by_call_intent: aggregate.byCallIntent,
    by_urgency: aggregate.byUrgency,
    narrative,
  };
}
