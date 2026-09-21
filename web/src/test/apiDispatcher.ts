import { vi } from 'vitest';

export type ApiHandler = unknown | Error | ((path: string, init?: RequestInit) => unknown);

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
