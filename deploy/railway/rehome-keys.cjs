/*
 * One-off ops tool: re-home the file-keystore keys into the worker's Railway secrets.
 *
 * WHY: this environment was first set up with the file-based keystore provider (keys on the
 * `sample-validation` volume at /data/keystore). To move the worker to the `railway` key provider,
 * the SAME key bytes must live in the worker's CRYPTO_KEK_MATERIAL / CRYPTO_WRAPPED_DEK_MATERIAL
 * secrets, in the RailwaySecretKeyStore document shape. This copies them.
 *
 * HOW TO RUN: as a one-off DEPLOYMENT of the `sample-validation` service (which mounts the keystore
 * volume). Point that service's config-as-code path at deploy/railway/rehome-keys.json and redeploy.
 * It reads the two key files, writes the two worker secrets via Railway's API, and exits. It prints
 * ONLY success/failure to the deploy logs — never key bytes.
 *
 * ENV (all already present on sample-validation, or injected by Railway):
 *   REHOME_TOKEN (or RAILWAY_API_TOKEN) — a Railway ACCOUNT API token (Authorization: Bearer)
 *   RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID — auto-injected by Railway on the service
 *   WORKER_SERVICE_ID — the worker service id (defaults to the known dev worker id below)
 *   CRYPTO_KEY_STORE_DIR — keystore dir (defaults to /data/keystore)
 *
 * This is deliberately dependency-free (node builtins + global fetch), so it needs no build.
 */
const { readFileSync, readdirSync } = require('node:fs');

const DIR = process.env.CRYPTO_KEY_STORE_DIR || '/data/keystore';

// Discover the active DEK on the volume. LocalFileKeyStore (src/crypto/key-store.ts #dekPath/#dekMetaPath)
// stores DEKs as dek/v<N>.wrapped with a sidecar dek/v<N>.meta.json — NOT dek/<N>.key.
const dekDir = `${DIR}/dek`;
const wrappedFiles = readdirSync(dekDir).filter((f) => /^v\d+\.wrapped$/.test(f));
if (wrappedFiles.length === 0) {
  // Names only, never bytes — safe to log for diagnosis.
  console.error(
    `re-home failed: no v<N>.wrapped DEK in ${dekDir} (entries: ${readdirSync(dekDir).join(', ')})`,
  );
  process.exit(1);
}
// Explicit override wins; otherwise take the highest version present.
const dekVersion =
  process.env.REHOME_DEK_VERSION ||
  String(Math.max(...wrappedFiles.map((f) => parseInt(f.slice(1), 10))));
// The DEK's own meta names the KEK that wraps it — source of truth, no guessing.
const dekMeta = JSON.parse(readFileSync(`${dekDir}/v${dekVersion}.meta.json`, 'utf8'));
const kekVersion = dekMeta.kekVersion;

const token = process.env.REHOME_TOKEN || process.env.RAILWAY_API_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const serviceId = process.env.WORKER_SERVICE_ID || '7ef73820-4093-4026-b4f8-53012a4c9acb';
for (const [k, v] of Object.entries({ token, projectId, environmentId, serviceId, kekVersion })) {
  if (!v) {
    console.error(`re-home failed: missing ${k}`);
    process.exit(1);
  }
}

// Exact RailwaySecretKeyStore document shapes (see src/crypto/railway-secret-key-store.ts):
// KEK entry uses `bytes`; DEK entry uses `wrapped` + `kekVersion`. Both docs carry active + pending.
const kekBytes = readFileSync(`${DIR}/kek/${kekVersion}.key`); // raw 32-byte KEK
const dekWrapped = readFileSync(`${dekDir}/v${dekVersion}.wrapped`); // wrapped DEK (dek-wrap format)
const kekDoc = JSON.stringify({
  active: { [kekVersion]: { bytes: kekBytes.toString('base64') } },
  pending: {},
});
const dekDoc = JSON.stringify({
  active: { [dekVersion]: { wrapped: dekWrapped.toString('base64'), kekVersion } },
  pending: {},
});

// Railway variableUpsert requires projectId + environmentId (+ serviceId to target one service),
// per docs.railway.com/guides/manage-variables.
const MUT = `mutation($projectId:String!,$environmentId:String!,$serviceId:String!,$name:String!,$value:String!){
  variableUpsert(input:{projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId,name:$name,value:$value})
}`;

async function upsert(name, value) {
  const res = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: MUT,
      variables: { projectId, environmentId, serviceId, name, value },
    }),
  });
  const json = await res.json().catch(() => ({}));
  // Never include the value or the raw error body — either can echo key material.
  if (!res.ok || (json && json.errors))
    throw new Error(`variableUpsert ${name} failed (HTTP ${res.status})`);
}

(async () => {
  await upsert('CRYPTO_KEK_MATERIAL', kekDoc);
  await upsert('CRYPTO_WRAPPED_DEK_MATERIAL', dekDoc);
  console.log(
    `re-home complete: CRYPTO_KEK_MATERIAL + CRYPTO_WRAPPED_DEK_MATERIAL written to the worker (DEK v${dekVersion} wrapped by KEK ${kekVersion})`,
  );
})().catch((e) => {
  console.error('re-home failed:', e.message);
  process.exit(1);
});
