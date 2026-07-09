import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { putTranscript } from '../../src/db/repositories/raw-transcripts-repo.js';
import { insertRawTombstone } from '../../src/db/repositories/raw-purge-tombstone-repo.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import { replaceFindings } from '../../src/db/repositories/redaction-findings-repo.js';
import type { RestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { putToken } from '../../src/db/restricted/token-vault-repo.js';
import { withTransaction } from '../../src/db/sql.js';
import {
  cleanupCalls,
  cleanupRawCalls,
  makeAppPool,
  makeRawAppPool,
  makeRawRestrictedRunner,
  seedKeyVersion,
} from './_dal.js';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from './_pg.js';

const PATTERN = 'test-fin-%';

/**
 * Task 8.1 §6 — finality guards on the recreate paths. After retention removes content (normal
 * stamp-and-scrub hard delete, OR the held-cap PHYSICAL delete of raw/vault), no writer may
 * repopulate it — even if a caller bypasses the redact preflight.
 *
 * ADR 0008 Move 2 — raw_transcripts + token_vault now live ONLY in DB-B, and the "purged" finality
 * marker is a DB-B-local `raw_purge_tombstone` row (not a cross-DB review_queue read). So the
 * raw/vault cases below run against DB-B; the clean/findings cases stay on DB-A.
 */
describe.skipIf(!hasTestDb)('recreate finality guards — clean/findings (DB-A)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function seedCall(callId: string, status = 'processing'): Promise<void> {
    await upsertCallState(app, { callId, source: 'test', currentStage: 'redact', status });
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  describe('after a normal hard-delete (tombstone), all writers refuse', () => {
    it('upsertCleanTranscript refuses', async () => {
      const callId = 'test-fin-clean-hd';
      await seedCall(callId);
      await upsertCleanTranscript(app, { callId, redactedText: 'v1', redactionRiskScore: 0.1 });
      await owner.query(`UPDATE clean_transcripts SET hard_deleted_at = now() WHERE call_id = $1`, [
        callId,
      ]);
      await expect(
        upsertCleanTranscript(app, { callId, redactedText: 'v2', redactionRiskScore: 0.2 }),
      ).rejects.toThrow(/retention conflict/);
    });

    it('replaceFindings refuses when a findings tombstone exists (preflight bypassed)', async () => {
      const callId = 'test-fin-find-hd';
      await seedCall(callId);
      await replaceFindings(app, callId, [{ entityType: 'NAME', tokenRef: '[NAME_1]' }]);
      await owner.query(
        `UPDATE redaction_findings SET hard_deleted_at = now() WHERE call_id = $1`,
        [callId],
      );
      await expect(
        replaceFindings(app, callId, [{ entityType: 'PHONE', tokenRef: '[PHONE_1]' }]),
      ).rejects.toThrow(/retention conflict/);
    });

    it('replaceFindings refuses when the parent clean transcript is hard-deleted', async () => {
      const callId = 'test-fin-find-clean-hd';
      await seedCall(callId);
      await upsertCleanTranscript(app, { callId, redactedText: 'v1', redactionRiskScore: 0.1 });
      await owner.query(`UPDATE clean_transcripts SET hard_deleted_at = now() WHERE call_id = $1`, [
        callId,
      ]);
      await expect(
        replaceFindings(app, callId, [{ entityType: 'NAME', tokenRef: '[NAME_1]' }]),
      ).rejects.toThrow(/retention conflict/);
    });
  });
});

/**
 * raw_transcripts + token_vault finality — DB-B. Raw/vault rows no longer FK to call_state or
 * key_versions (cross-DB FKs dropped), so no seeding of those is needed on DB-B; the
 * LocalKeyProvider encrypt/decrypt needs no DB row.
 */
describe.skipIf(!hasRawTestDb)('recreate finality guards — raw/vault (DB-B)', () => {
  let rawOwner!: Pool;
  let rawApp!: Pool;
  let rawRunnerPool!: Pool;
  let rawRunner!: RestrictedRunner;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  beforeAll(async () => {
    await migrateRaw('up');
    rawOwner = makeRawPool();
    rawApp = makeRawAppPool();
    const rr = makeRawRestrictedRunner();
    rawRunnerPool = rr.pool;
    rawRunner = rr.runner;
  });
  afterEach(async () => {
    await cleanupRawCalls(rawOwner, PATTERN);
  });
  afterAll(async () => {
    await rawOwner.end();
    await rawApp.end();
    await rawRunnerPool.end();
  });

  describe('after a normal hard-delete (tombstone), all writers refuse', () => {
    it('putTranscript refuses and leaves the tombstone unchanged', async () => {
      const callId = 'test-fin-raw-hd';
      await putTranscript(rawApp, keyProvider, { callId, transcript: 'original' });
      await rawOwner.query(
        `UPDATE raw_transcripts SET hard_deleted_at = now(), ciphertext = ''::bytea WHERE call_id = $1`,
        [callId],
      );
      const before = await rawOwner.query(
        `SELECT ciphertext, hard_deleted_at FROM raw_transcripts WHERE call_id = $1`,
        [callId],
      );
      await expect(
        putTranscript(rawApp, keyProvider, { callId, transcript: 'new' }),
      ).rejects.toThrow(/retention conflict/);
      const after = await rawOwner.query(
        `SELECT ciphertext, hard_deleted_at FROM raw_transcripts WHERE call_id = $1`,
        [callId],
      );
      expect(after.rows).toEqual(before.rows);
    });

    it('putToken refuses', async () => {
      const callId = 'test-fin-vault-hd';
      await putToken(rawRunner, keyProvider, {
        callId,
        token: '[NAME_1]',
        plaintext: Buffer.from('x'),
      });
      await rawOwner.query(`UPDATE token_vault SET hard_deleted_at = now() WHERE call_id = $1`, [
        callId,
      ]);
      await expect(
        putToken(rawRunner, keyProvider, {
          callId,
          token: '[NAME_1]',
          plaintext: Buffer.from('y'),
        }),
      ).rejects.toThrow(/retention conflict/);
    });
  });

  describe('after a held-cap physical purge (raw/vault gone, tombstone set), writers refuse', () => {
    async function heldCapPurge(callId: string): Promise<void> {
      // Simulate Task 8.1 held-cap purge on DB-B: physically delete raw/vault + write the
      // DB-B-local finality tombstone, all in one transaction.
      await withTransaction(rawOwner, async (client) => {
        await client.query(`DELETE FROM token_vault WHERE call_id = $1`, [callId]);
        await client.query(`DELETE FROM raw_transcripts WHERE call_id = $1`, [callId]);
        await insertRawTombstone(client, callId, new Date());
      });
    }

    it('putTranscript (app_role) refuses to recreate after held-cap purge', async () => {
      const callId = 'test-fin-heldcap-raw';
      await heldCapPurge(callId);
      await expect(
        putTranscript(rawApp, keyProvider, { callId, transcript: 'new' }),
      ).rejects.toThrow(/retention conflict/);
      expect(
        (await rawOwner.query(`SELECT 1 FROM raw_transcripts WHERE call_id = $1`, [callId]))
          .rowCount,
      ).toBe(0);
    });

    it('putToken (restricted_role) refuses to recreate after held-cap purge', async () => {
      const callId = 'test-fin-heldcap-vault';
      await heldCapPurge(callId);
      await expect(
        putToken(rawRunner, keyProvider, {
          callId,
          token: '[NAME_1]',
          plaintext: Buffer.from('x'),
        }),
      ).rejects.toThrow(/retention conflict/);
      expect(
        (await rawOwner.query(`SELECT 1 FROM token_vault WHERE call_id = $1`, [callId])).rowCount,
      ).toBe(0);
    });
  });
});
