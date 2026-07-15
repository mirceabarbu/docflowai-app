/**
 * Construiește o aplicație Express cu routerele REALE de formulare/ALOP, peste DB real.
 * Mock-uim DOAR middleware-urile ortogonale (csrf, require-module, logger) — NU db.
 */
import { vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
  default: () => (_req, _res, next) => next(),
}));
vi.mock('../../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../../routes/formulare/index.mjs');
const alopRouter = (await import('../../../routes/alop.mjs')).default;
const flowsCrudRouter = (await import('../../../routes/flows/crud.mjs')).default;
const registraturaRouter = (await import('../../../routes/registratura.mjs')).default;

export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  app.use('/', alopRouter);
  app.use('/', flowsCrudRouter);
  app.use('/', registraturaRouter);
  return app;
}
