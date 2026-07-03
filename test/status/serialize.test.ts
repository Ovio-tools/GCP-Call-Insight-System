import { describe, expect, it } from 'vitest';
import { serializeStatus } from '../../src/status/serialize.js';
import type { StatusDTO } from '../../src/status/dto.js';
import { makeStatusDto } from './_fixture.js';

describe('serializeStatus', () => {
  it('passes a valid DTO through', () => {
    const dto = makeStatusDto();
    expect(serializeStatus(dto)).toEqual(dto);
  });

  it('throws if a content/PII field is smuggled into the DTO', () => {
    const dto = makeStatusDto() as StatusDTO & { transcript?: string };
    dto.transcript = 'leaked content';
    expect(() => serializeStatus(dto)).toThrow();
  });

  it('throws on a nested content field', () => {
    const dto = makeStatusDto();
    (dto.summary as unknown as { customer_phone?: string }).customer_phone = '555-1212';
    expect(() => serializeStatus(dto)).toThrow();
  });
});
