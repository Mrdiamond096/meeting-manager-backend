import { Router } from 'express';
import type { ModuleDeps } from '../deps.js';

// Placeholder mounted by app.ts (Phase 1). Owned and implemented by its workstream (see docs ai-collaboration.md).
export function authRouter(_deps: ModuleDeps): Router {
  return Router({ mergeParams: true });
}
