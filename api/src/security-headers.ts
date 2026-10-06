import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;
type CspDirectives = NonNullable<SecureHeadersOptions['contentSecurityPolicy']>;

/**
 * Policy for the app and every API response. Scripts come only from the app's
 * own build (web/index.html carries no inline script). Inline styles are
 * allowed because components and the editor set style attributes. Images may
 * come from anywhere, since entries embed pictures by URL, and exports hand
 * the browser blob: and data: URLs.
 */
const APP_CSP: CspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
};

/**
 * /api/docs renders the Scalar API reference, which loads from jsdelivr and
 * pulls its fonts from fonts.scalar.com (api/src/openapi/scalar.ts). The
 * browser still logs one blocked eval there: the zod copy bundled in Scalar
 * probes for Function() and falls back to its slower parser when refused.
 */
const DOCS_CSP: CspDirectives = {
  ...APP_CSP,
  scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.scalar.com'],
  fontSrc: ["'self'", 'data:', 'https://fonts.scalar.com'],
};

// The cross-origin isolation headers stay off: they would block shares, map
// tiles and assets loaded by other origins. HSTS belongs on the TLS proxy.
const BASE: SecureHeadersOptions = {
  xFrameOptions: 'SAMEORIGIN',
  referrerPolicy: 'strict-origin-when-cross-origin',
  strictTransportSecurity: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
};

const appHeaders = secureHeaders({ ...BASE, contentSecurityPolicy: APP_CSP });
const docsHeaders = secureHeaders({ ...BASE, contentSecurityPolicy: DOCS_CSP });

/** Hardening headers for every response; tested in tests/security-headers.test.ts. */
export const securityHeaders: MiddlewareHandler = (c, next) =>
  c.req.path === '/api/docs' ? docsHeaders(c, next) : appHeaders(c, next);
