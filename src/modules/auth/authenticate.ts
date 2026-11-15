import { anonymous, type Authenticate } from '../../http/auth-guard.js';
import type { ModuleDeps } from '../deps.js';

/**
 * Session authenticator wired in server.ts. Owned by WS-B (B2): replace the body to read the `sid` cookie,
 * load the session (idle 8h / absolute 7d) and set req.user. Keep this signature.
 */
export function createAuthenticate(_deps: ModuleDeps): Authenticate {
  return anonymous;
}
