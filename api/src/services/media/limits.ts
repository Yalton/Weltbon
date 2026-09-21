const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_UNIVERSE_QUOTA = 500 * 1024 * 1024;

export function maxFileBytes(): number {
  const n = Number(process.env.MEDIA_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

export function maxUniverseQuota(): number {
  const n = Number(process.env.MEDIA_UNIVERSE_QUOTA_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UNIVERSE_QUOTA;
}
