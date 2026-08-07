import type { NoteDetail, NoteList, NoteTally } from '../../src/notes/dto.js';

/** A fully-populated tally, mutated per test. */
export function makeTally(over: Partial<NoteTally> = {}): NoteTally {
  return { fields_checked: 8, marked_right: 6, note_prompt_version: 'tech-note-v1', ...over };
}

/**
 * A note detail DTO with EVERY field populated, so a test that wants an absent field nulls exactly
 * the one it is asserting about and nothing else drifts underneath it.
 */
export function makeNoteDetail(mutate: (d: NoteDetail) => void = () => undefined): NoteDetail {
  const dto: NoteDetail = {
    call_id: 'call-fixture-1',
    created_at: '2026-07-15T14:30:00.000Z',
    prompt_version: 'tech-note-v1',
    service_category: 'water_heater',
    urgency: 'urgent',
    scope_signal: 'single_fixture',
    occupancy: 'owner',
    equipment: {
      type: 'Tank water heater',
      brand: 'Rheem',
      model: 'XE50',
      capacity: '50 gallon',
      approximate_age: 'about 9 years',
      fuel_type: 'gas',
    },
    system_context: {
      waste_system: 'city sewer',
      water_source: 'city water',
      foundation_type: 'slab',
      property_age: 'built in the 90s',
    },
    water_status: {
      actively_running: false,
      supply_shut_off: true,
      shutoff_location_known: true,
      active_damage: false,
    },
    payer_authority: {
      can_approve_work: true,
      home_warranty: false,
      insurance_claim: false,
      third_party_payer: false,
    },
    prior_work: {
      is_repeat_visit: false,
      is_warranty_claim: false,
      prior_work_by_others: true,
    },
    commitments_made: {
      price_quoted: false,
      dispatch_fee_mentioned: true,
      arrival_window_given: true,
      technician_named: false,
      scope_described: true,
    },
    location_on_property: 'garage, back wall',
    symptom_verbatim: 'it started making a knocking sound and then went cold',
    prior_attempts_detail: 'relit the pilot twice',
    access_notes: 'side gate is unlocked, dog in the yard',
    hazards: ['dog in the yard', 'low clearance'],
    urgency_context: ['no hot water since yesterday'],
    not_established: ['equipment.capacity', 'access_notes'],
    dispatch_summary:
      'Tank water heater, no hot water. Supply is shut off and the customer knows where the valve is. ' +
      'Access through the side gate; dispatch fee and arrival window were given. Capacity not confirmed.',
    verdicts: [],
    tally: makeTally(),
  };
  mutate(dto);
  return dto;
}

export function makeNoteList(mutate: (l: NoteList) => void = () => undefined): NoteList {
  const list: NoteList = {
    filters: {},
    page: 1,
    page_size: 25,
    total: 2,
    total_pages: 1,
    results: [
      {
        call_id: 'call-fixture-1',
        created_at: '2026-07-15T14:30:00.000Z',
        service_category: 'water_heater',
        urgency: 'urgent',
        dispatch_summary_first_line: 'Tank water heater, no hot water.',
        not_established_count: 2,
        review_state: 'unreviewed',
      },
      {
        call_id: 'call-fixture-2',
        created_at: '2026-07-14T09:05:00.000Z',
        service_category: 'drain_blockage',
        urgency: 'routine',
        dispatch_summary_first_line: null,
        not_established_count: 0,
        review_state: 'has_wrong',
      },
    ],
    tally: makeTally(),
  };
  mutate(list);
  return list;
}
