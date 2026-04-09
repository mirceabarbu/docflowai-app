/**
 * server/index.mjs — DocFlowAI v4.0 entry point.
 */

import { createServer } from 'http';
import { bootstrap, shutdown } from './bootstrap.mjs';
import { app }    from './app.mjs';
import config     from './config.mjs';
import { logger } from './middleware/logger.mjs';

bootstrap()
  .then(() => {
    const server = createServer(app);

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
