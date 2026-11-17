import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Database } from './db/client.js';
import { config } from './config.js';
import { anonymous, requireAuth, type Authenticate } from './http/auth-guard.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { originGuard } from './http/origin-guard.js';
import { createRateLimits, type RateLimitConfig } from './http/rate-limit.js';
import { authRouter } from './modules/auth/router.js';
import { candidatesRouter } from './modules/candidates/router.js';
import { feedbackRouter } from './modules/feedback/router.js';
import { meetingsRouter } from './modules/meetings/router.js';
import { httpLogger } from './observability/http-logger.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  pingDb: () => Promise<void>;
  db: Database;
  /** Populates req.user from the session cookie; tests may inject an authenticator. */
  authenticate?: Authenticate;
  now?: () => Date;
  appVersion?: string;
  /** Origins allowed on non-GET requests; defaults to ALLOWED_ORIGINS. */
  allowedOrigins?: readonly string[];
  rateLimitConfig?: RateLimitConfig;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const moduleDeps = { db: deps.db, now: deps.now ?? (() => new Date()) };

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(httpLogger);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter(deps.pingDb, deps.appVersion ?? 'dev'));

  const v1 = express.Router();
  v1.use(originGuard(deps.allowedOrigins ?? config.allowedOrigins));
  v1.use(deps.authenticate ?? anonymous);
  const rateLimitConfig = deps.rateLimitConfig ?? config;
  const rateLimits = createRateLimits(rateLimitConfig);
  v1.use('/auth', authRouter(moduleDeps, { rateLimitConfig }));

  const limitWrites = rateLimits.write();
  const writes: RequestHandler = (req, res, next) =>
    req.method === 'GET' ? next() : limitWrites(req, res, next);
  v1.use('/meetings/:id/feedback', requireAuth, writes, feedbackRouter(moduleDeps));
  v1.use('/meetings', requireAuth, writes, meetingsRouter(moduleDeps));
  v1.use('/candidates', requireAuth, writes, candidatesRouter(moduleDeps));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
