import { Router } from 'express';
import { requireRole } from '../../http/auth-guard.js';
import { parseQuery } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { searchQuery } from './schemas.js';
import { interviewerService } from './service.js';
export function interviewersRouter(deps: ModuleDeps): Router {
  const router = Router();
  const service = interviewerService(deps);
  router.get('/', requireRole('ADMIN', 'RECRUITER'), async (req, res) =>
    res.json(await service.search(parseQuery(searchQuery, req).query)),
  );
  return router;
}
