import { describe, it, expect } from 'vitest';
import { pgErrorOf, isUniqueViolation, PG_UNIQUE_VIOLATION } from '../src/db/pg-error.js';

/**
 * The shapes below are not invented: they are what `drizzle-orm@0.45.2` actually
 * produces, captured by provoking a real unique violation against
 * `pg@8` (DatabaseError) and `@electric-sql/pglite@0.5.4` (E), each inside a
 * transaction and outside one. If a Drizzle upgrade changes the nesting, the
 * "two levels deep" case below is the one that starts failing.
 */
describe('pgErrorOf', () => {
  it('reads the code off a bare driver error (no wrapper)', () => {
    const raw = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 't_pkey',
    });
    expect(pgErrorOf(raw)).toMatchObject({ code: '23505', constraint: 't_pkey' });
  });

  it('reads the code out of a DrizzleQueryError wrapper (the real shape)', () => {
    // What Drizzle 0.45 throws: query/params/cause, and NO code of its own.
    const wrapped = Object.assign(new Error('Failed query: insert into "users" ...'), {
      query: 'insert into "users" ...',
      params: [],
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'users_email_unique',
        table: 'users',
      }),
    });
    expect(pgErrorOf(wrapped)).toMatchObject({
      code: '23505',
      constraint: 'users_email_unique',
      table: 'users',
    });
  });

  it('keeps walking when a future wrapper nests deeper than one level', () => {
    const deep = { cause: { cause: { cause: { code: '23505' } } } };
    expect(pgErrorOf(deep)?.code).toBe('23505');
  });

  it('gives up rather than looping forever on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(pgErrorOf(a)).toBeNull();
  });

  it('returns null for anything that is not a driver error', () => {
    expect(pgErrorOf(new Error('plain'))).toBeNull();
    expect(pgErrorOf(null)).toBeNull();
    expect(pgErrorOf(undefined)).toBeNull();
    expect(pgErrorOf('23505')).toBeNull();
    expect(pgErrorOf({ code: 23505 })).toBeNull(); // numeric code is not PG's shape
  });
});

describe('isUniqueViolation', () => {
  it('is true for a wrapped 23505 — the case every call site cares about', () => {
    expect(isUniqueViolation({ cause: { code: PG_UNIQUE_VIOLATION } })).toBe(true);
  });

  it('is false for a different Postgres code, so callers still rethrow', () => {
    expect(isUniqueViolation({ cause: { code: '23503' } })).toBe(false); // FK violation
    expect(isUniqueViolation({ cause: { code: '40001' } })).toBe(false); // serialization
  });

  it('is false for a non-database error', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
