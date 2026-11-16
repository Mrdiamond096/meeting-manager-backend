import { createRequire } from 'node:module';
import { createServer, type RequestListener } from 'node:http';
import type supertestType from 'supertest';

/**
 * Drop-in replacement for `supertest`, wired in through the alias in vitest.config.ts.
 *
 * Stock supertest opens and closes a throwaway server for every `request(app)`, bound to every address. Under this
 * suite's load that randomly loses a response (a 5s timeout). Binding to every address also lets the kernel hand
 * out a port that another program on the machine already uses on IPv4, so a request occasionally reached a
 * different server (a 404 where a 400 was expected).
 *
 * Instead the whole process shares ONE server, bound to 127.0.0.1 only, and every app is reached under its own
 * path prefix. The prefix is stripped before the app sees the request, so routes, `req.url` and cookies behave
 * as if the app were mounted at the root.
 */
const require = createRequire(import.meta.url);
const real = require('supertest/index.js') as typeof supertestType;

const apps = new Map<number, RequestListener>();
const ids = new WeakMap<object, number>();
const PREFIX = /^\/__app\/(\d+)(\/.*)?$/;

const server = createServer((req, res) => {
  const match = PREFIX.exec(req.url ?? '');
  const handler = match && apps.get(Number(match[1]));
  if (!handler) {
    res.statusCode = 502;
    res.end('unknown test app');
    return;
  }
  req.url = match[2] ?? '/';
  handler(req, res);
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
server.unref(); // never keeps the worker alive
const { port } = server.address() as { port: number };

function baseUrl(app: Parameters<typeof supertestType>[0]): Parameters<typeof supertestType>[0] {
  if (typeof app !== 'function') return app; // an http.Server or URL the caller manages itself
  let id = ids.get(app);
  if (id === undefined) {
    id = apps.size + 1;
    ids.set(app, id);
    apps.set(id, app as RequestListener);
  }
  return `http://127.0.0.1:${port}/__app/${id}`;
}

const request = ((app, options) => real(baseUrl(app), options)) as typeof supertestType;
Object.assign(request, real);

export default request;
