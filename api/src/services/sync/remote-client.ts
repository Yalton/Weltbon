/**
 * Plan D: the outbound half of the sync protocol — the ONLY place in the API
 * that calls fetch.
 *
 * Every method targets one of Plan C's six routes and converts what the peer
 * says into a typed SyncRunError, so no caller ever branches on a status code.
 *
 * D-05: `fetchImpl` is injectable, and that is load-bearing rather than a
 * convenience. In the two-instance integration test the peer is a Hono app
 * object, not a listening socket; without this seam the drive loop could not be
 * exercised against a real peer in-process and the acceptance proof would
 * degrade to a unit test of a function that never talks to anything.
 */
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
  SyncRunError,
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

/** Plan C's missing-assets route caps the array at 5000 (routes/sync.ts:179). */
const MISSING_BATCH = 5000;

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
}

/**
 * Keep ONLY the two fields Plan C's route contractually sanitizes (C-21).
 * Everything else in a peer's error body is dropped rather than trusted.
 */
function sanitizeApplyDetail(body: unknown): RemoteApplyDetail {
  const out: RemoteApplyDetail = {};
  if (typeof body !== 'object' || body === null) return out;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.missingAssetHashes)) {
    const hashes = b.missingAssetHashes.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
    if (hashes.length > 0) out.missingAssetHashes = hashes;
  }
  if (Array.isArray(b.collisions)) {
    // A bounded PATTERN, not an allowlist of manifest.ts's known collections:
    // Plan C's C-17 already emits a label (`issue_entries`) that is not a
    // manifest collection, so an enum would silently discard a legitimate
    // diagnostic the day another such label is added. The pattern bounds the
    // risk fully (charset + length) without coupling this module to a list
    // that is not authoritative for this field.
    const cols = b.collisions
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({ collection: String(c.collection ?? ''), count: Number(c.count ?? 0) }))
      .filter((c) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c.collection) && Number.isFinite(c.count));
    if (cols.length > 0) out.collisions = cols;
  }
  return out;
}

/**
 * The handshake 409 body is a peer's own construction and, unlike apply's
 * fields, was never given a defined shape by anything on our side — a bare
 * cast here is exactly C-21's mistake one path over. Require all three
 * identity fields to be strings matching a bounded pattern (this codebase's
 * real values look like `2.2.0` or `0035_sync_conflict_row_id_text`); if ANY
 * field fails, return null rather than partially repair it — an identity you
 * cannot trust is one you do not have. The caller's null path already exists
 * and SyncIncompatibleError already renders `?` for a missing remote.
 */
function sanitizeIdentity(body: unknown): InstanceIdentityLike | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const pattern = /^[A-Za-z0-9._-]{1,64}$/;
  const { weltbonVersion, appVersion, migrationHead } = b;
  if (
    typeof weltbonVersion !== 'string' ||
    typeof appVersion !== 'string' ||
    typeof migrationHead !== 'string' ||
    !pattern.test(weltbonVersion) ||
    !pattern.test(appVersion) ||
    !pattern.test(migrationHead)
  ) {
    return null;
  }
  return { weltbonVersion, appVersion, migrationHead };
}

export class SyncRemoteClient {
  private readonly base: string;
  private readonly pat: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxJsonBytes: number;

  constructor(opts: RemoteClientOptions) {
    // Re-validated here, not just at CRUD time: a row edited by hand, or a
    // policy flag flipped after the row was stored, must not be dialed.
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
      // HTTP header names are case-insensitive, but plain-object keys are not:
      // a caller-supplied `authorization` (lowercase) would otherwise survive
      // this spread as a distinct own-property alongside `Authorization`, and
      // Node's `Headers` constructor append-joins same-name-different-case
      // entries from a plain object into a corrupted comma-separated value
      // instead of letting either one win. Strip any case-variant of the key
      // first so the PAT set below is the only credential that can go out.
      const callerHeaders = { ...(init.headers as Record<string, string> | undefined) };
      for (const key of Object.keys(callerHeaders)) {
        if (key.toLowerCase() === 'authorization') delete callerHeaders[key];
      }
      res = await this.doFetch(this.url(path), {
        ...init,
        method,
        // A redirect is precisely how an allowed host pivots to a blocked one,
        // and it would also replay the Authorization header at the new target.
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
    if (res.status === 401 || res.status === 403) throw new SyncAuthError();
    if (res.status === 402) throw new SyncPaymentError();
    if (res.status === 413) throw new SyncQuotaError();
    return res;
  }

  /**
   * Read a body with a hard byte ceiling, streaming so an oversize reply is
   * cut off early. Wrapped in its own try/catch — send()'s try only covers
   * the fetch() call itself, but a connection dropped mid-stream, or the
   * AbortSignal firing DURING this read rather than before fetch() even
   * returns, throws from inside arrayBuffer()/reader.read() too. Without this,
   * that failure would escape untyped and surface as an opaque 500 instead of
   * the typed 502 this module promises every caller (no caller outside this
   * file branches on transport failures).
   */
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
      // The cap-violation throws above are already a SyncUnreachableError —
      // pass them through unchanged. Anything else here is a genuine transport
      // failure DURING the read; classify it the same as send()'s own fetch()
      // catch. safeDetail is built from `what` (the method/path this client
      // itself composed) — NEVER from whatever partial bytes were read, which
      // could be anything a peer sent.
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

  /**
   * S-08 compatibility gate. Returns the peer's identity; throws SyncIncompatibleError
   * on 409. `remote` is sanitized on BOTH branches, not just the error path: Task 7's
   * testRemote() serializes a successful handshake's `remote` straight into an HTTP
   * response body the web UI renders, so an unvalidated 200 is just as exposed as an
   * unvalidated 409 (D-16). A peer that cannot state a well-formed identity on the
   * success path is not one we can safely hand to a caller — this throws rather than
   * inventing placeholder values or returning a partial object.
   */
  async handshake(local: InstanceIdentityLike): Promise<InstanceIdentityLike> {
    const res = await this.send('POST', '/handshake', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weltbonVersion: local.weltbonVersion, migrationHead: local.migrationHead }),
    });
    const body = (await this.readJson(res, 'handshake')) as Record<string, unknown>;
    if (res.status === 409) {
      throw new SyncIncompatibleError(local, sanitizeIdentity(body.remote));
    }
    if (res.status !== 200) throw new SyncUnreachableError(`handshake returned ${res.status}`);
    const remote = sanitizeIdentity(body.remote);
    if (!remote) throw new SyncUnreachableError('handshake returned a malformed identity');
    return remote;
  }

  /** Null means the peer has never seen this universe — the caller decides what that means (D-07). */
  async snapshot(uid: string): Promise<SyncManifest | null> {
    const res = await this.send('GET', `/universes/${uid}/snapshot`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new SyncUnreachableError(`snapshot returned ${res.status}`);
    return (await this.readJson(res, 'snapshot')) as SyncManifest;
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
      const body = (await this.readJson(res, 'assets/missing')) as { missing?: string[] };
      out.push(...(body.missing ?? []));
    }
    return out;
  }

  /** Bounded by the SAME per-file cap the upload path uses — a peer is not privileged. */
  async getBlob(uid: string, hash: string): Promise<Buffer> {
    const res = await this.send('GET', `/universes/${uid}/assets/${hash}`);
    // E-08: a 404 is not a transport failure. The peer answered, and its answer
    // was "I do not have these bytes" — reporting that as remote-unreachable
    // (502) sends an operator to debug their network over a missing file.
    // reconcile.ts's single probe means the happy path never GETs a hash the
    // peer has already reported missing, so reaching this branch means the peer
    // deleted the blob between the probe and this call: a genuine race, which is
    // exactly what SyncBlobUnavailableError (409, code `blob-unavailable`) names.
    if (res.status === 404) throw new SyncBlobUnavailableError([hash]);
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
