# Dialpad webhook receiver (Task 3.2)

The public entrypoint that turns Dialpad call events into pipeline jobs. It is built on the
shared Task 2.3 hardening middleware (`src/http/`) — body-size limit, per-provider rate limit,
replay store, timestamp-skew check, and PII-free error shaping — and adds only the Dialpad
specifics. Entrypoint: `src/services/webhook-receiver.ts`; wiring: `src/dialpad/webhook/`.

## Route

`POST /webhooks/dialpad` (provider `dialpad`). Configure this URL and a shared secret on the
Dialpad event subscription.

## Delivery contract

When a secret is set, Dialpad sends each event as a **compact JWT (JWS) — the entire HTTP body —
signed with the shared secret using HS256**. After the signature is verified, the JSON event data
is the JWT payload. The receiver installs a catch-all raw-body content-type parser
(`removeAllContentTypeParsers()` + `*` → Buffer), so a bare-JWT body is never rejected as
malformed JSON regardless of the `Content-Type` header. The body-size limit still applies.

## Request processing order

1. **Body-size limit** (`HTTP_MAX_BODY_BYTES`) — oversized → `REQUEST_BODY_TOO_LARGE` (413).
2. **Per-provider rate limit** (`WEBHOOK_RATE_LIMIT_*`) — over → `RATE_LIMIT_EXCEEDED` (429).
3. **Signature** — HS256 over the JWT signing input, `alg` pinned to HS256 (blocks `alg:none` and
   algorithm confusion), constant-time compare, tried against the primary then the optional
   previous secret. Failure → `WEBHOOK_SIGNATURE_INVALID` (401), no side effects.
4. **Timestamp** — `iat` (seconds) must be within `WEBHOOK_TIMESTAMP_SKEW_MS`. Failure →
   `WEBHOOK_TIMESTAMP_INVALID` (400). (If a real payload ever lacks `iat`, register in unsupported
   mode by omitting `extractTimestamp`; replay + body limit remain the guards.)
5. **Replay** — key per the fallback matrix below; duplicate → `WEBHOOK_REPLAY_DETECTED` (409),
   no enqueue.
6. **Handler** — decode claims, **resolve** the call id from any known-equivalent shape (see
   [Field resolution](#field-resolution-mvp)); if none is present → `REQUEST_MALFORMED` (400).
   Then: seed `call_state` (non-PII `source_metadata`, so the Task 3.1 pre-filter has input), write
   a minimized `raw_webhook_events` audit row, enqueue exactly one ingest job keyed by the resolved
   call id, return `200 { received: true }`. No transcript fetch, no model call, no heavy work.

## Replay-key fallback matrix

The middleware namespaces the key by provider (`dialpad:`). Within that:

- **(a)** a unique event id claim (`jti` / `event_id` / `id`) → `id:<value>` (preferred);
- **(b)** else, using the signed `iat` → `sig:<sha256(payload segment)>:<iat>`;
- **(c)** else → `sig:<sha256(payload segment)>` alone. **Documented limitation:** two
  byte-identical distinct events collapse to one — the fail-safe direction (at worst a rare dropped
  duplicate, recovered by the reconciliation cron, Task 3.4; never a duplicate-process).

The payload segment is the exact signed bytes, so the digest is canonical and unforgeable. A bare
`call_id:state` composite is never used.

## What is stored (minimization / allowlist)

Nothing copies the raw payload. Two build-up allowlists (not denylist scrubs), so
transcript/message/free-text can never leak even if Dialpad adds fields:

- **`call_state.source_metadata`** (retained indefinitely) — a STRICT non-PII allowlist:
  `direction`, `state`, `duration`, `is_internal`, `operator_call_id`, `master_call_id`,
  `date_started`, `date_ended`. No phone/name, not even hashed.
- **`raw_webhook_events`** (purgeable) — `source`, `received_at`, `signature_status = valid`,
  `retention_eligible_at`, and a `payload` allowlist: `event_id` (the replay key), `call_id`,
  the same non-PII metadata, `iat`, plus `phone_hmac` / `name_hmac` / `email_hmac` arrays when a
  phone, name, or email appears **anywhere** in the payload. Each value is **normalized to a
  canonical form before hashing** (phones → digits with an optional leading `+`; names → trimmed,
  whitespace-collapsed, lowercased; emails → trimmed, lowercased) so the same person hashes
  identically regardless of formatting, and incidental non-PII leaves (e.g. a `"work"` label inside
  a phone object, or a short sequence number) are dropped rather than hashed as noise. Values are
  one-way HMAC-SHA256 hashed under `DIALPAD_PII_HASH_SECRET`; the plaintext is never stored.

`received_at` and `retention_eligible_at` are both stamped to a single captured `clock.now()` at
ingest; the retention cron (Task 8.1) applies the `RAW_WEBHOOK_RETENTION_MS` window before purging.

## Idempotency

- Duplicate delivery within `WEBHOOK_REPLAY_WINDOW_MS` → replay store rejects it (atomic
  `SET NX`), no enqueue.
- Duplicate beyond the window → the enqueue collapses by `call_id` (`SHA256(callId)` job id) while
  the job is live; `upsertCallState` is idempotent; a second append-only audit row is acceptable.
- The replay reservation is committed only after the handler succeeds and released on handler
  failure, so a legitimate Dialpad retry after a transient error is accepted.

## Configuration

| Variable                          | Purpose                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `DIALPAD_WEBHOOK_SECRET`          | Primary HS256 signing secret. **Required** wherever the route is registered.     |
| `DIALPAD_WEBHOOK_SECRET_PREVIOUS` | Previous secret, accepted during a rotation overlap only.                        |
| `DIALPAD_PII_HASH_SECRET`         | Keys the one-way phone/name HMAC. **Required** wherever the route is registered. |
| `RAW_WEBHOOK_RETENTION_MS`        | Purge window applied by the retention cron (Task 8.1).                           |

`registerDialpadWebhook` throws `CONFIG_MISSING_OR_INVALID` at registration if the signing secret
or the PII hash secret is absent, in every environment — there is no unsigned-verify path and no
plaintext-phone/name fallback.

## Secret rotation (dual-secret, zero-downtime)

Order matters — the receiver must accept both secrets **before** Dialpad signs with the new one:

1. Generate a new secret. Set `DIALPAD_WEBHOOK_SECRET_PREVIOUS = <current>` and
   `DIALPAD_WEBHOOK_SECRET = <new>` in config and **deploy the receiver first**. It now accepts
   both (every current event matches on the `previous` slot).
2. Only then, switch the webhook secret in Dialpad to `<new>`.
3. Watch the `webhook_key_slot` log field shift from `previous` to `primary`; confirm `previous`
   usage falls to zero and the rejection rate stays flat.
4. After `previous` usage has been zero for at least one `WEBHOOK_REPLAY_WINDOW_MS`, remove
   `DIALPAD_WEBHOOK_SECRET_PREVIOUS` and deploy. Rotation complete, zero missed events.

Any events rejected during a mis-sequenced rotation are still recovered by the reconciliation cron
(Task 3.4), so the failure mode is bounded.

## Field resolution (MVP) <a id="field-resolution-mvp"></a>

The Dialpad claim field names are **provisional** — mirrored from the Task 3.1 pre-filter and not
yet reconciled against a corpus of real production payloads (tracked as issue #31). To keep the
MVP/staging demo from hard-failing when a real payload spells or nests a field slightly differently,
`src/dialpad/webhook/payload.ts` resolves each canonical field from a **small, explicit prioritized
list of known-equivalent paths** — an allowlist of accepted shapes, not a broad fuzzy search. An
unknown shape still resolves to `undefined` (metadata under-populates safely; a missing call id
rejects cleanly), and nothing outside the allowlist is ever stored.

| Canonical field                                                       | Accepted shapes (in priority order)                                                                     | Status                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------- |
| **call id** (required)                                                | `call_id`, `callId`, `call.call_id`, `call.callId`, `call.id`, `data.call_id`, `data.callId`, `data.id` | provisional — validate live |
| `direction` / `state` / `duration`                                    | top-level, or nested under `call.` / `data.`                                                            | provisional                 |
| `is_internal`                                                         | `is_internal`, `internal`, or nested under `call.` / `data.`                                            | provisional                 |
| `operator_call_id` / `master_call_id` / `date_started` / `date_ended` | top-level, or nested under `call.` / `data.`                                                            | provisional                 |
| `iat` (signed timestamp)                                              | top-level JWT claim                                                                                     | confirmed (JWT standard)    |

A **bare top-level `id`** is intentionally NOT treated as the call id — it is the event-id fallback
for the replay key (see the matrix above), so it is only trusted as a call id when disambiguated by
a `call`/`data` wrapper.

### Before production

- **Validate these shapes against real Dialpad webhook traffic** (issue #31). Capture a sample of
  real `call` events in staging, confirm which shape Dialpad actually sends, and prune the accepted
  paths down to the confirmed spelling(s). The alias list is a demo-robustness measure, not a
  license to keep guessing indefinitely.
- Confirm `iat` is always present; if any real event lacks it, register in unsupported-timestamp
  mode (omit `extractTimestamp`) — replay + body limit remain the guards.

## Post-MVP hardening (deferred)

- **Non-atomic side effect** (issue #34): the sink performs `call_state` seed → audit insert →
  enqueue as three separate operations, not one transaction (and the enqueue targets Redis, which
  cannot share a Postgres transaction). A crash between steps can leave a call seeded but not
  enqueued. This is **acceptable for a controlled MVP/demo** because the **reconciliation cron
  (Task 3.4) re-enqueues any concluded call the webhook missed**, bounding the failure. A
  production-grade fix (transactional outbox for the enqueue) is deferred and out of scope for the
  MVP.
