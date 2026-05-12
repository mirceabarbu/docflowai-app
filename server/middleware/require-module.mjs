/**
 * DocFlowAI — requireModule middleware (PASUL 2)
 *
 * Gardă pe endpoint-uri sensibile pe modul: blochează utilizatorii pentru care
 * modulul nu este activat (entitlement off). Superadmin global (role='admin')
 * trece întotdeauna, indiferent de org_id — aliniat cu restul aplicației
 * (vezi server/routes/admin/_helpers.mjs: "admin vede totul").
 *
 * Folosire:
 *   router.post('/api/refnec', requireAuth, csrfMiddleware, requireModule('refnec'), handler);
 *
 * IMPORTANT: trebuie montat DUPĂ requireAuth (folosește req.actor).
 */

import { pool } from '../db/index.mjs';
import { isModuleEnabled } from '../services/entitlements.mjs';
import { getOptionalActor } from './auth.mjs';

export function requireModule(moduleKey) {
  if (!moduleKey || typeof moduleKey !== 'string') {
    throw new Error('requireModule: moduleKey lipsă');
  }
  return async (req, res, next) => {
    // Fie req.actor e setat (pattern middleware-mode requireAuth), fie îl
    // recuperăm singuri din JWT (pattern helper-mode — auth se face în handler).
    let actor = req.actor;
    if (!actor) {
      actor = getOptionalActor(req);
      if (actor) req.actor = actor;
    }
    if (!actor) return res.status(401).json({ error: 'unauthorized' });

    // Bypass superadmin global: role='admin' indiferent de org_id (pattern aplicație).
    if (actor.role === 'admin') return next();

    try {
      const enabled = await isModuleEnabled(pool, {
        moduleKey,
        userId: actor.userId,
        compartiment: actor.compartiment || null,
        orgId: actor.orgId ?? null,
      });
      if (!enabled) {
        return res.status(403).json({
          error: 'module_disabled',
          module: moduleKey,
          message: 'Modulul nu este activat pentru contul dvs. Contactați administratorul.',
        });
      }
      return next();
    } catch (_e) {
      // Fail-closed pe erori interne — preferăm refuz controlat decât bypass silențios.
      return res.status(503).json({ error: 'entitlements_unavailable' });
    }
  };
}

export default requireModule;
