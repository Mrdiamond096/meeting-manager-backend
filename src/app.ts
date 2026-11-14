import express, { type Express } from 'express';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  pingDb: () => Promise<void>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/health', healthRouter(deps.pingDb));
  return app;
}
