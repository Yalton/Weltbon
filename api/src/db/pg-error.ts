
export interface PgErrorFields {
  code: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

const MAX_CAUSE_DEPTH = 5;

export function pgErrorOf(err: unknown): PgErrorFields | null {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (cur === null || typeof cur !== 'object') return null;
    const candidate = cur as {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        table: typeof candidate.table === 'string' ? candidate.table : undefined,
        detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
      };
    }
    cur = candidate.cause;
  }
  return null;
}

export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorOf(err)?.code === PG_UNIQUE_VIOLATION;
}
