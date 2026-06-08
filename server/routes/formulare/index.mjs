/**
 * DocFlowAI — server/routes/formulare/index.mjs
 *
 * Orchestrator pentru rutele de formulare (DF + ORD + shared).
 * Split mecanic din formulare-db.mjs (Etapa 2). Modelul: server/routes/flows/index.mjs.
 * Numele de export PĂSTRAT identic: formulareDbRouter.
 */

import { Router } from 'express';
import dfRoutes from './df.mjs';
import ordRoutes from './ord.mjs';
import sharedRoutes from './shared.mjs';

const router = Router();
router.use(dfRoutes);
router.use(ordRoutes);
router.use(sharedRoutes);

export { router as formulareDbRouter };
