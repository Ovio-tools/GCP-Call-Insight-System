import { SampleValidationError } from './errors.js';

/**
 * Bounded sample selection (Task 11.1). The harness processes ONLY an explicitly bounded, small
 * batch: the operator supplies EITHER an explicit call-id list OR a sample size, never both and
 * never neither, and either way the count is capped by a conservative maximum.
 */

/** Conservative default cap on how many calls a single validation run may touch. */
export const DEFAULT_MAX_SAMPLE_SIZE = 25;

export interface SampleSelectionInput {
  callIds?: readonly string[];
  sampleSize?: number;
}

export type ResolvedSelection =
  { mode: 'call_ids'; callIds: readonly string[] } | { mode: 'sample_size'; sampleSize: number };

export interface SelectionOptions {
  maxSampleSize?: number | undefined;
}

function refuse(message: string, context: Record<string, string> = {}): never {
  throw new SampleValidationError('invalid_sample_selection', message, context);
}

/** Validate and normalize the operator's selection, or refuse with `invalid_sample_selection`. */
export function resolveSampleSelection(
  input: SampleSelectionInput,
  options: SelectionOptions = {},
): ResolvedSelection {
  const max = options.maxSampleSize ?? DEFAULT_MAX_SAMPLE_SIZE;
  const hasList = input.callIds !== undefined;
  const hasSize = input.sampleSize !== undefined;

  if (hasList && hasSize) {
    refuse('provide either a call-id list or a sample size, not both');
  }
  if (!hasList && !hasSize) {
    refuse('provide either a call-id list or a sample size');
  }

  if (hasList) {
    const callIds = [
      ...new Set((input.callIds ?? []).map((c) => c.trim()).filter((c) => c.length > 0)),
    ];
    if (callIds.length === 0) {
      refuse('the call-id list is empty');
    }
    if (callIds.length > max) {
      refuse(`the call-id list exceeds the cap of ${max}`, { max: String(max) });
    }
    return { mode: 'call_ids', callIds };
  }

  const size = input.sampleSize ?? 0;
  if (!Number.isInteger(size) || size < 1) {
    refuse('the sample size must be a positive integer');
  }
  if (size > max) {
    refuse(`the sample size exceeds the cap of ${max}`, { max: String(max) });
  }
  return { mode: 'sample_size', sampleSize: size };
}
