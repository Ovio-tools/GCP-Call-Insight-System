import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { putTranscript } from '../../src/db/repositories/raw-transcripts-repo.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import { replaceFindings } from '../../src/db/repositories/redaction-findings-repo.js';
import { markRawPurged } from '../../src/db/repositories/review-queue-repo.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { putToken } from '../../src/db/restricted/token-vault-repo.js';
import { withTransaction } from '../../src/db/sql.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from './_dal.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

const PATTERN = 'test-fin-%';

/**
 * Task 8.1 §6 — finality guards on the recreate paths. After retention removes content (normal
 * stamp-and-scrub hard delete, OR the held-cap PHYSICAL delete of raw/vault), no writer may
 * repopulate it — even if a caller bypasses the redact preflight.
 */
describe.skipIf(!hasTestDb)('recreate finality guards (Task 8.1)', () => {
  let owner!: Pool;
  let app!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

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
    it('putTranscript refuses and leaves the tombstone unchanged', async () => {
      const callId = 'test-fin-raw-hd';
      await seedCall(callId);
      await putTranscript(app, keyProvider, { callId, transcript: 'original' });
      await owner.query(
        `UPDATE raw_transcripts SET hard_deleted_at = now(), ciphertext = ''::bytea WHERE call_id = $1`,
        [callId],
      );
      const before = await owner.query(
        `SELECT ciphertext, hard_deleted_at FROM raw_transcripts WHERE call_id = $1`,
        [callId],
      );
      await expect(putTranscript(app, keyProvider, { callId, transcript: 'new' })).rejects.toThrow(
        /retention conflict/,
      );
      const after = await owner.query(
        `SELECT ciphertext, hard_deleted_at FROM raw_transcripts WHERE call_id = $1`,
        [callId],
      );
      expect(after.rows).toEqual(before.rows);
    });

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

    it('putToken refuses', async () => {
      const callId = 'test-fin-vault-hd';
      await seedCall(callId);
      const runner = createRestrictedRunner(app);
      await putToken(runner, keyProvider, {
        callId,
        token: '[NAME_1]',
        plaintext: Buffer.from('x'),
      });
      await owner.query(`UPDATE token_vault SET hard_deleted_at = now() WHERE call_id = $1`, [
        callId,
      ]);
      await expect(
        putToken(runner, keyProvider, { callId, token: '[NAME_1]', plaintext: Buffer.from('y') }),
      ).rejects.toThrow(/retention conflict/);
    });
  });

  describe('after a held-cap physical purge (raw/vault gone, raw_purged_at set), writers refuse', () => {
    async function heldCapPurge(callId: string): Promise<void> {
      await owner.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ($1, 'test', 'redact', 'held') ON CONFLICT (call_id) DO NOTHING`,
        [callId],
      );
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, created_at)
         VALUES ($1, 'missing_transcript', 'unresolvable', now() + interval '1 hour', now() - interval '10 days')
         RETURNING id`,
        [callId],
      );
      // Simulate Task 8.1 held-cap purge: physically delete raw/vault + stamp raw_purged_at.
      await withTransaction(owner, async (client) => {
        await client.query(`DELETE FROM token_vault WHERE call_id = $1`, [callId]);
        await client.query(`DELETE FROM raw_transcripts WHERE call_id = $1`, [callId]);
        await markRawPurged(client, rows[0]!.id, new Date());
      });
    }

    it('putTranscript (app_role) refuses to recreate after held-cap purge', async () => {
      const callId = 'test-fin-heldcap-raw';
      await heldCapPurge(callId);
      await expect(putTranscript(app, keyProvider, { callId, transcript: 'new' })).rejects.toThrow(
        /retention conflict/,
      );
      expect(
        (await owner.query(`SELECT 1 FROM raw_transcripts WHERE call_id = $1`, [callId])).rowCount,
      ).toBe(0);
    });

    it('putToken (restricted_role) refuses to recreate after held-cap purge', async () => {
      const callId = 'test-fin-heldcap-vault';
      await heldCapPurge(callId);
      await expect(
        putToken(createRestrictedRunner(app), keyProvider, {
          callId,
          token: '[NAME_1]',
          plaintext: Buffer.from('x'),
        }),
      ).rejects.toThrow(/retention conflict/);
      expect(
        (await owner.query(`SELECT 1 FROM token_vault WHERE call_id = $1`, [callId])).rowCount,
      ).toBe(0);
    });
  });
});
