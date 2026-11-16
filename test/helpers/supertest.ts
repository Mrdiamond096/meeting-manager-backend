import { createRequire } from 'node:module';
import { createServer, type RequestListener, type Server } from 'node:http';
import type supertestType from 'supertest';

/**
 * Drop-in replacement for `supertest`, wired in through the alias in vitest.config.ts.
 *
 * Stock supertest opens and closes a throwaway server for every single `request(app)`.
 * Under this suite's load that randomly loses a response: the client waits until the 5s
 * test timeout while the server saw nothing wrong (about 1 run in 4 on main before this
 * helper). Keeping one long-lived server per app removes the problem and is faster.
 */
const require = createRequire(import.meta.url);
const real = require('supertest/index.js') as typeof supertestType;

const servers = new WeakMap<object, Server>();

function sharedServer(app: Parameters<typeof supertestType>[0]): Parameters<typeof supertestType>[0] {
  if (typeof app !== 'function') return app;
  let server = servers.get(app);
  if (!server) {
    server = createServer(app as RequestListener);
    server.listen(0); // no host: binds synchronously, so address() is ready for supertest
    server.unref(); // never keeps the worker alive
    servers.set(app, server);
  }
  return server;
}

const request = ((app, options) => real(sharedServer(app), options)) as typeof supertestType;
Object.assign(request, real);

export default request;
