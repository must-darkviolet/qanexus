import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { redactSecrets } from '../analysis/secrets.js';

const log = createLogger('api');

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => { void fn(req, res, next).catch(next); };
}

export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`;
      if (res.statusCode >= 500) log.error(line);
      else if (res.statusCode >= 400) log.warn(line);
      else log.debug(line);
    });
    next();
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler() {
  return (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof AppError) {
      res.status(error.status).json({
        error: { code: error.code, message: redactSecrets(error.message), details: error.details },
      });
      return;
    }
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    log.error('Unhandled API error.', error);
    res.status(500).json({ error: { code: 'internal_error', message } });
  };
}
