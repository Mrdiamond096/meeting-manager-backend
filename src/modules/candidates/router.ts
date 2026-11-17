import { Router } from 'express';
import { CANDIDATE_POSITIONS } from '../../db/constants.js';
import { idParams, parseBody, parseParams, parseQuery } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { createSchema, emptyQuery, searchQuery } from './schemas.js';
import { candidateService } from './service.js';

export function candidatesRouter(deps: ModuleDeps): Router {
  const router = Router({ mergeParams: true });
  const service = candidateService(deps);
  router.get('/', async (req, res) =>
    res.json(await service.search(parseQuery(searchQuery, req).q)),
  );
  router.get('/positions', (req, res) => {
    parseQuery(emptyQuery, req);
    res.json({ items: CANDIDATE_POSITIONS });
  });
  router.get('/:id', async (req, res) => {
    parseQuery(emptyQuery, req);
    res.json(await service.get(parseParams(idParams, req).id, req.user!.id));
  });
  router.post('/', async (req, res) => {
    parseQuery(emptyQuery, req);
    res.status(201).json(await service.create(parseBody(createSchema, req), req.user!.id));
  });
  return router;
}
