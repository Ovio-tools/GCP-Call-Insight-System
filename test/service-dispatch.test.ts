import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/index.js';
import {
  SERVICE_ROLES,
  entrypointSpecifierFor,
  isServiceRole,
  resolveServiceRole,
} from '../src/service-dispatch.js';

describe('service-dispatch (SERVICE_ROLE selector)', () => {
  it('every role maps to a real self-booting src/services entrypoint (typo guard)', () => {
    for (const role of SERVICE_ROLES) {
      const path = fileURLToPath(new URL(`../src/services/${role}.ts`, import.meta.url));
      expect(existsSync(path), `missing src/services/${role}.ts for role ${role}`).toBe(true);
    }
  });

  it('isServiceRole accepts known roles and rejects everything else', () => {
    expect(isServiceRole('worker')).toBe(true);
    expect(isServiceRole('reconciliation-cron')).toBe(true);
    expect(isServiceRole('nope')).toBe(false);
    expect(isServiceRole(undefined)).toBe(false);
    expect(isServiceRole('')).toBe(false);
  });

  it('entrypointSpecifierFor points at the compiled sibling module', () => {
    expect(entrypointSpecifierFor('worker')).toBe('./services/worker.js');
    expect(entrypointSpecifierFor('retention-cron')).toBe('./services/retention-cron.js');
  });

  it('resolveServiceRole returns the role when valid (and trims surrounding whitespace)', () => {
    expect(resolveServiceRole({ SERVICE_ROLE: 'worker' })).toBe('worker');
    expect(resolveServiceRole({ SERVICE_ROLE: '  reconciliation-cron  ' })).toBe(
      'reconciliation-cron',
    );
  });

  it('resolveServiceRole throws a named CONFIG_MISSING_OR_INVALID when SERVICE_ROLE is unset', () => {
    let caught: unknown;
    try {
      resolveServiceRole({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe('CONFIG_MISSING_OR_INVALID');
    expect((caught as ConfigError).invalid).toEqual(['SERVICE_ROLE']);
    // The message must NAME the variable and list the valid roles (CLAUDE.md §5).
    expect((caught as ConfigError).message).toContain('SERVICE_ROLE');
    expect((caught as ConfigError).message).toContain('worker');
  });

  it('resolveServiceRole throws naming SERVICE_ROLE for an unknown value', () => {
    let caught: unknown;
    try {
      resolveServiceRole({ SERVICE_ROLE: 'wroker' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).invalid).toEqual(['SERVICE_ROLE']);
  });
});
