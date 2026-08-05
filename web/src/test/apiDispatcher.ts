/**
 * A path-routing mock for the `api()` client, shared by the sync UI's view and
 * component tests.
 *
 * PROMOTED TO A SHARED HELPER rather than copied a third time. Task 2 wrote it,
 * Task 3 copied it, and Task 4 would have copied it again — while the same
 * commit that introduced the second copy also introduced `syncKeys.ts`, whose
 * entire justification is that duplicated definitions drift silently. The two
 * copies had already begun to: this version carries fixes both should have had.
 *
 * Two details in here are load-bearing, and both are easy to lose in a rewrite:
 *
 *  1. WHICH KEY MATCHED IS RESOLVED BEFORE THE HANDLER IS INSPECTED. The
 *     obvious `if (handler === undefined) reject` cannot tell "no route
 *     registered" from "a registered route whose value is undefined", so it
 *     rejects every void-returning call — a test that models a 204 DELETE gets
 *     a failed mutation and a rendered error while appearing to model success.
 *  2. `Object.hasOwn`, not `in`. `in` also matches inherited Object.prototype
 *     members, so a request for `/constructor` would "match" a route table that
 *     never mentioned it.
 */
import { vi } from 'vitest';

/** A route's response: a value, an Error to reject with, or a function of the call. */
export type ApiHandler = unknown | Error | ((path: string, init?: RequestInit) => unknown);

/**
 * Route `api()` calls by `"<METHOD> <path>"`, falling back to bare `<path>`.
 *
 * An unrouted call REJECTS with the key it wanted rather than resolving
 * undefined — a silent undefined surfaces later as an unrelated render
 * assertion failing, with nothing pointing at the missing route.
 */
export function makeApiDispatcher(routes: Record<string, ApiHandler>) {
  return vi.fn((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${path}`;
    const matched = Object.hasOwn(routes, key) ? key : Object.hasOwn(routes, path) ? path : null;
    if (matched === null) {
      return Promise.reject(new Error(`Unhandled api() call: ${key}`));
    }
    const handler = routes[matched];
    if (handler instanceof Error) return Promise.reject(handler);
    if (typeof handler === 'function') {
      return Promise.resolve((handler as (p: string, i?: RequestInit) => unknown)(path, init));
    }
    return Promise.resolve(handler);
  });
}
