import { Router } from 'express';

export function healthRouter(pingDb: () => Promise<void>, version: string): Router {
  const router = Router();
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok', version });
  });
  router.get('/ready', async (req, res) => {
    try {
      await pingDb();
      res.json({ status: 'ok' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}
