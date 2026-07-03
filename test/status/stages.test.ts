import { describe, expect, it } from 'vitest';
import { PIPELINE_STAGES } from '../../src/pipeline/stages.js';
import {
  COMPONENT_NODES,
  STAGE_NODES,
  assertStageMappingCoversPipeline,
  dbStageToDtoKey,
  dtoKeyToDbStage,
} from '../../src/status/stages.js';

describe('status stage mapping', () => {
  it('covers exactly PIPELINE_STAGES, in order', () => {
    expect(STAGE_NODES.map((n) => n.dbStage)).toEqual([...PIPELINE_STAGES]);
    expect(() => assertStageMappingCoversPipeline()).not.toThrow();
  });

  it('maps the three reworded stages correctly', () => {
    expect(dbStageToDtoKey('transcript-availability')).toBe('availability_check');
    expect(dbStageToDtoKey('verbatim-pii-scan')).toBe('second_pii_scan');
    expect(dbStageToDtoKey('mark-retention-eligible')).toBe('mark_retention_eligible');
  });

  it('round-trips DTO key ↔ DB stage', () => {
    for (const node of STAGE_NODES) {
      expect(dtoKeyToDbStage(node.key)).toBe(node.dbStage);
    }
  });

  it('returns undefined for an unrecognized current_stage (never throws)', () => {
    expect(dbStageToDtoKey('some-future-stage')).toBeUndefined();
  });

  it('has the 4 fixed components in order', () => {
    expect(COMPONENT_NODES.map((c) => c.key)).toEqual([
      'webhook_receiver',
      'worker',
      'reconciliation_cron',
      'retention_cron',
    ]);
    // Only the periodic-liveness components get stale-threshold logic.
    expect(COMPONENT_NODES.find((c) => c.key === 'webhook_receiver')?.periodicLiveness).toBe(false);
    expect(COMPONENT_NODES.find((c) => c.key === 'worker')?.periodicLiveness).toBe(true);
  });
});
