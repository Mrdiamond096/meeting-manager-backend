import { Router } from 'express';

export function healthRouter(pingDb: () => Promise<void>): Router {
  const router = Router();
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/ready', async (_req, res) => {
    try {
      await pingDb();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}
