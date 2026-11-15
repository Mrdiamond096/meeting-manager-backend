import { Router } from 'express';
import { idParams, parseBody, parseParams, parseQuery } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { createSchema, emptyQuery } from './schemas.js';
import { feedbackService } from './service.js';

export function feedbackRouter(deps: ModuleDeps): Router {
  const router = Router({ mergeParams: true });
  const service = feedbackService(deps);
  router.post('/', async (req, res) => {
    const { id } = parseParams(idParams, req);
    parseQuery(emptyQuery, req);
    res.status(201).json(await service.append(id, parseBody(createSchema, req).body, req.user!.id));
  });
  return router;
}
