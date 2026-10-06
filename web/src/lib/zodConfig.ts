import { z } from 'zod';

// The server's Content-Security-Policy forbids eval (api/src/security-headers.ts).
// Zod compiles fast object parsers with Function() and probes for it when an
// object schema is created; jitless skips both. main.tsx imports this first so
// it runs before any module defines a schema.
z.config({ jitless: true });
