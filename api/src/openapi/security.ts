/**
 * OpenAPI security scheme definitions.
 *
 * D-04/D-05 from Phase 10 CONTEXT.md: dual security schemes.
 *  - bearerAuth  — PAT + JWT; used by all parity routes (entries, universes, etc.)
 *  - bearerJwtAuth — JWT-only; used by PAT meta-API routes (/api/auth/tokens)
 */

export const bearerAuthScheme = {
  type: 'http',
  scheme: 'bearer',
  description:
    'Accepts either a JWT access token or a Personal Access Token in the form Authorization: Bearer <token>. Both are validated by the same requireAuth middleware (Phase 9). PATs match the format wbn_pat_<43-char-base64url>; JWTs are jose-signed.',
} as const;

export const bearerJwtAuthScheme = {
  type: 'http',
  scheme: 'bearer',
  description:
    'JWT-only bearer token. Personal Access Tokens are explicitly rejected by this endpoint (D-13: PAT cannot mint or revoke other PATs). Use POST /api/auth/tokens with a JWT to obtain a PAT.',
} as const;
