import { describe, it, expect } from 'vitest';
import { formatRelative } from './formatRelative';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

describe('formatRelative', () => {
  it('returns "Just now" for delta < 60s', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 30 * SEC).toISOString();
    expect(formatRelative(iso, now)).toBe('Just now');
  });

  it('returns "Just now" for exactly 0 seconds', () => {
    const now = new Date();
    expect(formatRelative(now.toISOString(), now)).toBe('Just now');
  });

  it('returns "1 minute ago" for exactly 1 minute', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - MIN).toISOString();
    expect(formatRelative(iso, now)).toBe('1 minute ago');
  });

  it('returns "5 minutes ago" for 5 minutes', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 5 * MIN).toISOString();
    expect(formatRelative(iso, now)).toBe('5 minutes ago');
  });

  it('returns "1 hour ago" for exactly 1 hour', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - HOUR).toISOString();
    expect(formatRelative(iso, now)).toBe('1 hour ago');
  });

  it('returns "3 hours ago" for 3 hours', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 3 * HOUR).toISOString();
    expect(formatRelative(iso, now)).toBe('3 hours ago');
  });

  it('returns "1 day ago" for exactly 1 day', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - DAY).toISOString();
    expect(formatRelative(iso, now)).toBe('1 day ago');
  });

  it('returns "3 days ago" for 3 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 3 * DAY).toISOString();
    expect(formatRelative(iso, now)).toBe('3 days ago');
  });

  it('returns "1 week ago" for exactly 7 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - WEEK).toISOString();
    expect(formatRelative(iso, now)).toBe('1 week ago');
  });

  it('returns "2 weeks ago" for 14 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 14 * DAY).toISOString();
    expect(formatRelative(iso, now)).toBe('2 weeks ago');
  });

  it('returns "1 month ago" for exactly 30 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - MONTH).toISOString();
    expect(formatRelative(iso, now)).toBe('1 month ago');
  });

  it('returns "3 months ago" for 90 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 3 * MONTH).toISOString();
    expect(formatRelative(iso, now)).toBe('3 months ago');
  });

  it('returns "1 year ago" for exactly 365 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - YEAR).toISOString();
    expect(formatRelative(iso, now)).toBe('1 year ago');
  });

  it('returns "2 years ago" for 730 days', () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 2 * YEAR).toISOString();
    expect(formatRelative(iso, now)).toBe('2 years ago');
  });

  it('returns "Just now" for future dates (defensive case)', () => {
    const now = new Date();
    const iso = new Date(now.getTime() + HOUR).toISOString();
    expect(formatRelative(iso, now)).toBe('Just now');
  });
});
