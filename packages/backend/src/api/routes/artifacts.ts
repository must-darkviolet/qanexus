/**
 * Serves the evidence a pull-request comment links to: the recorded videos,
 * the screenshots and the traces of a run.
 *
 * Paths are confined to the artifact root (and to generated suites, never to a
 * cloned repository, which may hold secrets), so a crafted path cannot read
 * arbitrary files. The endpoint itself is unauthenticated: see QA_PUBLIC_URL
 * in .env.example before exposing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { asyncHandler } from '../middleware.js';
import { badRequest, notFound } from '../../util/errors.js';

const ARTIFACT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip', '.ts': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

function send(res: import('express').Response, resolved: string): void {
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw notFound('Artifact not found.');
  res.setHeader('Content-Type', ARTIFACT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(resolved).pipe(res);
}

export const artifactsRouter = Router();

artifactsRouter.get('/', asyncHandler(async (req, res) => {
  const requested = String(req.query['path'] ?? '');
  if (!requested) throw badRequest('A "path" query parameter is required.');

  const resolved = path.resolve(requested);
  const within = (dir: string) => resolved.startsWith(path.resolve(dir) + path.sep);
  const inSuite = within(env.workspaceRoot)
    && path.relative(path.resolve(env.workspaceRoot), resolved).split(path.sep)[1] === 'qa-suite';
  if (!within(env.artifactRoot) && !inSuite) {
    throw badRequest('Path is outside the artifact directory.');
  }
  send(res, resolved);
}));

/**
 * The same files by path under the artifact root. The Playwright HTML report
 * loads its videos, traces and scripts by relative URL, which only resolves
 * when the report itself is served from a real path.
 */
artifactsRouter.get('/files/*', asyncHandler(async (req, res) => {
  const relative = String((req.params as Record<string, string>)[0] ?? '');
  const root = path.resolve(env.artifactRoot);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw badRequest('Path is outside the artifact directory.');
  send(res, resolved);
}));

/** The URL of a file under the artifact root, served by the route above. */
export function artifactFileUrl(publicUrl: string, file: string): string | null {
  const relative = path.relative(path.resolve(env.artifactRoot), path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return `${publicUrl}/api/artifacts/files/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}
