/**
 * server/routes/trasabilitate.mjs
 * Endpoint pentru arborele de trasabilitate DF ↔ ALOP ↔ ORD.
 * Mount: app.use('/api/trasabilitate', trasabilitateRouter)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { logger }      from '../middleware/logger.mjs';
import { pool }        from '../db/index.mjs';
import { getTrasabilitate } from '../services/trasabilitate.mjs';

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/trasabilitate/:type/:id
router.get('/:type/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    // No-cache pe API per CLAUDE.md convention
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const { type, id } = req.params;
    if (type !== 'df' && type !== 'ord') {
      return res.status(400).json({ error: 'invalid_type', message: 'type trebuie să fie df sau ord' });
    }
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'invalid_id', message: 'id trebuie să fie UUID valid' });
    }

    const result = await getTrasabilitate(pool, orgId, type, id);
    if (!result) return res.status(404).json({ error: 'not_found' });
    return res.json(result);
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'trasabilitate aggregate error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
