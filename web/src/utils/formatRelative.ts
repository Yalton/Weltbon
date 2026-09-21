export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const deltaMs = Math.max(0, now.getTime() - then);
  const sec = Math.floor(deltaMs / 1000);

  if (sec < 60) return 'Just now';

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;

  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} ${day === 1 ? 'day' : 'days'} ago`;

  const wk = Math.floor(day / 7);
  if (day < 30) return `${wk} ${wk === 1 ? 'week' : 'weeks'} ago`;

  const mo = Math.floor(day / 30);
  if (day < 365) return `${mo} ${mo === 1 ? 'month' : 'months'} ago`;

  const yr = Math.floor(day / 365);
  return `${yr} ${yr === 1 ? 'year' : 'years'} ago`;
}
