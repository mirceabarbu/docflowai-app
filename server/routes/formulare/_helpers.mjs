/**
 * DocFlowAI — server/routes/formulare/_helpers.mjs
 *
 * Helpere file-local partajate de df.mjs / ord.mjs / shared.mjs.
 * Mutate verbatim din formulare-db.mjs (split mecanic Etapa 2).
 */

import { pool } from '../../db/index.mjs';

export function requireDb(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return true; }
  return false;
}
