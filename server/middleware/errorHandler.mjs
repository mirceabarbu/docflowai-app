/**
 * server/middleware/errorHandler.mjs — centralized Express error handler.
 *
 * Usage (mount LAST in Express app, after all routes):
 *   app.use(errorHandler);
 */

import { AppError } from '../core/errors.mjs';
import { logger } from './logger.mjs';
import config from '../config.mjs';

/**
 * Express 4-argument error handler.
 * - AppError subclasses → structured JSON with their statusCode/code/fields
 * - Unknown errors → 500 INTERNAL_ERROR (detail hidden in production)
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, method: req.method, url: req.originalUrl }, err.message);
    }

    const body = {
      error: {
        code: err.code,
        message: err.message,
      },
    };
    if (err.fields && Object.keys(err.fields).length > 0) {
      body.error.fields = err.fields;
    }

    return res.status(err.statusCode).json(body);
  }

  // Unknown / unexpected error
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isProd ? 'Eroare internă' : (err?.message || 'Eroare internă'),
    },
  });
}
