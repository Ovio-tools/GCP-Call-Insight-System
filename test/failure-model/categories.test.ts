import { describe, expect, it } from 'vitest';
import {
  COMPONENT,
  ERROR_CODES,
  ROOT_CAUSE_CATEGORIES,
  componentSchema,
  errorCodeSchema,
  isPipelineStage,
  isValidComponent,
  rootCauseCategorySchema,
} from '../../src/failure-model/index.js';
import { PIPELINE_STAGES } from '../../src/pipeline/stages.js';

describe('categories', () => {
  it('has 32 root-cause categories and 1:1 error codes', () => {
    expect(ROOT_CAUSE_CATEGORIES).toHaveLength(32);
    expect([...ERROR_CODES].sort()).toEqual([...ROOT_CAUSE_CATEGORIES].sort());
  });

  it('every category is a valid error code and vice versa (1:1 mapping)', () => {
    for (const category of ROOT_CAUSE_CATEGORIES) {
      expect(errorCodeSchema.safeParse(category).success).toBe(true);
    }
    for (const code of ERROR_CODES) {
      expect(rootCauseCategorySchema.safeParse(code).success).toBe(true);
    }
  });

  it('reuses the pipeline-layer stage source of truth', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(isPipelineStage(stage)).toBe(true);
    }
    expect(isPipelineStage('not-a-stage')).toBe(false);
  });

  describe('COMPONENT enum', () => {
    it('is the intended kebab-case, service-aligned list', () => {
      expect([...COMPONENT]).toEqual([
        'webhook-receiver',
        'worker',
        'reconciliation-cron',
        'retention-cron',
        'backfill',
        'review-surface',
        'status-surface',
        'knowledge-base-surface',
      ]);
    });

    it('accepts every declared value', () => {
      for (const component of COMPONENT) {
        expect(componentSchema.safeParse(component).success).toBe(true);
        expect(isValidComponent(component)).toBe(true);
      }
    });

    it('rejects common drift variants', () => {
      for (const bad of [
        'webhook',
        'reconciliation_cron',
        'retention_cron',
        'kb_surface',
        'knowledge_base_surface',
      ]) {
        expect(componentSchema.safeParse(bad).success).toBe(false);
        expect(isValidComponent(bad)).toBe(false);
      }
    });
  });
});
