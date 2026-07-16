import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, seedLargeUniverse, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

// TIME-04 perf: GET /timeline at 50 pins / 220 entries returns sorted in < 50ms median.
// 5 runs, median taken. Threshold rationale: research §6 cites the index +
// ORDER BY ASC over a doublePrecision column at 50 rows as easily sub-millisecond
// in Postgres; the 50ms budget is for the full HTTP round-trip including JSON
// serialization. CI environments may run hot — if median creeps above 50ms but
// stays under 100ms on a slow runner, do NOT loosen below 100ms without research.
describe('Timeline perf (TIME-04 sort-at-scale)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  it('sorts 50 pins across 220 entries in < 50ms median', async () => {
    const user = await createTestUser(handle, { email: 'tl-perf@test.com', password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    const { universeId } = await seedLargeUniverse(handle, user.id, { pinCount: 50 });

    const latencies: number[] = [];
    let lastBody: any[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const res = await app.fetch(
        new Request(`http://test/api/universes/${universeId}/timeline`, {
          headers: authHeader(token),
        })
      );
      latencies.push(performance.now() - start);
      expect(res.status).toBe(200);
      lastBody = await res.json();
      expect(lastBody).toHaveLength(50);
      // ASC sort assertion: positions strictly non-decreasing
      for (let j = 1; j < lastBody.length; j++) {
        expect(lastBody[j].position).toBeGreaterThanOrEqual(lastBody[j - 1]!.position);
      }
    }

    latencies.sort((a, b) => a - b);
    const median = latencies[2]!;
    // Document observed median for SUMMARY consumption
    // eslint-disable-next-line no-console
    console.log(`[timeline-perf] sorted 50 pins / 220 entries — median latency: ${median.toFixed(2)}ms; samples (sorted): ${latencies.map((l) => l.toFixed(1)).join(', ')}ms`);
    expect(median).toBeLessThan(50);
  }, 30_000);
});
