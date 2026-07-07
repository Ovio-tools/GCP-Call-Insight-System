# Redaction inspection (operator diagnostic)

`src/scripts/inspect-redaction.ts` lets the data controller **manually verify** why the redaction
stage held a call with `residual_pii_detected`: it decrypts the raw transcript, runs the exact
redaction-stage input + detectors + tokenizer + independent residual scan, and prints what the gate
is holding on — the redacted output, the values that were vaulted, and the specific vaulted value(s)
that reappear **unredacted** in the output (with a short context window).

Use it to distinguish a **genuine** hold (a name the NER caught once but missed elsewhere; a number
the primary layers missed) from a false hold.

## What it does / does not do

- Reads **only** `raw_transcripts` (envelope-decrypted in-process). Writes **nothing** — no clean
  row, no vault, no findings, no model call. It never leaves Railway.
- **It prints REAL transcript content to stdout.** It is therefore hard-gated to the same §0.2
  exception the sample-validation harness uses (`assertStagingResources`, checked before any
  decrypt):
  1. `NODE_ENV=staging`
  2. no configured resource (`DATABASE_URL` / `REDIS_URL` / `DIALPAD_BASE_URL` / `OIDC_ISSUER_URL`)
     resolves to a host containing `prod` / `production`.
  It will refuse to run anywhere else. Output goes to the container logs — treat those logs as
  sensitive while inspecting.

## Usage

```
node dist/scripts/inspect-redaction.js --calls <id1,id2,...> [--full]
```

- `--calls` — comma-separated call ids that already have a `raw_transcripts` row (e.g. the
  sample-validation calls).
- `--full` — also print the entire extracted + redacted text (more content exposure; off by
  default — the default view shows only the residual hits + context + vaulted values).

## Running it on Railway (the sample-validation service)

The keystore keys live on that service's volume, so run it there, as a one-off — the same pattern
as `bootstrap-key` (see `docs/demo-sample-validation-railway.md`):

1. Temporarily set the service **start command** to:
   ```
   node dist/scripts/inspect-redaction.js --calls "${SAMPLE_CALL_IDS}"
   ```
   (add `--full` if you want the whole redacted text).
2. **Redeploy**, read the report in the service logs.
3. **Restore** the start command to the config-as-code default
   (`run-sample-validation.js …`) so the next run is the normal harness again.

## Reading the output

Per call:

- `residual scan: HOLD — vault_value_reintroduced=3` (or `no hits — this call would PASS`).
- `reintroduced values` — each vaulted value that reappears unredacted, with a context window
  showing where. If a value matched only under normalization (punctuation between characters),
  the literal search may not pinpoint it — use `--full` and scan the redacted text.
- `vaulted values (N)` — what redaction **did** catch (so you can see the caught-once/missed-again
  pattern).

If the reintroduced value is a real name/number visible unredacted in the context, the hold is
genuine — the fix is higher primary-redaction recall (not weakening the residual scan).
