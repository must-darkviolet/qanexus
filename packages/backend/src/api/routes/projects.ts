/**
 * The repositories this service reviews pull requests for.
 *
 * Nothing here ever returns a GitHub token or a stored credential - a project
 * only reports whether one exists.
 */
import { Router } from 'express';
import { ProjectInput } from '@qa-agent/shared';
import {
  createProject, deleteProject, listProjects, requireProject, updateProject,
} from '../../db/repos/projects.js';
import { badRequest } from '../../util/errors.js';
import { asyncHandler } from '../middleware.js';

export const projectsRouter = Router();

projectsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ projects: await listProjects() });
}));

projectsRouter.post('/', asyncHandler(async (req, res) => {
  const parsed = ProjectInput.safeParse(req.body);
  if (!parsed.success) throw badRequest('Invalid project payload.', parsed.error.issues);
  res.status(201).json({ project: await createProject(parsed.data) });
}));

projectsRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json({ project: await requireProject(req.params.id!) });
}));

projectsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = ProjectInput.partial().safeParse(req.body);
  if (!parsed.success) throw badRequest('Invalid project payload.', parsed.error.issues);
  res.json({ project: await updateProject(req.params.id!, parsed.data) });
}));

projectsRouter.delete('/:id', asyncHandler(async (req, res) => {
  await requireProject(req.params.id!);
  await deleteProject(req.params.id!);
  res.status(204).end();
}));

/** Removes this project's stored GitHub token. */
projectsRouter.post('/:id/revoke-access', asyncHandler(async (req, res) => {
  res.json({ project: await updateProject(req.params.id!, { githubToken: '' }), revoked: true });
}));
