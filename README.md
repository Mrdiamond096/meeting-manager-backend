# meeting-manager-backend

Express 5 + TypeScript REST API for Meeting Manager, with Prisma 7 on PostgreSQL 16. It runs on its own, or as
the `backend/` submodule of [meeting-manager](https://github.com/Mrdiamond096/meeting-manager), which adds the
web app and a reverse proxy. The API is documented in [docs/api-contract.md](docs/api-contract.md).

## Quick start (Docker)

Needs Docker with Compose v2.

```bash
make up                                        # api (dev image, hot reload) + postgres
curl http://localhost:3000/api/health/ready    # {"status":"ok"}
docker compose exec api npm run db:seed        # optional demo data, see below
```

`make up` runs migrations when the api container starts. `make down` stops the stack, `make clean` also deletes the
database volume, and `make help` lists every target.

Ports: API `:3000`, PostgreSQL `:5432` (user, password and database are all `meeting`).

## Local Node (without the api container)

Needs Node 24 (`.nvmrc`) and a PostgreSQL reachable at `DATABASE_URL`.

```bash
nvm use
npm install                   # also runs prisma generate
docker compose up -d db       # or use your own PostgreSQL
npm run db:deploy             # apply migrations
npm run dev                   # tsx watch on :3000
```

Without a `.env` loader the defaults in the table below apply. The default `DATABASE_URL` points at `localhost:5432`,
which is the compose database.

## Demo data and login

```bash
docker compose exec api npm run db:seed   # standalone backend
make seed                                 # from the umbrella repo, with its stack running
```

The seed creates one verified user plus 8 candidates with meetings and feedback, with dates relative to today so the
calendar always shows something this week. Running it again resets only what the demo user created; other accounts
are left alone.

| | |
|---|---|
| Email | `demo@example.com` (override: `SEED_DEMO_EMAIL`) |
| Password | `demo-password-123` (override: `SEED_DEMO_PASSWORD`) |
| OTP | `112233`: the mock provider accepts this fixed code (`OTP_MOCK_CODE`) |

When `NODE_ENV=production`, the seed refuses to run (exit 1) unless `ALLOW_DEMO_SEED=true`. The umbrella `make seed`
passes that flag for this one command only. Never set it on a server.

## Environment variables

Validated at startup in `src/config.ts`. An invalid value logs one JSON `fatal` line naming the variable (never its
value) and exits 1. Docker Compose reads `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`; the prod image sets `production` |
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgres://meeting:meeting@localhost:5432/meeting` | **Production: required**, with a real password |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Per-statement timeout |
| `LOG_LEVEL` | `info` (`silent` in test) | `fatal` … `trace`, `silent` |
| `LOG_PRETTY` | `false` | Human-readable logs for local dev; keep JSON in production |
| `APP_VERSION` | `dev` | Returned by `/api/health/live` |
| `RATE_LIMIT_ENABLED` | `true` | Turns every limit below on or off. Keep `true` in production |
| `RATE_LIMIT_LOGIN` | `5/15` | Each limit is `max/minutes`: max up to 999999, minutes up to 1440. Per IP + email |
| `RATE_LIMIT_REGISTER` | `3/60` | Per IP |
| `RATE_LIMIT_FORGOT_PASSWORD` | `3/60` | Per IP + email |
| `RATE_LIMIT_OTP_RESEND` | `10/15` | Per IP |
| `RATE_LIMIT_PASSWORD_RESET` | `10/15` | Per IP |
| `RATE_LIMIT_WRITE` | `60/1` | Creates, updates and deletes, per user |
| `COOKIE_SECURE` | `false` | **Production: `true`** (HTTPS only session cookie) |
| `ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:3001` | Comma-separated origins allowed to send state-changing requests. **Production: the real web origin** |
| `OTP_PROVIDER` | `mock` | Only `mock` exists. The API refuses to start with it when `NODE_ENV=production`… |
| `ALLOW_MOCK_OTP` | `false` | …unless this is `true`. Only for running the prod image locally (umbrella compose), never in a real deployment |
| `OTP_MOCK_CODE` | `112233` | Six digits accepted by the mock provider |
| `ALLOW_DEMO_SEED` | `false` | See the demo data section |
| `SEED_DEMO_EMAIL`, `SEED_DEMO_PASSWORD` | see above | Seed only; checked with the registration rules |

## Tests

Vitest + supertest against a disposable PostgreSQL database. Tests truncate every table, so the application
connection is never used as a fallback.

```bash
make test          # Node 24 tests; starts isolated PostgreSQL on 127.0.0.1:55432
make test-docker   # runs the tests in a container against the same isolated database
make test-down     # stop and discard the test database
```

The test stack uses its own Compose project and tmpfs storage, separate from the app's database and volume.
Set `TEST_DB_PORT` to change its host port. Migrations run only after the test connection is checked.

For an existing disposable database, pass `TEST_DATABASE_URL` explicitly:

```bash
TEST_DATABASE_URL=postgres://meeting:meeting@127.0.0.1:55432/meeting_test npm test
```

The URL must use PostgreSQL and name a database ending in `_test`. Missing values, application database names
and options that redirect the connection target are rejected before connecting or migrating. Setup also checks
`current_database()` before migrations; the reset helper refuses to truncate if the application connection differs
from the explicit test target. An inherited `DATABASE_URL` is overridden for test workers and migrations.
Only point `TEST_DATABASE_URL` at disposable data: the name check cannot prove who else uses that database.
`npm run test:watch` uses the same guard and requires the same variable.

`npm run typecheck` checks types. CI uses an isolated `meeting_test` service and runs dependency audit,
typecheck, guarded migrations/tests, build and the production Docker image.

## Code formatting

Run `npm run format` to format TypeScript and `npm run format:check` to check it without edits. CI checks the
same rules. Generated Prisma code, build output and migration files are excluded.

## Production image

```bash
docker build --target prod -t meeting-api .
```

The image runs as `node` with `NODE_ENV=production`, applies migrations (`prisma migrate deploy`), then starts
`dist/server.js`. The seed is never part of startup.

Health: `GET /api/health/live` (process up) and `GET /api/health/ready` (database reachable, otherwise 503).

## Layout

```
src/
  app.ts, server.ts, config.ts
  modules/{auth,meetings,candidates,feedback}/   router → service → repository (+ schemas, mapper)
  http/, observability/                          middleware, errors, logging, request ids
  db/                                            Prisma client, seed
prisma/                                          schema and migrations
test/                                            one folder per module, helpers/ for the shared app and DB
docs/api-contract.md                             the API contract (changes go in a separate "contract:" PR)
```

## Dependency audit

Run `npm run audit:ci` to check production dependencies with no exceptions, then all dependencies with pinned
`audit-ci`. The sole dev-tool exception is recorded in `audit-ci.json` with a reason and expires at the end of
2026-12-31 (UTC). High/critical findings outside that exception, production findings and audit failures block CI.
Run `npm run test:audit` to verify the policy against clean, expired, unlisted, production and failed-audit fixtures.
