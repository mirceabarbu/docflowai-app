/**
 * server/app.mjs — Express application factory for DocFlowAI v4.0.
 *
 * Middleware stack, static files, API routes.
 * Does NOT call listen() — that's index.mjs's job.
 */

import express          from 'express';
import compression      from 'compression';
import helmet           from 'helmet';
import cors             from 'cors';
import cookieParser     from 'cookie-parser';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config             from './config.mjs';
import { requestLogger }  from './middleware/logger.mjs';
import { errorHandler }   from './middleware/errorHandler.mjs';
import flowsRouter, { injectFlowDeps } from './routes/flows/index.mjs';
import authApiRouter      from './modules/auth/routes.mjs';
import usersApiRouter     from './modules/users/routes.mjs';
import flowsModuleRouter  from './modules/flows/routes.mjs';
import { generateId }     from './core/ids.mjs';

const __dir    = dirname(fileURLToPath(import.meta.url));
const PUBLIC   = join(__dir, '..', 'public');

const app = express();

// ── Core middleware ───────────────────────────────────────────────────────────

app.use(compression());

app.use(helmet({
  contentSecurityPolicy:    false,   // managed per-route via cspNonce middleware
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin:      config.corsOrigin,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(requestLogger);

// ── Static assets ─────────────────────────────────────────────────────────────

app.use(express.static(PUBLIC, { maxAge: '1h' }));

// ── HTML page routes ──────────────────────────────────────────────────────────

const html = (file) => (_req, res) => res.sendFile(join(PUBLIC, file));

app.get('/',              html('semdoc-initiator.html'));
app.get('/login',         html('login.html'));
app.get('/admin',         html('admin.html'));
app.get('/verifica',      html('verifica.html'));
app.get('/templates',     html('templates.html'));
app.get('/notifications', html('notifications.html'));

// ── Health / status ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '4.0.0', uptime: process.uptime() });
});

app.get('/api/status', (_req, res) => {
  res.json({ db: 'connected', version: '4.0.0' });
});

// ── Inject flow dependencies ──────────────────────────────────────────────────
// Placeholders for services not yet built in v4. Each will be replaced
// by a real implementation as the relevant session completes.

const _noop   = async () => {};
const _noopFn = ()       => {};

injectFlowDeps({
  notify:               _noop,
  wsPush:               _noop,
  PDFLib:               await import('pdf-lib'),
  stampFooterOnPdf:     async (buf) => buf,
  isSignerTokenExpired: _noopFn,
  newFlowId:            generateId,
  buildSignerLink: (flowId, token) =>
    `${config.publicBaseUrl}/semdoc-signer.html?flow=${flowId}&token=${token}`,
  stripSensitive: (data) => data,
  stripPdfB64:    (data) => ({ ...data, pdfB64: undefined }),
  sendSignerEmail: _noop,
  fireWebhook:     _noop,
});

// ── v4 API modules ────────────────────────────────────────────────────────────

app.use('/api/auth',  authApiRouter);
app.use('/api/users', usersApiRouter);
app.use('/api/flows', flowsModuleRouter);

// ── Flow routes (STS zone — NO-TOUCH files mounted here) ─────────────────────

app.use('/', flowsRouter);

// ── Error handler (must be last) ──────────────────────────────────────────────

app.use(errorHandler);

export { app };
