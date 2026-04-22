import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config.js';
import * as schema from './schema.js';

export let pool = new pg.Pool({ connectionString: env().databaseUrl });
export let db = drizzle(pool, { schema });
