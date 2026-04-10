/**
 * server/index.mjs — DocFlowAI v4.0 entry point.
 */

import { createServer } from 'http';
import { bootstrap, shutdown } from './bootstrap.mjs';
import { app, injectWsPush }   from './app.mjs';
import config                  from './config.mjs';
import { logger }              from './middleware/logger.mjs';
import { createWsServer, sendToUser } from './services/ws.mjs';

bootstrap()
  .then(() => {
    const server = createServer(app);

    // ── WebSocket ─────────────────────────────────────────────────────────
    createWsServer(server);
    injectWsPush((userId, data) => sendToUser(userId, data));

    server.listen(config.port, () => {
      logger.info(`DocFlowAI v4.0 listening on port ${config.port}`);
    });

    const graceful = (signal) => {
      logger.info(`${signal} received.`);
      server.close(() => {
        shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
      });
    };

    process.on('SIGTERM', () => graceful('SIGTERM'));
    process.on('SIGINT',  () => graceful('SIGINT'));
  })
  .catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
