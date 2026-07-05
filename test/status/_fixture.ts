import { STAGE_NODES, COMPONENT_NODES } from '../../src/status/stages.js';
import type { StatusDTO } from '../../src/status/dto.js';

/** A fully-populated, healthy StatusDTO for renderer/serializer tests. Deep-merge overrides
 * via the callback for degraded/broken/null-metric variants. */
export function makeStatusDto(mutate?: (dto: StatusDTO) => void): StatusDTO {
  const dto: StatusDTO = {
    generated_at: '2026-07-01T12:00:00.000Z',
    summary: {
      pipeline_state: 'running',
      calls_processed_today: 42,
      calls_held_for_review: 3,
      held_by_reason: [
        { held_reason: 'missing_transcript', count: 2 },
        { held_reason: 'classified_spam', count: 1 },
      ],
      dead_letter_count: 0,
      spend: { spent_usd: 4.5, budget_usd: 25, model_paused: false },
      components_last_run: COMPONENT_NODES.map((c) => ({
        component: c.key,
        last_run_at: c.periodicLiveness ? '2026-07-01T11:59:00.000Z' : null,
        state: c.periodicLiveness ? 'healthy' : 'unknown',
      })),
      latest_issue: null,
    },
    pipeline_nodes: STAGE_NODES.map((n) => ({
      key: n.key,
      label: n.label,
      state: 'idle',
      count: 0,
    })),
    components: COMPONENT_NODES.map((c) => ({
      key: c.key,
      label: c.label,
      state: c.periodicLiveness ? 'healthy' : 'unknown',
      last_run_at: c.periodicLiveness ? '2026-07-01T11:59:00.000Z' : null,
    })),
  };
  mutate?.(dto);
  return dto;
}
