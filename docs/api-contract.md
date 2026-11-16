# API Contract — v1 (frozen at R1)

Source of truth for WS-A (meetings, candidates, feedback), WS-B (auth) and WS-C (frontend).
Changing anything here = a separate PR titled `contract: ...`, announced to every workstream.
Design references: ADR-005 (datetime), ADR-006 (candidate identity), ADR-007 (concurrency), ADR-009 (auth), ADR-012 (logging), ADR-013 (security), ADR-014 (calendar).

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` (browser calls it same-origin through Next.js rewrites; never a different host) |
| Format | JSON, `Content-Type: application/json`, body limit 100 kB |
| Validation | Zod `.strict()` on body, query and params: unknown keys → 400; path ids must be UUIDs → 400 |
| Ids | UUID v4 strings |
| Date-time input | RFC 3339 **with offset**, e.g. `2026-11-20T10:00:00+07:00` or `...Z`. Date-only or no offset → 400 |
| Date-time output | UTC ISO string `2026-11-20T03:00:00.000Z` |
| Strings | Trimmed before length checks |
| Auth | Cookie `sid` (httpOnly, SameSite=Lax, Path=/). All routes except `/auth/*` and `/health/*` need a session → otherwise 401 |
| CSRF | Non-GET requests with an `Origin` header not in `ALLOWED_ORIGINS` → 403 `ORIGIN_NOT_ALLOWED` |
| Request id | Optional `X-Request-Id` (`[A-Za-z0-9-]{1,64}`); always returned in the `X-Request-Id` header and in error bodies |
| Rate limit | 429 `RATE_LIMITED` with `RateLimit*` headers (ADR-013 table). Writes on meetings/candidates/feedback: 60/min per user |

### Error body (every non-2xx)

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "body.dueDate", "message": "Invalid datetime" }],
    "requestId": "7217fe62-0602-44a2-b5ad-e5d64b7a127f"
  }
}
```

`details` appears only for `VALIDATION_ERROR` and `OTP_INVALID`. 500 never includes stack traces or SQL.

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | schema / cross-field validation failed |
| `INVALID_JSON` | 400 | malformed body |
| `OTP_INVALID` | 400 | wrong, expired, consumed or locked challenge (one code for all, details carry `attemptsRemaining`) |
| `UNAUTHENTICATED` | 401 | no or expired session |
| `INVALID_CREDENTIALS` | 401 | login email/password wrong (same message for both) |
| `FORBIDDEN` | 403 | role not allowed (future guest role) |
| `ORIGIN_NOT_ALLOWED` | 403 | CSRF origin check failed |
| `NOT_FOUND` | 404 | unknown route or resource |
| `VERSION_CONFLICT` | 409 | `version` does not match the current row |
| `INVALID_TRANSITION` | 409 | status change not allowed |
| `EMAIL_TAKEN` | 409 | register with an already verified email |
| `PAYLOAD_TOO_LARGE` | 413 | body > 100 kB |
| `RATE_LIMITED` | 429 | limit exceeded |
| `INTERNAL_ERROR` | 500 | unexpected |

## 2. Shared shapes

```ts
type MeetingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';
type MeetingType = 'ONSITE' | 'ONLINE';
type Provider = 'ZOOM' | 'GOOGLE_MEET' | 'OTHER';

interface CandidateSummary { id: string; name: string; position: string; createdAt: string }

interface Meeting {
  id: string;
  title: string;                 // 1–150
  description: string;           // 0–5000 ("Notes" in the form)
  dueDate: string;               // meeting start (ADR-005)
  endAt: string | null;          // > dueDate
  status: MeetingStatus;
  meetingType: MeetingType | null;
  provider: Provider | null;     // null unless meetingType = ONLINE
  candidate: CandidateSummary | null;
  createdById: string | null;
  isMine: boolean;               // createdById === current user
  version: number;               // starts at 1, +1 on every write
  createdAt: string;
  updatedAt: string;
}

interface Feedback { id: string; meetingId: string; body: string; createdById: string | null; createdAt: string }

interface User { id: string; email: string; role: 'USER' }

interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
```

Positions (fixed list, validated on create): `Software Engineer`, `Frontend Engineer`, `Backend Engineer`, `Full Stack Engineer`, `QA Engineer`, `Data Engineer`, `DevOps Engineer`, `Product Designer`, `Product Manager` — also served by `GET /candidates/positions`.

## 3. Auth (WS-B)

All OTP challenges: 5 minutes TTL, single use, invalid after 5 wrong codes (logged `warn`). Mock provider accepts `OTP_MOCK_CODE` (`112233`).

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | 201 `{ challengeId, expiresAt }` (REGISTER challenge) | 400, 409 `EMAIL_TAKEN` (verified account exists), 429 (3/h per IP) |
| POST | `/auth/login` | `{ email, password }` | 200 `{ challengeId, expiresAt }` (LOGIN challenge) | 400, 401 `INVALID_CREDENTIALS`, 429 (5/15 min per IP+email) |
| POST | `/auth/otp/verify` | `{ challengeId, code }` | 200 `{ user: User }` + `Set-Cookie: sid` (REGISTER also marks email verified and signs in) | 400 `OTP_INVALID` with `details: [{ path: "attemptsRemaining", message: "3" }]` |
| POST | `/auth/otp/resend` | `{ challengeId }` | 200 `{ challengeId, expiresAt }` (old challenge invalidated) | 400 `OTP_INVALID`, 429 |
| POST | `/auth/password/forgot` | `{ email }` | 202 `{ challengeId, expiresAt }` — **always**, even for unknown email (fake id) | 400, 429 (3/h per IP+email) |
| POST | `/auth/password/reset` | `{ challengeId, code, newPassword }` | 204; all sessions of the user deleted | 400 `VALIDATION_ERROR` / `OTP_INVALID` |
| POST | `/auth/logout` | — | 204, session row deleted, cookie cleared | — (idempotent) |
| GET | `/auth/me` | — | 200 `{ user: User }` | 401 |

Rules: email trimmed + lowercased, ≤ 254 chars · password 8–72 bytes, no composition rules · register with an existing **unverified** email replaces its password and issues a new challenge · login of an unverified account works (the OTP proves the email) · session idle 8 h, absolute 7 days.

## 4. Meetings (WS-A)

### `GET /meetings` — paginated list
Query (all optional): `page` (≥1, default 1) · `pageSize` (1–50, default 10) · `status` (one status) · `from`, `to` (instants, `dueDate >= from` and `< to`) · `candidateId` · `mine` (`true|false`, default `false`).
Order: `dueDate asc, id asc`. Page past the end → 200 with `items: []`.
→ 200 `Page<Meeting>` · 400

### `GET /meetings?view=range` — calendar (ADR-014)
Query: `view=range` (required), `from`, `to` (required, `to - from` ≤ 42 days), `status`, `mine`. No pagination params allowed.
→ 200 `{ items: Meeting[] }` (max 500, same order) · 400 when range missing/too long or > 500 matches

### `GET /meetings/:id`
→ 200 `Meeting & { feedback: Feedback[] }` (feedback newest first) · 400 · 404

### `POST /meetings`
```json
{
  "title": "Interview: Somchai Jaidee",
  "description": "",
  "dueDate": "2026-11-20T10:00:00+07:00",
  "endAt": "2026-11-20T11:00:00+07:00",
  "status": "PENDING",
  "meetingType": "ONLINE",
  "provider": "GOOGLE_MEET",
  "candidateId": "…uuid…"
}
```
- `title`, `dueDate` required; `description` default `""`; `status` `PENDING|CONFIRMED` (default `PENDING`, cannot create `CANCELLED`).
- Candidate: either `candidateId` (existing) **or** `candidate: { name, position }` (created in the same transaction) or neither (generic meeting). Both → 400.
- Cross-field: `endAt > dueDate`; `provider` only when `meetingType = ONLINE`.
- `createdById` = current user.

→ 201 `Meeting` + `Location: /api/v1/meetings/:id` · 400 · 404 (`candidateId` unknown)

### `PATCH /meetings/:id`
Body: any subset of `title, description, dueDate, endAt, status, meetingType, provider, candidateId, candidate` **plus required `version`**. Empty patch (only `version`) → 400. Cross-field rules are checked on the merged record. `status` here may only be `PENDING` or `CONFIRMED`.
- **Clearing:** `endAt`, `meetingType`, `provider` and `candidateId` accept `null` to clear the value (→ 200). An omitted field is left as it is. `title`, `description`, `dueDate` and `status` cannot be null. Clearing `meetingType` while `provider` stays set → 400 (`provider` needs an online meeting), so send both as `null`.
- **Inline candidate:** `candidate: { name, position }` creates a candidate and links it in the same transaction as the edit, like on `POST`. Sending it together with `candidateId` (including `null`) → 400. On any failure (400, 404, 409) no candidate is left behind. The candidate that was linked before is not deleted.
→ 200 `Meeting` · 400 · 404 · 409 `VERSION_CONFLICT` / `INVALID_TRANSITION`

### `POST /meetings/:id/cancel`
Body `{ version }` → 200 `Meeting` (status `CANCELLED`, history kept) · 404 · 409

### `DELETE /meetings/:id?version=n`
Hard delete, feedback cascades. → 204 · 400 (missing version) · 404 · 409

### Status transitions
`PENDING ⇄ CONFIRMED` (PATCH) · `PENDING|CONFIRMED → CANCELLED` (cancel) · `CANCELLED → PENDING` (PATCH). Anything else → 409 `INVALID_TRANSITION`.

### Concurrency (ADR-007)
`UPDATE/DELETE … WHERE id = $1 AND version = $2`; 0 rows and the id exists → 409, id missing → 404.

## 5. Feedback (WS-A)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/meetings/:id/feedback` | `{ body }` (1–5000) | 201 `Feedback` | 400, 404 |

Append-only: no update or delete endpoints.

## 6. Candidates (WS-A)

| Method | Path | Notes | Success | Errors |
|---|---|---|---|---|
| GET | `/candidates?q=` | `q` 1–120 chars, case-insensitive contains on name; max 10, newest first | 200 `{ items: CandidateSummary[] }` | 400 |
| GET | `/candidates/positions` | fixed list | 200 `{ items: string[] }` | — |
| POST | `/candidates` | `{ name (1–120), position (from list) }`; duplicate names allowed | 201 `CandidateSummary` | 400 |
| GET | `/candidates/:id` | upcoming = `dueDate >= now` and not cancelled (asc); history = everything else (desc) | 200 `{ candidate: CandidateSummary, upcoming: Meeting[], history: Meeting[] }` | 400, 404 |

Candidates cannot be deleted (FK `RESTRICT`).

## 7. Health (Phase 1, done)

`GET /api/health/live` → 200 `{ status: "ok", version }` · `GET /api/health/ready` → 200 `{ status: "ok" }` / 503 `{ status: "unavailable" }`. Not under `/api/v1`, not access-logged.
