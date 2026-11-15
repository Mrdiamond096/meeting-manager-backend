# AGENTS.md — meeting-manager-backend

Rules for AI coding agents (Codex, Cursor, Claude). Full brief: umbrella repo `docs/discussion/finally/ai-collaboration.md`.

## Stack
Node 24 · Express 5 · TypeScript (ESM, `NodeNext`) · Drizzle ORM + PostgreSQL 16 · Zod 3 · pino · Vitest + supertest.

## Read before coding
1. `docs/api-contract.md` — source of truth. Do not change it inside a feature PR.
2. Umbrella repo: `docs/discussion/finally/final-architecture.md`, `implementation-plan.md`, `adr/` (ADR-005/006/007 data, ADR-009 auth, ADR-012 logging, ADR-013 security, ADR-014 calendar).
3. Existing code: `src/app.ts`, `src/http/*`, `src/observability/*`, `src/db/schema/*`, `test/helpers/*`, `test/http.test.ts`.

## Structure
```
src/
  app.ts                  createApp(deps) — mounts routers (shared, do not edit in feature PRs)
  config.ts               env via Zod (shared)
  db/schema/*.ts          one file per table (shared; schema changes = separate PR + `npm run db:generate`)
  http/                   errors.ts (AppError + codes), error-handler.ts, validate.ts, rate-limit.ts, auth-guard.ts
  observability/          logger.ts, http-logger.ts
  modules/<domain>/       router.ts · service.ts · repository.ts · schemas.ts (+ domain files)
test/
  helpers/                resetDb, createUser, createTestApp, loginAs
  <domain>/*.test.ts
```

## Patterns (must follow)
- Router = factory `xxxRouter(deps: ModuleDeps)`; use `deps.db` and `deps.now()` (never `new Date()` in logic, never import the global `db`).
- Router: parse input with `parseBody/parseQuery/parseParams` + `.strict()` Zod schemas → call service → `res.status(..).json(..)`.
- Service: business rules, transitions, transactions (`deps.db.transaction`). Repository: Drizzle queries only, no `sql.raw` with input.
- Errors: `throw new AppError('CODE')` with codes from `src/http/errors.ts`. Never send error JSON by hand. Express 5 forwards async throws.
- Logging: `req.log` only; no `console.log`; never log bodies, passwords, OTP, cookies, tokens or emails. 4xx are `info` (automatic), use `warn` only for abuse signals.
- Dates: accept with the `instant` helper; respond with `Date#toISOString()`.
- ESM imports end with `.js`.
- Tests: `beforeEach(resetDb)`; `const { app, user } = await loginAs()` for authenticated requests; supertest against the app.

## Ownership
| Agent | May edit |
|---|---|
| Codex (WS-A) | `src/modules/{meetings,candidates,feedback}/**`, `test/{meetings,candidates,feedback}/**` |
| Cursor (WS-B) | `src/modules/auth/**` (incl. `authenticate.ts`, wired in `server.ts`), `test/auth/**` |
| Claude (shared) | everything else (`app.ts`, `config.ts`, `db/**`, `drizzle/**`, `http/**`, `observability/**`, `test/helpers/**`, `package.json`, `docs/api-contract.md`) |

Need a shared change (new dependency, schema column, app.ts mount, helper)? Do not make it — describe it in the PR under **Shared change request**.

## Workflow
- Branch from `main`: `feature/ws-a-<n>-<desc>` / `feature/ws-b-<n>-<desc>`; rebase on `main` before opening the PR.
- Commits: Conventional Commits in English, e.g. `feat(meetings): add optimistic version check`.
- Done = `npm run typecheck && npm test && npm run build` green (tests need Postgres: `docker compose up -d db`).
- PR ≤ ~400 non-test lines; description: what, tests, trade-offs, open questions. Never commit `.env` or secrets; never force-push `main`.
