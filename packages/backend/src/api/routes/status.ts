/** What the service can currently do, so the UI can explain what is missing. */
import { Router } from 'express';
import { aiIsConfigured, env } from '../../config/env.js';
import { getAiProvider } from '../../ai/factory.js';
import { checkAIProvider } from '../../ai/health.js';
import { playwrightRunnerAvailable } from '../../playwright/runner.js';
import { asyncHandler } from '../middleware.js';

export const statusRouter = Router();

statusRouter.get('/status', asyncHandler(async (_req, res) => {
  const [playwright, health] = await Promise.all([playwrightRunnerAvailable(), checkAIProvider()]);
  const provider = getAiProvider();
  res.json({
    ai: {
      configured: aiIsConfigured(),
      disabled: env.AI_DISABLED,
      provider: provider?.name ?? env.AI_PROVIDER,
      model: provider?.model ?? health.model ?? null,
      available: health.available,
      ...(health.reason ? { reason: health.reason } : {}),
    },
    execution: {
      playwrightAvailable: playwright,
      browser: env.PLAYWRIGHT_BROWSER,
      video: env.PLAYWRIGHT_VIDEO,
      baseUrl: env.TEST_BASE_URL,
    },
    pullRequests: {
      webhookConfigured: Boolean(env.GITHUB_WEBHOOK_SECRET),
      reviewActions: env.PR_REVIEW_ACTIONS.split(',').map((a) => a.trim()).filter(Boolean),
      reviewsForks: env.PR_REVIEW_FORKS,
      startsApp: Boolean(env.PR_APP_START_COMMAND),
      publicUrl: env.QA_PUBLIC_URL ?? null,
    },
  });
}));
