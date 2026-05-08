/**
 * server/routes/clasa8.mjs
 * Endpoint pentru centralizatorul Clasa 8 (read-only, agregator).
 * Mount: app.use('/api/clasa8', clasa8Router)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { logger }      from '../middleware/logger.mjs';
import { pool }        from '../db/index.mjs';
import { getClasa8Aggregate } from '../services/clasa8.mjs';

const router = Router();

// GET /api/clasa8?ssi=&compartiment=&q=
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const filters = {
      ssi:          typeof req.query.ssi === 'string' ? req.query.ssi : '',
      compartiment: typeof req.query.compartiment === 'string' ? req.query.compartiment : '',
      q:            typeof req.query.q === 'string' ? req.query.q : '',
    };

    // Sanity limits — preveni abuzul (filtru prea lung blochează ILIKE)
    if (filters.ssi.length > 100)          return res.status(400).json({ error: 'ssi_too_long' });
    if (filters.compartiment.length > 200) return res.status(400).json({ error: 'compartiment_too_long' });
    if (filters.q.length > 200)            return res.status(400).json({ error: 'q_too_long' });

    const result = await getClasa8Aggregate(pool, orgId, filters);
    return res.json(result);
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 aggregate error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
