# Database Schema, Migrations, Roles & Envelope Encryption (Task 1.1)

## Context

The repo is scaffolding only — config loader, logger, boot/readiness, and a
`node-pg-migrate` runner exist, but `migrations/` is empty and there is no data
layer. This task lands the durable foundation the whole pipeline builds on: all 18
Postgres tables, reversible up/down migrations, three least-privilege roles, and the
envelope-encryption helpers for the two encrypted stores. CLAUDE.md §2/§3/§5 is the
authoritative spec for the tables, retention bookkeeping, and encryption model;
this plan turns that spec into migrations + code.

Everything here is additive and reversible (CLAUDE.md conventions): every migration
has an `up` and a `down`, deletes are soft, and no key material ever touches
Postgres.

**Decisions locked with the user:**
- Roles are created **in-migration with existence guards** (works whether or not the
  Railway DB user has `CREATEROLE`, no-op if pre-provisioned).
- `app_role` gets **no DELETE**; a separate `purge_role` holds DELETE on purgeable
  tables (used only by the retention cron).
- DB-dependent tests are **env-gated on `TEST_DATABASE_URL`** (skip when absent
  locally), but **CI provides a Postgres service so the DB suite is required for PR
  acceptance** — it must not silently skip (see §Test strategy). Pure-unit crypto
  tests always run too.
- Defaults (not user-blocking): `uuid` PKs everywhere for uniformity;
  `alert_events.dedup_key` uses a partial unique index `WHERE acknowledged_at IS NULL`.

## Critical prerequisite (blocker found during planning)

`node-pg-migrate` 8.0.4 `readdir`s `migrations/` and ignores only dotfiles
(`^\..*`). The existing `migrations/README.md` does **not** match, so the loader
would `import()` it and crash every migrate run. Fix in
[src/boot/migrate-runner.ts](src/boot/migrate-runner.ts): add
`ignorePattern: '(\\..*|.*\\.md)'` to the options bag passed to `runner({...})`
(node-pg-migrate anchors it as `^…$`, so this matches any dotfile or `.md`; the
`<ts>_*.cjs` migration files won't match). Then update the exact-options assertion
in [test/migrate.test.ts](test/migrate.test.ts).

Shared migration helpers must NOT sit directly in `migrations/` (they'd be loaded as
migrations). Put them in a **subdirectory** `migrations/lib/` — the loader filters to
`dirent.isFile()`, so a subdirectory is skipped automatically.

## Migration file format

Author migrations as **`.cjs` (CommonJS)** files using the `node-pg-migrate`
`MigrationBuilder` (`pgm`) API, with raw `pgm.sql(...)` only for enums, roles, and
grants. Rationale: the runner loads files from the raw repo-root `migrations/` dir at
runtime (not compiled to `dist`), so TypeScript is out; `.cjs` is unambiguous
regardless of the root `package.json` `"type": "module"` and matches
node-pg-migrate's `exports.up`/`exports.down` contract. Signature:

```js
/** @typedef {import('node-pg-migrate').MigrationBuilder} MB */
exports.shorthands = undefined;
/** @param {MB} pgm */ exports.up = (pgm) => { /* ... */ };
/** @param {MB} pgm */ exports.down = (pgm) => { /* ... */ };
```

## Migration breakdown (5 files, each independently reversible)

Ordered so each file fully reverses its own `up`. `down` reverses in the opposite
order (grants → roles → restricted_tables → core_tables → extensions_and_enums).

1. `<ts>_extensions_and_enums.cjs` — `CREATE EXTENSION IF NOT EXISTS pgcrypto`
   (for `gen_random_uuid()`); all native ENUM types. down drops each.
2. `<ts>_core_tables.cjs` — the 15 non-restricted tables (list below). down drops in
   reverse-dependency order.
3. `<ts>_restricted_tables.cjs` — `raw_transcripts`, `token_vault`, `match_keys`
   (encrypted / restricted-access), kept separate so grants target them cleanly.
4. `<ts>_roles.cjs` — create `app_role`, `restricted_role`, `purge_role` as
   guarded `NOLOGIN` group roles, each marker-stamped on create. down revokes grants
   and drops only marker-stamped (migration-created) roles (see §Roles).
5. `<ts>_grants.cjs` — GRANT/REVOKE per §Roles. down reverses.

**Round-trip test** drives full reversibility by calling the runner directly with
`direction: 'down', count: Infinity` (the CLI hardcodes `count: 1`), then `up` again.

## Column conventions

- **Keys**: `call_id` is `text` (Dialpad IDs are opaque strings) — PK on `call_state`,
  `text` FK → `call_state(call_id)` elsewhere. Synthetic row IDs:
  `uuid PRIMARY KEY DEFAULT gen_random_uuid()`.
- **Timestamps**: always `timestamptz`; `created_at ... DEFAULT now()`.
- **Numbers**: `numeric` for money/scores (`estimated_cost numeric(12,6)`,
  `redaction_risk_score numeric(5,4)`); `bigint` for token counts.
- **Ciphertext / HMAC**: `bytea` (AES-GCM output `iv‖tag‖ct`; HMAC digests).
- **Structured blobs**: `jsonb`.
- **Enums**: native Postgres `ENUM` types (spec-frozen vocabularies), all created in
  migration 1: `call_status`, `held_reason`, `review_status`, `operator_action`,
  `signature_status`, `key_version_status`, `severity`, `gate_type`, `call_intent`
  (new_booking, existing_job, quote, emergency, billing, general), `urgency`
  (emergency, urgent, routine). `service_category` and `sentiment` are intentionally
  NOT enums yet — the specs don't enumerate their values, so they're `text` in Task 1.1
  with the controlled-value constraint deferred to Task 5.2 (see `structured_knowledge`).
- **Retention set** — the six purgeable tables (`raw_webhook_events`,
  `raw_transcripts`, `token_vault`, `clean_transcripts`, `redaction_findings`,
  `match_keys`) each carry `retention_eligible_at`, `soft_deleted_at`,
  `hard_deleted_at` (all `timestamptz` NULL). Define once in
  `migrations/lib/columns.cjs` (`retentionColumns()`) and spread into each. **Not** on
  `call_state` or any other durable table.

### Representative DDL

```sql
-- call_state (durable, NO retention columns)
CREATE TABLE call_state (
  call_id text PRIMARY KEY,
  source text NOT NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}',
  current_stage text NOT NULL,
  status call_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_state_status_stage_idx ON call_state (status, current_stage);

-- token_vault (restricted, encrypted, purgeable)
-- Tokens are per-call placeholders ([NAME_1], [PHONE_1], ...) and recur across calls,
-- so the key is composite (call_id, token) — NOT token alone.
CREATE TABLE token_vault (
  call_id text NOT NULL REFERENCES call_state(call_id),
  token text NOT NULL,
  ciphertext bytea NOT NULL,
  key_version integer NOT NULL REFERENCES key_versions(key_version),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_eligible_at timestamptz,
  soft_deleted_at timestamptz,
  hard_deleted_at timestamptz,
  PRIMARY KEY (call_id, token)
);
-- No separate call_id index: the composite PK's leading column already covers
-- call_id-prefixed lookups.

-- review_queue
CREATE TABLE review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id text NOT NULL REFERENCES call_state(call_id),
  held_reason held_reason NOT NULL,
  status review_status NOT NULL DEFAULT 'open',
  assignee text,
  sla_due_at timestamptz,
  escalated_at timestamptz,
  raw_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX review_queue_open_idx ON review_queue (status) WHERE status IN ('open','in_review');
CREATE INDEX review_queue_call_id_idx ON review_queue (call_id);
```

### Remaining tables (columns per the task spec)

- `raw_webhook_events`: id, received_at, source, payload jsonb (minimized),
  signature_status enum, + retention. idx (received_at).
- `raw_transcripts`: call_id PK, ciphertext bytea, key_version int FK, fetched_at,
  + retention.
- `clean_transcripts`: call_id PK, redacted_text text, redaction_risk_score
  numeric(5,4), redaction_reasons jsonb, created_at, + retention.
- `redaction_findings`: id, call_id FK, entity_type, token_ref text / value_hash
  bytea (never raw value), residual_scan_result jsonb, created_at, + retention.
  idx (call_id).
- `structured_knowledge` (durable): the extractor's schema from execution-plan Task
  5.2 made explicit now — one typed column per field, jsonb for the arrays, plus
  version/model metadata:

  ```sql
  CREATE TABLE structured_knowledge (
    call_id                  text PRIMARY KEY REFERENCES call_state(call_id),
    call_intent              call_intent NOT NULL,   -- enum: new_booking, existing_job,
                                                     --       quote, emergency, billing, general
    service_category         text NOT NULL,          -- controlled plumbing vocabulary; the
                                                     -- CHECK/lookup enforcing the value set is
                                                     -- added in Task 5.2 (list not yet defined —
                                                     -- do NOT invent categories here)
    problem_statement        text,                   -- short neutral summary
    symptoms                 jsonb NOT NULL DEFAULT '[]',
    customer_language        jsonb NOT NULL DEFAULT '[]',  -- PII-free verbatim phrases
    location_in_home         text,
    access_or_scheduling_notes text,
    prior_attempts           text,
    urgency                  urgency NOT NULL,        -- enum: emergency, urgent, routine
                                                     -- (customer-stated, not authoritative)
    concerns                 jsonb NOT NULL DEFAULT '[]',
    sentiment                text NOT NULL,           -- INTERNAL ONLY, never surfaced;
                                                     -- controlled-value set (CHECK/enum) added
                                                     -- in Task 5.2 — values not yet defined,
                                                     -- do NOT invent them here
    acquisition_source       text,
    competitor_mentions      jsonb NOT NULL DEFAULT '[]',
    schema_version           integer NOT NULL,
    prompt_version           text NOT NULL,
    model_id                 text NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX structured_knowledge_intent_idx   ON structured_knowledge (call_intent);
  CREATE INDEX structured_knowledge_category_idx ON structured_knowledge (service_category);
  CREATE INDEX structured_knowledge_urgency_idx  ON structured_knowledge (urgency);
  ```

  Note: `call_intent` and `urgency` are native enums created in migration 1 (their
  value sets are frozen in the execution plan). `service_category` and `sentiment` stay
  `text` for now — the execution plan names them as controlled ("a controlled list of
  plumbing categories"; "sentiment: enum, internal only") but does not enumerate their
  values, so the controlled-value constraint (CHECK / lookup / native enum) lands in
  Task 5.2 when the value sets exist; inventing them here would be wrong. No confidence
  scores are ever stored (CLAUDE.md ADR). `sentiment` is internal-only — never exposed by
  the knowledge-base surface.
- `operator_actions`: id, review_queue_id uuid FK → review_queue(id), actor,
  action enum, before jsonb, after jsonb, created_at.
- `model_invocations`: id, call_id FK, stage, model_id, prompt_version,
  input_tokens int, output_tokens int, outcome, created_at. idx (call_id),(created_at).
- `daily_cost_usage`: day date PK, input_tokens bigint, output_tokens bigint,
  estimated_cost numeric(12,6), updated_at.
- `alert_events`: id, error_code, root_cause_category, severity enum, dedup_key,
  acknowledged_at, created_at, failure_snapshot jsonb. Partial unique index on
  dedup_key WHERE acknowledged_at IS NULL.
- `backfill_runs`: id, window_start, window_end, last_checkpoint, status,
  created_at, updated_at.
- `match_keys`: id, call_id FK, phone_hmac bytea, name_hmac bytea, key_version int
  FK, created_at, + retention. Restricted-role-only. idx (phone_hmac),(name_hmac).
- `consent_gates`: id, gate_type enum, recorded_by, evidence_ref, recorded_at.
- `key_versions`: key_version integer PK, status key_version_status enum,
  wrapped_dek_ref text NOT NULL (external-store pointer ONLY — no key bytes),
  kek_version text NOT NULL, created_at, destroyed_at. `COMMENT` stating no
  recoverable key bytes live here.
- `processing_log`: id, call_id, stage, outcome, error_code, detail jsonb,
  created_at, failure_snapshot jsonb (failure rows). idx (call_id).
- `dead_letter`: id, call_id, job_payload jsonb (sanitized), error_code,
  root_cause_category, last_error, failed_at, failure_snapshot jsonb.

`failure_snapshot` shape (documented in a column COMMENT, enforced in app code, not
DB): `{error_code, root_cause_category, severity, impact, processing_state,
remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref,
context}` — matches CLAUDE.md §4, sanitized (no PII/content).

## Roles & grants (migration 4 + 5)

Three `NOLOGIN` group roles — permission bundles, not login identities (keeps
passwords out of the repo; the Railway login user is granted membership out-of-band).
Each `CREATE ROLE` is existence-guarded, and **only roles this migration actually
creates get a marker comment** — so `down` can tell "we made this" from
"pre-provisioned, leave it alone":

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
    COMMENT ON ROLE app_role IS 'created_by:gcp-call-insights-migration';
  END IF;
END $$;
```

Grants:
- `app_role` — `GRANT SELECT, INSERT, UPDATE` on every working table; **no DELETE**,
  no DDL. Explicit `REVOKE ALL ON token_vault, match_keys FROM app_role` (this is the
  enforcement for the restricted-access test).
- `restricted_role` — `GRANT SELECT, INSERT, UPDATE ON token_vault, match_keys` plus
  `SELECT ON key_versions`. The only role that can read the vault / match keys.
- `purge_role` — `GRANT DELETE` on the six purgeable tables (used only by the
  retention cron).

`down` always revokes the grants this migration made, then **drops a role only if it
still carries the `created_by:gcp-call-insights-migration` marker** — a
pre-provisioned role (no marker) is left in place with its grants revoked. Roles are
cluster-global, so blindly `DROP ROLE`ing one the migration didn't create could break
other databases/services on the same cluster; the marker prevents that. Sketch:

```sql
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    JOIN pg_shdescription d ON d.objoid = r.oid
    WHERE r.rolname = 'app_role'
      AND d.description = 'created_by:gcp-call-insights-migration'
  ) THEN
    DROP ROLE app_role;   -- grants already revoked above; role now owns nothing
  END IF;
END $$;
```

Explicit per-table grants (not broad `ALTER DEFAULT PRIVILEGES`) for auditability.

**Managed-Postgres note:** with guarded CREATE, a pre-provisioned role is a no-op; if
the Railway migration user lacks `CREATEROLE` and the roles don't yet exist, deploy
fails with `MIGRATION_FAILED` — fallback is a one-time manual `CREATE ROLE` by a
superuser. Document this in `migrations/README.md`.

## Envelope encryption (`src/crypto/`)

- `src/crypto/key-provider.ts` — `KeyProvider` interface + `LocalKeyProvider` (dev).
  ```ts
  export interface KeyProvider {
    getDek(keyVersion: number): Promise<Buffer>;   // 32-byte AES-256 DEK, unwrapped via KEK
    currentKeyVersion(): Promise<number>;
  }
  ```
  Wrapped DEK material + KEK live in the external store the provider reads;
  `key_versions` holds only metadata + `wrapped_dek_ref`. `LocalKeyProvider` derives
  per-version DEKs via `hkdfSync` from a config master secret — exercises the full
  version/wrap path with no real KMS; guarded off in staging/prod; the real KMS
  provider is deferred to Task 8.2.
- `src/crypto/envelope.ts` — AES-256-GCM via `node:crypto`. Per-encrypt random 12-byte
  IV; output `ciphertext = iv(12) ‖ authTag(16) ‖ ct` in the `bytea` column; AAD binds
  `key_version` (+ optionally `call_id`).
  ```ts
  export interface Encrypted { ciphertext: Buffer; keyVersion: number; }
  export function encrypt(pt: Buffer, kp: KeyProvider, aad?: Buffer): Promise<Encrypted>;
  export function decrypt(enc: { ciphertext: Buffer; keyVersion: number }, kp: KeyProvider, aad?: Buffer): Promise<Buffer>;
  ```
  `keyVersion` is the FK link to `key_versions`. The module never logs key material
  (`dek`/`kek` are already in the redaction guard's blocklist).
- `src/crypto/index.ts` — barrel.

**Config additions** ([src/config/schema.ts](src/config/schema.ts) + `.env.example`
in lockstep):
- `CRYPTO_KEY_PROVIDER: z.enum(['local','kms']).default('local')`
- `CRYPTO_LOCAL_MASTER_KEY: z.string().min(44).optional()` (base64 32-byte;
  `superRefine` requires it when provider=local; placeholder only in `.env.example`)
- `CRYPTO_ACTIVE_KEY_VERSION: z.coerce.number().int().positive().default(1)`
- Comment noting real KMS vars are Task 8.2.

## Test strategy

Two tiers. **Pure-unit** (crypto round-trip, `migrate.test.ts` option assertion) run
everywhere and always. **DB-integration** (`test/db/*.test.ts`) are
`describe.skipIf(!process.env.TEST_DATABASE_URL)` so they skip cleanly on a laptop
with no database — but they are the core Task 1.1 acceptance criteria, so they **must
run and pass in CI**, not silently skip.

- **CI wiring (required):** add a Postgres **service container** to the CI test job
  (`.github/workflows/`) and export `TEST_DATABASE_URL` pointing at it, so the DB
  suite executes on every PR and gates merge. Add a guard so a green run cannot come
  from an all-skipped DB suite — e.g. an always-run assertion that fails when
  `TEST_DATABASE_URL` is unset in the CI environment (CI sets a `CI=true` marker; the
  guard test asserts `CI ⇒ TEST_DATABASE_URL is set`). Local skipping stays allowed;
  CI skipping does not.
- **`SET ROLE` privilege model:** the role-isolation test does `SET ROLE app_role`
  / `SET ROLE restricted_role`, which requires the connecting user to be a **superuser
  or a member of those roles**. The `TEST_DATABASE_URL` owner must therefore be a
  superuser / `CREATEROLE` test owner (the CI Postgres service's default `postgres`
  user satisfies this). Belt-and-suspenders: `test/db/_pg.ts` setup `GRANT`s the test
  user temporary membership in both group roles and `REVOKE`s it in teardown, so the
  suite also works when the owner is `CREATEROLE` but not superuser. Document the
  superuser requirement next to the skip gate.

Test files: `schema-roundtrip` (up→down(Infinity)→up, normalized snapshot equal),
`role-isolation` (app_role denied 42501 on `token_vault`/`match_keys`; restricted_role
allowed), `retention-columns` (three timestamps on the six purgeable tables, none on
`call_state`), `encrypted-row-roundtrip` (encrypt→store→read→decrypt; **plus a
token-collision case: two different `call_id`s each store the same token label, e.g.
`[NAME_1]`, and both rows coexist under the composite `(call_id, token)` PK**), plus
the always-run `envelope` unit test.

## Files to create / modify

**Create:**
- `migrations/<ts>_extensions_and_enums.cjs`, `_core_tables.cjs`,
  `_restricted_tables.cjs`, `_roles.cjs`, `_grants.cjs`
- `migrations/lib/columns.cjs` (`retentionColumns()` helper; in a subdir so the
  loader skips it)
- `src/crypto/key-provider.ts`, `src/crypto/envelope.ts`, `src/crypto/index.ts`
- `test/crypto/envelope.test.ts` (pure unit, always runs)
- `test/db/_pg.ts` (pg.Pool to `TEST_DATABASE_URL`), `test/db/schema-roundtrip.test.ts`,
  `test/db/role-isolation.test.ts`, `test/db/retention-columns.test.ts`,
  `test/db/encrypted-row-roundtrip.test.ts` (all `describe.skipIf(!TEST_DATABASE_URL)`)

**Modify:**
- [src/boot/migrate-runner.ts](src/boot/migrate-runner.ts) — add `ignorePattern`.
- [test/migrate.test.ts](test/migrate.test.ts) — assert the new option.
- [src/config/schema.ts](src/config/schema.ts) + `.env.example` — crypto vars (lockstep).
- `migrations/README.md` — note the schema is now Task 1.1, the manual-role fallback,
  and that the DB test owner must be superuser/`CREATEROLE`.
- `.github/workflows/*` — add a Postgres service container + `TEST_DATABASE_URL` to the
  test job so the DB suite is required on every PR (see §Test strategy).

## Verification

1. `npm run typecheck && npm run lint && npm run build` — all green.
2. `npm run test` — crypto round-trip + `migrate.test.ts` pass; DB tests skip
   cleanly with no `TEST_DATABASE_URL` locally (but CI sets it — see below).
3. With a superuser/`CREATEROLE` Postgres (CI's service container, or local):
   `TEST_DATABASE_URL=postgres://... npm run test` runs the DB suite, asserting:
   - **up → down(Infinity) → up** leaves an identical normalized schema snapshot
     (columns + enums + indexes + FKs); after full down only `pgmigrations` remains.
   - `SET ROLE app_role; SELECT FROM token_vault` / `match_keys` → permission denied
     (42501); `SET ROLE restricted_role; SELECT FROM token_vault` → succeeds. (Requires
     the connecting user to be superuser or a member of the roles — see §Test strategy.)
   - the six purgeable tables each have all three retention timestamps; `call_state`
     has none.
   - an encrypted row written via `encrypt()` into `token_vault`/`raw_transcripts`
     reads back and `decrypt()`s to the original bytes.
   - `down` leaves a **pre-provisioned** (unmarked) role in place — verify by creating
     a role manually before `up`, running up→down, and confirming the role survives.
4. **CI proves it, not just locally:** the PR test job runs the full DB suite against
   its Postgres service; a guard test fails if `TEST_DATABASE_URL` is unset under `CI`,
   so a green build cannot come from an all-skipped DB suite.
5. `DATABASE_URL=postgres://... npm run db:migrate` applies cleanly end-to-end (the
   real pre-deploy path), and `npm run db:migrate:down` rolls back one file.
