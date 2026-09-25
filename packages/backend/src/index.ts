/**
 * HTTP server bootstrap.
 *
 * The service exists to review pull requests, so it serves exactly what that
 * needs: the GitHub webhook, the endpoints to list and trigger reviews, and
 * the recordings a review's comment links to.
 */
import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { createLogger } from './util/logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { errorHandler, requestLogger } from './api/middleware.js';
import { artifactsRouter } from './api/routes/artifacts.js';
import { projectsRouter } from './api/routes/projects.js';
import { statusRouter } from './api/routes/status.js';
import { githubWebhookRouter, pullRequestsRouter } from './api/routes/github.js';

const log = createLogger('server');

async function main(): Promise<void> {
  await runMigrations();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  // Before the JSON parser: webhook signatures are verified over the raw body.
  app.use('/api/github', githubWebhookRouter);
  app.use(express.json({ limit: '4mb' }));
  app.use(requestLogger());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use('/api/artifacts', artifactsRouter);
  app.use('/api/system', statusRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', pullRequestsRouter);

  app.use((_req, res) => { res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }); });
  app.use(errorHandler());

  const server = app.listen(env.PORT, () => {
    log.info(`API listening on http://localhost:${env.PORT}`);
    log.info(`AI provider: ${env.AI_DISABLED ? 'disabled' : env.AI_PROVIDER}. Database: ${env.DATABASE_URL.split(':')[0]}.`);
  });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down.`);
    server.close(() => { void closeDb().then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('Failed to start the server.', e);
  process.exit(1);
});
