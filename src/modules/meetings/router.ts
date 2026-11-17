import { Router } from 'express';
import { requireRole } from '../../http/auth-guard.js';
import { idParams, parseBody, parseParams, parseQuery } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import {
  cancelSchema,
  createSchema,
  deleteQuery,
  emptyQuery,
  listSchemaFor,
  patchSchema,
} from './schemas.js';
import { meetingService } from './service.js';

export function meetingsRouter(deps: ModuleDeps): Router {
  const router = Router({ mergeParams: true });
  const service = meetingService(deps);
  /** ADR-015: interviewers read meetings and add feedback; scheduling is for recruiters and admins. */
  const canSchedule = requireRole('ADMIN', 'RECRUITER');
  router.get('/', async (req, res) =>
    res.json(await service.list(parseQuery(listSchemaFor(req.query), req), req.user!.id)),
  );
  router.get('/:id', async (req, res) => {
    parseQuery(emptyQuery, req);
    res.json(await service.get(parseParams(idParams, req).id, req.user!.id));
  });
  router.post('/', canSchedule, async (req, res) => {
    parseQuery(emptyQuery, req);
    const meeting = await service.create(parseBody(createSchema, req), req.user!.id);
    res.location(`/api/v1/meetings/${meeting.id}`).status(201).json(meeting);
  });
  router.patch('/:id', canSchedule, async (req, res) => {
    parseQuery(emptyQuery, req);
    res.json(
      await service.patch(parseParams(idParams, req).id, parseBody(patchSchema, req), req.user!.id),
    );
  });
  router.post('/:id/cancel', canSchedule, async (req, res) => {
    parseQuery(emptyQuery, req);
    res.json(
      await service.cancel(
        parseParams(idParams, req).id,
        parseBody(cancelSchema, req).version,
        req.user!.id,
      ),
    );
  });
  router.delete('/:id', canSchedule, async (req, res) => {
    await service.remove(
      parseParams(idParams, req).id,
      parseQuery(deleteQuery, req).version,
      req.user!,
    );
    res.sendStatus(204);
  });
  return router;
}
