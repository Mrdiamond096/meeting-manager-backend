import { Router } from 'express';
import { requireRole } from '../../http/auth-guard.js';
import { parseBody, parseQuery } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { emptyQuery } from '../meetings/schemas.js';
import { searchBody } from './schemas.js';
import { interviewerService } from './service.js';
export function interviewersRouter(deps: ModuleDeps): Router {
  const router = Router();
  const service = interviewerService(deps);
  router.post('/search', requireRole('ADMIN', 'RECRUITER'), async (req, res) => {
    parseQuery(emptyQuery, req);
    res.json(await service.search(parseBody(searchBody, req).query));
  });
  return router;
}
