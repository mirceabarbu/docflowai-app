/**
 * DocFlowAI — Admin routes hub v4.0
 *
 * Istoric refactor 4b:
 *  • 4b.1 — users + gws          → admin/users.mjs
 *  • 4b.2 — organizations+signing → admin/organizations.mjs
 *  • 4b.3 — flows (archive,clean,list,audit) → admin/flows.mjs
 *  • 4b.4 — analytics+stats+user-activity   → admin/analytics.mjs
 *  • 4b.5 — audit events + maintenance      → admin/audit.mjs + admin/maintenance.mjs
 *
 * admin.mjs este acum un ORCHESTRATOR: mount-ează sub-routerele +
 * expune injectWsSize (re-export din maintenance.mjs).
 */

import { Router } from 'express';

import usersRouter from './admin/users.mjs';
import organizationsRouter from './admin/organizations.mjs';
import flowsRouter from './admin/flows.mjs';
import analyticsRouter from './admin/analytics.mjs';
import auditRouter from './admin/audit.mjs';
import maintenanceRouter, { injectWsSize } from './admin/maintenance.mjs';

const router = Router();

// Sub-routere admin — ordine relevantă doar dacă ar avea conflicte
// de path, ceea ce nu e cazul
router.use(usersRouter);
router.use(organizationsRouter);
router.use(flowsRouter);
router.use(analyticsRouter);
router.use(auditRouter);
router.use(maintenanceRouter);

export { injectWsSize };
export default router;
