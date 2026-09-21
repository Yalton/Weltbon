import { Buffer } from 'node:buffer';
import { normalizeRemoteUrl } from './remote-url.js';
import { maxFileBytes } from '../media/limits.js';
import {
  SyncApplyRejectedError,
  SyncAuthError,
  SyncBlobUnavailableError,
  SyncIncompatibleError,
  SyncPaymentError,
  SyncQuotaError,
  SyncRemoteOwnershipError,
  SyncRunError,
  SyncSelfRemoteError,
  SyncUnreachableError,
  type InstanceIdentityLike,
  type RemoteApplyDetail,
} from './run-errors.js';
import type { ManifestRow, SyncManifest } from './manifest.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RemoteClientOptions {
  baseUrl: string;
  pat: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxJsonBytes?: number;
}

const MISSING_BATCH = 5000;

const MAX_UNIVERSES = 1000;

const HASH_RE = /^[0-9a-f]{64}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function syncRequestTimeoutMs(): number {
  const v = Number(process.env.SYNC_REQUEST_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

export function syncMaxJsonBytes(): number {
  const v = Number(process.env.SYNC_MAX_JSON_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 64 * 1024 * 1024;
}

export interface ApplyBody {
  weltbonVersion: string;
  universe: ManifestRow | null;
  ops: Record<string, { upserts: ManifestRow[]; deletes: string[] }>;
}

export interface RemoteApplyResult {
  upserted: Record<string, number>;
  deleted: Record<string, number>;
  materializedAssets: number;
  sweptAssets?: number;
}

function sanitizeApplyDetail(body: unknown): RemoteApplyDetail {
  const out: RemoteApplyDetail = {};
  if (typeof body !== 'object' || body === null) return out;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.missingAssetHashes)) {
    const hashes = b.missingAssetHashes.filter((h): h is string => typeof h === 'string' && HASH_RE.test(h));
    if (hashes.length > 0) out.missingAssetHashes = hashes;
  }
  if (Array.isArray(b.collisions)) {

    const cols = b.collisions
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({ collection: String(c.collection ?? ''), count: Number(c.count ?? 0) }))
      .filter((c) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c.collection) && Number.isFinite(c.count));
    if (cols.length > 0) out.collisions = cols;
  }
  return out;
}

function sanitizeIdentity(body: unknown): InstanceIdentityLike | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const pattern = /^[A-Za-z0-9._-]{1,64}$/;
  const { instanceId, weltbonVersion, appVersion, migrationHead } = b;
  if (
    typeof instanceId !== 'string' ||
    typeof weltbonVersion !== 'string' ||
    typeof appVersion !== 'string' ||
    typeof migrationHead !== 'string' ||
    !UUID_RE.test(instanceId) ||
    !pattern.test(weltbonVersion) ||
    !pattern.test(appVersion) ||
    !pattern.test(migrationHead)
  ) {
    return null;
  }
  return { instanceId, weltbonVersion, appVersion, migrationHead };
}

export class SyncRemoteClient {
  private readonly base: string;
  private readonly pat: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxJsonBytes: number;

  constructor(opts: RemoteClientOptions) {
    this.base = normalizeRemoteUrl(opts.baseUrl);
    this.pat = opts.pat;
    this.doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? syncRequestTimeoutMs();
    this.maxJsonBytes = opts.maxJsonBytes ?? syncMaxJsonBytes();
  }

  private url(path: string): string {
    return `${this.base}/api/sync${path}`;
  }

  private async send(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      const callerHeaders = { ...(init.headers as Record<string, string> | undefined) };
      for (const key of Object.keys(callerHeaders)) {
        if (key.toLowerCase() === 'authorization') delete callerHeaders[key];
      }
      res = await this.doFetch(this.url(path), {
        ...init,
        method,
      // Never follow redirects: that could replay this peer's PAT to another host.
      redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...callerHeaders, Authorization: `Bearer ${this.pat}` },
      });
    } catch (err) {
      throw new SyncUnreachableError(`${method} ${path} (${(err as Error).name})`, err);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new SyncUnreachableError(`${method} ${path} responded with a redirect (${res.status})`);
    }
    if (res.status === 401) throw new SyncAuthError();
    // A universe-path 403 may be an ownership collision; other 403s reject this credential.
    if (res.status === 403) {
      throw /^\/universes\/[^/]+\//.test(path)
        ? new SyncRemoteOwnershipError()
        : new SyncAuthError();
    }
    if (res.status === 402) throw new SyncPaymentError();
    if (res.status === 413) throw new SyncQuotaError();
    return res;
  }

  private async readCapped(res: Response, cap: number, what: string): Promise<Buffer> {
    try {
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > cap) {
        throw new SyncUnreachableError(`${what} response too large (${declared} > ${cap} bytes)`);
      }
      const reader = res.body?.getReader();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > cap) throw new SyncUnreachableError(`${what} response too large (> ${cap} bytes)`);
        return buf;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel();
          throw new SyncUnreachableError(`${what} response exceeded ${cap} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof SyncRunError) throw err;
      throw new SyncUnreachableError(`${what} body read failed (${(err as Error)?.name ?? 'Error'})`, err);
    }
  }

  private async readJson(res: Response, what: string): Promise<unknown> {
    const buf = await this.readCapped(res, this.maxJsonBytes, what);
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new SyncUnreachableError(`${what} returned a non-JSON body`);
    }
  }

  async handshake(local: InstanceIdentityLike): Promise<InstanceIdentityLike> {
    const res = await this.send('POST', '/handshake', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: local.instanceId,
        weltbonVersion: local.weltbonVersion,
        migrationHead: local.migrationHead,
      }),
    });
    const body = (await this.readJson(res, 'handshake')) as Record<string, unknown>;
    if (res.status === 409) {
      throw new SyncIncompatibleError(local, sanitizeIdentity(body.remote));
    }
    if (res.status !== 200) throw new SyncUnreachableError(`handshake returned ${res.status}`);
    const remote = sanitizeIdentity(body.remote);
    if (!remote) throw new SyncUnreachableError('handshake returned a malformed identity');
    if (remote.instanceId === local.instanceId) throw new SyncSelfRemoteError();
    return remote;
  }

  async snapshot(uid: string): Promise<SyncManifest | null> {
    const res = await this.send('GET', `/universes/${uid}/snapshot`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new SyncUnreachableError(`snapshot returned ${res.status}`);
    return (await this.readJson(res, 'snapshot')) as SyncManifest;
  }

  async fingerprint(uid: string): Promise<string | null> {
    const res = await this.send('GET', `/universes/${uid}/fingerprint`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new SyncUnreachableError(`fingerprint returned ${res.status}`);
    const body = (await this.readJson(res, 'fingerprint')) as { fingerprint?: unknown };
    const fp = body.fingerprint;
    if (typeof fp !== 'string' || fp === '') {
      throw new SyncUnreachableError('remote returned no usable fingerprint');
    }
    return fp;
  }

  async listUniverses(): Promise<ManifestRow[]> {
    const res = await this.send('GET', '/universes');
    if (res.status !== 200) throw new SyncUnreachableError(`universes returned ${res.status}`);
    const body = (await this.readJson(res, 'universes')) as { universes?: unknown };
    if (!Array.isArray(body.universes)) return [];
    const rows = body.universes.filter((u): u is ManifestRow => {
      if (typeof u !== 'object' || u === null) return false;
      const row = u as Record<string, unknown>;
      return typeof row.id === 'string' && UUID_RE.test(row.id) && typeof row.name === 'string';
    });
    if (rows.length > MAX_UNIVERSES) {
      console.warn(`[sync] listUniverses: peer returned ${rows.length} universes, capping at ${MAX_UNIVERSES}`);
      return rows.slice(0, MAX_UNIVERSES);
    }
    return rows;
  }

  async missingAssets(uid: string, hashes: string[]): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < hashes.length; i += MISSING_BATCH) {
      const batch = hashes.slice(i, i + MISSING_BATCH);
      const res = await this.send('POST', `/universes/${uid}/assets/missing`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: batch }),
      });
      if (res.status !== 200) throw new SyncUnreachableError(`assets/missing returned ${res.status}`);
      const body = (await this.readJson(res, 'assets/missing')) as { missing?: unknown };

      if (Array.isArray(body.missing)) {
      // Peer values become storage keys, so accept only canonical content hashes.
        out.push(...body.missing.filter((h): h is string => typeof h === 'string' && HASH_RE.test(h)));
      }
    }
    return out;
  }

  async getBlob(uid: string, hash: string): Promise<Buffer> {
    const res = await this.send('GET', `/universes/${uid}/assets/${hash}`);
    if (res.status === 404) throw new SyncBlobUnavailableError([hash], 'remote');
    if (res.status !== 200) throw new SyncUnreachableError(`blob GET returned ${res.status}`);
    return this.readCapped(res, maxFileBytes(), 'blob');
  }

  async putBlob(uid: string, hash: string, bytes: Buffer): Promise<void> {
    const res = await this.send('PUT', `/universes/${uid}/assets/${hash}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (res.status !== 201) throw new SyncUnreachableError(`blob PUT returned ${res.status}`);
  }

  async apply(uid: string, body: ApplyBody): Promise<RemoteApplyResult> {
    const res = await this.send('POST', `/universes/${uid}/apply`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = await this.readJson(res, 'apply');
    if (res.status === 200) return parsed as RemoteApplyResult;
    throw new SyncApplyRejectedError(res.status, sanitizeApplyDetail(parsed));
  }
}
