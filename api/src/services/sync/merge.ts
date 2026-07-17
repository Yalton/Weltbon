/**
 * Plan B (Task 4): the row-level three-way merge core (sync spec S-01..S-05).
 *
 * Pure functions — no DB, no clock (no Date.now), no Math.random. Given base,
 * local and remote snapshots of ONE collection, produce the converged state,
 * the operations each side must apply to reach it, and the conflict records.
 *
 * Determinism (B-08): every output array is sorted by row key. LWW ties break
 * toward REMOTE (B-03) — arbitrary but symmetric, so A→B and B→A converge.
 */
import {
  NON_CONTENT_FIELDS,
  UNORDERED_ARRAY_FIELDS,
  type CollectionDescriptor,
  type ManifestRow,
} from './manifest.js';

export interface CollectionMergeResult {
  merged: ManifestRow[];
  localOps: { upserts: ManifestRow[]; deletes: string[] };
  remoteOps: { upserts: ManifestRow[]; deletes: string[] };
  conflicts: RowConflict[];
}

export interface RowConflict {
  collection: string;
  key: string;
  winner: 'local' | 'remote';
  winnerRow: ManifestRow;
  loserRow: ManifestRow;
  reason: 'both-changed' | 'change-vs-delete' | 'both-created' | 'natural-key';
}

// --- deep equality --------------------------------------------------------

/**
 * Structural deep equality with two deliberate choices:
 *  - null vs undefined are treated STRICTLY (not equal). The manifest always
 *    emits explicit nulls (json.ts), so a null-vs-absent mismatch signals real
 *    drift rather than a serialization artifact; being strict surfaces it
 *    instead of silently swallowing it.
 *  - arrays are order-SENSITIVE here; the order-insensitive fields (B-02) are
 *    normalized by contentEqual BEFORE this is reached.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true; // handles identical primitives, both-null, both-undefined
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Sort a copy of an array of scalars for order-insensitive comparison (B-02). */
function sortedCopy(arr: unknown[]): unknown[] {
  return [...arr].sort((x, y) => {
    const sx = String(x);
    const sy = String(y);
    return sx < sy ? -1 : sx > sy ? 1 : 0;
  });
}

/**
 * Content equality for change detection (B-02): compares every field EXCEPT
 * NON_CONTENT_FIELDS (updatedAt/createdAt — a pure touch is NOT a change).
 * UNORDERED_ARRAY_FIELDS (entryIds) compare as sorted copies; all other arrays
 * are order-sensitive; nested objects deep-equal.
 */
export function contentEqual(a: ManifestRow, b: ManifestRow): boolean {
  const keys = new Set<string>();
  for (const k of Object.keys(a)) if (!NON_CONTENT_FIELDS.has(k)) keys.add(k);
  for (const k of Object.keys(b)) if (!NON_CONTENT_FIELDS.has(k)) keys.add(k);

  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (UNORDERED_ARRAY_FIELDS.has(k) && Array.isArray(av) && Array.isArray(bv)) {
      if (!deepEqual(sortedCopy(av), sortedCopy(bv))) return false;
    } else if (!deepEqual(av, bv)) {
      return false;
    }
  }
  return true;
}

// --- LWW ------------------------------------------------------------------

function epoch(row: ManifestRow): number {
  const e = Date.parse(String(row.updatedAt));
  return Number.isNaN(e) ? 0 : e;
}

/** LWW winner by parsed updatedAt epoch; ties break toward remote (B-03). */
function pickWinner(local: ManifestRow, remote: ManifestRow): 'local' | 'remote' {
  const le = epoch(local);
  const re = epoch(remote);
  if (le > re) return 'local';
  if (re > le) return 'remote';
  return 'remote'; // tie → remote (B-03)
}

// --- the merge ------------------------------------------------------------

function index(rows: ManifestRow[], desc: CollectionDescriptor): Map<string, ManifestRow> {
  const m = new Map<string, ManifestRow>();
  for (const row of rows) m.set(desc.key(row), row);
  return m;
}

/** diff(side → merged) as upserts/deletes (B-07), sorted by key (B-08). */
function deriveOps(
  sideMap: Map<string, ManifestRow>,
  merged: Map<string, ManifestRow>,
  desc: CollectionDescriptor,
): { upserts: ManifestRow[]; deletes: string[] } {
  const upserts: ManifestRow[] = [];
  const deletes: string[] = [];

  for (const [key, mergedRow] of merged) {
    const sideRow = sideMap.get(key);
    // contentEqual (not deepEqual): a touch-only updatedAt delta is NOT an op (B-02).
    if (!sideRow || !contentEqual(sideRow, mergedRow)) upserts.push(mergedRow);
  }
  for (const key of sideMap.keys()) {
    if (!merged.has(key)) deletes.push(key);
  }

  upserts.sort((a, b) => (desc.key(a) < desc.key(b) ? -1 : desc.key(a) > desc.key(b) ? 1 : 0));
  deletes.sort();
  return { upserts, deletes };
}

export function mergeCollection(
  desc: CollectionDescriptor,
  base: ManifestRow[] | undefined,
  local: ManifestRow[],
  remote: ManifestRow[],
): CollectionMergeResult {
  const baseMap = index(base ?? [], desc);
  const localMap = index(local, desc);
  const remoteMap = index(remote, desc);

  const merged = new Map<string, ManifestRow>();
  const conflicts: RowConflict[] = [];

  const keys = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  for (const key of keys) {
    const b = baseMap.get(key);
    const l = localMap.get(key);
    const r = remoteMap.get(key);

    if (b === undefined) {
      // --- created scenarios (base lacks the row) ---
      if (l && r) {
        // created/created, same id (B-04)
        if (contentEqual(l, r)) {
          merged.set(key, pickWinner(l, r) === 'local' ? l : r); // convergent create — no conflict
        } else {
          const w = pickWinner(l, r);
          const winnerRow = w === 'local' ? l : r;
          const loserRow = w === 'local' ? r : l;
          merged.set(key, winnerRow);
          conflicts.push({ collection: desc.name, key, winner: w, winnerRow, loserRow, reason: 'both-created' });
        }
      } else if (l) {
        merged.set(key, l);
      } else if (r) {
        merged.set(key, r);
      }
      continue;
    }

    // --- base has the row: classify each side vs base ---
    const lState = l === undefined ? 'deleted' : contentEqual(l, b) ? 'unchanged' : 'changed';
    const rState = r === undefined ? 'deleted' : contentEqual(r, b) ? 'unchanged' : 'changed';

    if (lState === 'deleted' && rState === 'deleted') {
      // both deleted → gone, no conflict
    } else if (lState === 'unchanged' && rState === 'unchanged') {
      merged.set(key, l as ManifestRow); // identical content; pick local deterministically
    } else if (lState === 'changed' && rState === 'unchanged') {
      merged.set(key, l as ManifestRow); // changed beats unchanged regardless of updatedAt
    } else if (lState === 'unchanged' && rState === 'changed') {
      merged.set(key, r as ManifestRow);
    } else if (lState === 'deleted' && rState === 'unchanged') {
      // local's delete wins over an untouched remote → gone
    } else if (lState === 'unchanged' && rState === 'deleted') {
      // remote's delete wins over an untouched local → gone
    } else if (lState === 'changed' && rState === 'deleted') {
      // resurrect (S-04): the change beats the delete; loserRow = base (what the
      // deleter last saw — its delete was made against that state).
      const winnerRow = l as ManifestRow;
      merged.set(key, winnerRow);
      conflicts.push({ collection: desc.name, key, winner: 'local', winnerRow, loserRow: b, reason: 'change-vs-delete' });
    } else if (lState === 'deleted' && rState === 'changed') {
      const winnerRow = r as ManifestRow;
      merged.set(key, winnerRow);
      conflicts.push({ collection: desc.name, key, winner: 'remote', winnerRow, loserRow: b, reason: 'change-vs-delete' });
    } else {
      // changed / changed
      const lr = l as ManifestRow;
      const rr = r as ManifestRow;
      if (contentEqual(lr, rr)) {
        merged.set(key, pickWinner(lr, rr) === 'local' ? lr : rr); // convergent edit — no conflict (cell 5)
      } else {
        const w = pickWinner(lr, rr);
        const winnerRow = w === 'local' ? lr : rr;
        const loserRow = w === 'local' ? rr : lr;
        merged.set(key, winnerRow);
        conflicts.push({ collection: desc.name, key, winner: w, winnerRow, loserRow, reason: 'both-changed' });
      }
    }
  }

  // --- natural-key dedupe post-pass (B-05) ---
  // Runs over the would-be merged set. Only created-created rows with DIFFERENT
  // ids can collide here (same-key updates already share an id and merged as one
  // row above). Keep max-updatedAt (ties → remote); drop losers and record a
  // 'natural-key' conflict. The loser's ORIGIN side receives a delete for its own
  // row id — emitted MECHANICALLY by deriveOps once the loser leaves `merged`.
  if (desc.naturalKey) {
    const nk = desc.naturalKey;
    const groups = new Map<string, string[]>();
    for (const [rowKey, row] of merged) {
      const g = nk(row);
      const bucket = groups.get(g);
      if (bucket) bucket.push(rowKey);
      else groups.set(g, [rowKey]);
    }

    for (const rowKeys of groups.values()) {
      if (rowKeys.length <= 1) continue;

      const candidates = rowKeys.map((rk) => {
        const row = merged.get(rk) as ManifestRow;
        const inLocal = localMap.has(rk);
        const inRemote = remoteMap.has(rk);
        // Colliding rows come from exactly one side (different ids); prefer the
        // remote label when a row somehow exists on both (keeps ties → remote).
        const origin: 'local' | 'remote' = inRemote && !inLocal ? 'remote' : inLocal && !inRemote ? 'local' : inRemote ? 'remote' : 'local';
        return { rk, row, origin, e: epoch(row) };
      });

      // Winner: max epoch; ties → remote origin; final tiebreak by key (determinism).
      candidates.sort((a, c) => {
        if (a.e !== c.e) return c.e - a.e;
        if (a.origin !== c.origin) return a.origin === 'remote' ? -1 : 1;
        return a.rk < c.rk ? -1 : 1;
      });

      const winner = candidates[0];
      for (const loser of candidates.slice(1)) {
        merged.delete(loser.rk);
        conflicts.push({
          collection: desc.name,
          key: loser.rk,
          winner: winner.origin,
          winnerRow: winner.row,
          loserRow: loser.row,
          reason: 'natural-key',
        });
      }
    }
  }

  // --- derive ops + sort everything (B-07, B-08) ---
  const localOps = deriveOps(localMap, merged, desc);
  const remoteOps = deriveOps(remoteMap, merged, desc);

  const mergedRows = [...merged.values()].sort((a, b) =>
    desc.key(a) < desc.key(b) ? -1 : desc.key(a) > desc.key(b) ? 1 : 0,
  );
  conflicts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { merged: mergedRows, localOps, remoteOps, conflicts };
}
