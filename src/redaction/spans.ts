import type { Detection } from './types.js';

/**
 * Merges raw detections from all layers into canonical, non-overlapping spans
 * (Task 4.1). Overlaps and adjacency of the SAME type union; cross-type overlaps
 * union their extent (nothing detected is ever left un-redacted) and take the
 * higher-priority layer's label: deny_list > regex > ner — the more precise /
 * client-mandated detector names the token. Any cross-type overlap raises the
 * `disagreement` flag the risk scorer consumes.
 */

const DETECTOR_PRIORITY: Record<Detection['detector'], number> = {
  deny_list: 3,
  regex: 2,
  ner: 1,
};

export interface MergedDetections {
  spans: Detection[];
  disagreement: boolean;
}

/** Lower confidence wins when merging (the span is only as sure as its weakest part). */
function minConfidence(a: Detection, b: Detection): number | undefined {
  if (a.confidence === undefined) return b.confidence;
  if (b.confidence === undefined) return a.confidence;
  return Math.min(a.confidence, b.confidence);
}

function mergeInto(target: Detection, source: Detection): Detection {
  const takeSource =
    DETECTOR_PRIORITY[source.detector] > DETECTOR_PRIORITY[target.detector] ||
    (DETECTOR_PRIORITY[source.detector] === DETECTOR_PRIORITY[target.detector] &&
      source.end - source.start > target.end - target.start);
  const label = takeSource ? source : target;
  const confidence = minConfidence(target, source);
  return {
    start: Math.min(target.start, source.start),
    end: Math.max(target.end, source.end),
    entityType: label.entityType,
    detector: label.detector,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export function mergeDetections(detections: readonly Detection[]): MergedDetections {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: Detection[] = [];
  let disagreement = false;

  for (const next of sorted) {
    const last = spans[spans.length - 1];
    // Same-type spans also merge when merely touching; cross-type only on true overlap.
    const overlaps =
      last !== undefined &&
      (next.start < last.end || (next.start === last.end && next.entityType === last.entityType));
    if (last && overlaps) {
      if (next.entityType !== last.entityType) disagreement = true;
      spans[spans.length - 1] = mergeInto(last, next);
    } else {
      spans.push({ ...next });
    }
  }

  return { spans, disagreement };
}
