'use strict';

/**
 * Add `grinder_pump` to the closed service_category vocabulary (mirrored in src/db/enums.ts).
 *
 * service_category is a text column guarded by CHECK constraints, not a native pg enum. Migrations
 * 9 and 16 baked the old 14-value list into those CHECKs; editing those files only changes what a
 * FRESH migrate builds, so this migration DROPs and re-ADDs the three affected constraints on an
 * already-migrated database — this is what actually lets the new value be stored:
 *   - extraction_candidates_service_category_chk   (migration 9)
 *   - structured_knowledge_service_category_chk    (migration 9)
 *   - labeled_examples_expected_output_shape_chk   (migration 16; service_category lives inside the
 *                                                   expected_output JSON shape check)
 *
 * Non-destructive + reversible: down() first REASSIGNS any grinder_pump rows back to
 * sump_pump_or_drainage (the bucket they came from — never a delete) before restoring the old
 * lists, so re-adding the stricter constraints cannot fail on existing data.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

exports.shorthands = undefined;

const EC = 'extraction_candidates';
const SK = 'structured_knowledge';
const EX = 'labeled_examples';

const EC_SC_CHK = 'extraction_candidates_service_category_chk';
const SK_SC_CHK = 'structured_knowledge_service_category_chk';
const EX_SHAPE_CHK = 'labeled_examples_expected_output_shape_chk';

/** The pre-migration list (migrations 9/16). */
const OLD_CATEGORIES = [
  'water_heater',
  'drain_blockage',
  'leak_detection_or_repair',
  'sewer_or_septic',
  'toilet',
  'faucet_sink_or_fixture',
  'shower_or_tub',
  'gas_line',
  'sump_pump_or_drainage',
  'water_quality_or_treatment',
  'repipe_or_pipe_repair',
  'appliance_install_or_hookup',
  'inspection_or_maintenance',
  'other',
];

/** The new list — grinder_pump added before the `other` fallback (matches src/db/enums.ts order). */
const NEW_CATEGORIES = [
  'water_heater',
  'drain_blockage',
  'leak_detection_or_repair',
  'sewer_or_septic',
  'toilet',
  'faucet_sink_or_fixture',
  'shower_or_tub',
  'gas_line',
  'sump_pump_or_drainage',
  'water_quality_or_treatment',
  'repipe_or_pipe_repair',
  'appliance_install_or_hookup',
  'inspection_or_maintenance',
  'grinder_pump',
  'other',
];

const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');

/** The extraction_candidates / structured_knowledge service_category CHECK body. */
const serviceCategoryCheck = (cats) => `service_category IN (${sqlList(cats)})`;

/** The labeled_examples expected_output_shape CHECK body, parameterized on the category list.
 * Kept byte-identical to migration 16 apart from the service_category ARRAY. */
const shapeCheck = (cats) => `
      (task_type = 'classify'
        AND expected_output ? 'bucket'
        AND expected_output->>'bucket' IN ('customer', 'non-customer', 'spam')
        AND (expected_output - ARRAY['bucket']) = '{}'::jsonb)
      OR
      (task_type = 'extract'
        AND expected_output ?& array['call_intent', 'service_category', 'urgency', 'sentiment']
        AND (expected_output->>'call_intent') = ANY(enum_range(NULL::call_intent)::text[])
        AND (expected_output->>'urgency') = ANY(enum_range(NULL::urgency)::text[])
        AND (expected_output->>'service_category') = ANY(ARRAY[${sqlList(cats)}])
        AND (expected_output->>'sentiment') = ANY(ARRAY[
          'positive', 'neutral', 'negative', 'frustrated'])
        AND (expected_output - ARRAY['call_intent', 'service_category', 'urgency', 'sentiment'])
              = '{}'::jsonb)`;

/** Swap the three CHECK constraints to a given category list. */
const swapConstraints = (pgm, cats) => {
  pgm.dropConstraint(EC, EC_SC_CHK);
  pgm.addConstraint(EC, EC_SC_CHK, { check: serviceCategoryCheck(cats) });
  pgm.dropConstraint(SK, SK_SC_CHK);
  pgm.addConstraint(SK, SK_SC_CHK, { check: serviceCategoryCheck(cats) });
  pgm.dropConstraint(EX, EX_SHAPE_CHK);
  pgm.addConstraint(EX, EX_SHAPE_CHK, { check: shapeCheck(cats) });
};

/** @param {MB} pgm */
exports.up = (pgm) => {
  swapConstraints(pgm, NEW_CATEGORIES);
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  // Reassign (never delete) any rows on the new value before the stricter constraints return.
  pgm.sql(
    `UPDATE ${EC} SET service_category = 'sump_pump_or_drainage' WHERE service_category = 'grinder_pump';`,
  );
  pgm.sql(
    `UPDATE ${SK} SET service_category = 'sump_pump_or_drainage' WHERE service_category = 'grinder_pump';`,
  );
  // labeled_examples carries service_category inside the expected_output JSON.
  pgm.sql(
    `UPDATE ${EX} SET expected_output = jsonb_set(expected_output, '{service_category}', '"sump_pump_or_drainage"') WHERE expected_output->>'service_category' = 'grinder_pump';`,
  );
  swapConstraints(pgm, OLD_CATEGORIES);
};
