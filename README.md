# fsre-sync-backend

Backend for the **FSRE Sync** project: a clean timetable API over FSRE's Edupage
(`fsre.edupage.org`, which has no public API) plus push (FCM) and email notifications when a
subscribed study program's timetable changes. Both channels are optional; without them it
is just the timetable API.

Bun · Hono (`@hono/zod-openapi`) · Prisma 7 on SQLite (`bun:sqlite`) · zod · Temporal.

## How it works

- Every 15 minutes (`SYNC_CRON`) the timetable database is refetched, then the current and
  next ISO week of every study program **with subscribers** is fetched and diffed against the
  previous run. A diff is a list of changes: added, removed, or updated (same subject and
  type, but another time, room or teacher).
- Each subscriber gets the changes over their channel, with times in their time zone
  (`timeZone` at subscribe time, default Europe/Sarajevo):
  - **FCM**: one notification per change, all with the same `group` data key, a per-change
    Android `tag` and the APNs `thread-id` of the study program. More than 10 changes at
    once are sent as one summary notification instead.
  - **Email**: one email per program and week listing all changes, with an unsubscribe
    link and RFC 8058 one-click unsubscribe headers.
- Failed deliveries are retried (2 s, 15 s, 60 s) on network errors, rate limits and server
  errors. Addresses that can never work again (uninstalled app, refused mailbox) are deleted.
- The first run after startup only records a baseline, so restarts never send
  "everything is new" notifications.
- Subscriptions with neither a notification nor a resubscription for `SUBSCRIPTION_TTL_DAYS`
  are deleted (so are tokens FCM reports as unregistered), and at most `MAX_SUBSCRIPTIONS`
  are accepted.
- Timetables served by the API are cached in memory for 15 minutes. Subscriptions are the
  only persisted data (`data/fsre-sync-backend.db`).

### Adding a notification channel

Add its name to `CHANNELS` (`src/model.ts`), implement `Transport` (`src/notify.ts`: `verify`
an address before it is stored, `deliver` a `ChangeBatch` to a `Recipient`), register it in
`createTransports` (`src/index.ts`) and accept its address in the subscribe body.

## Running

```sh
cp .env.example .env                 # optional, everything has defaults
cp /path/to/service_account_key.json .  # Firebase service account, needed for push
docker compose up -d --build
```

The container joins the external `nginx-proxy` network and listens on port 5000.
Migrations run on startup; the SQLite file lives in the `data` volume.

Behind a registry mirror, build with `--build-arg NPM_CONFIG_REGISTRY=https://…/npm/`.

### Local development

```sh
bun install          # also generates the Prisma client
bun run dev          # http://localhost:5000/api, Swagger UI at /api/docs
bun run check        # tsc + oxlint (type-aware) + tests
bun run migrate      # after editing prisma/schema.prisma
```

## API

| Method       | Path                                    | Description                                            |
| ------------ | --------------------------------------- | ------------------------------------------------------ |
| `GET`        | `/api/timetable-database`               | Study programs, teachers, rooms, subjects, event types |
| `GET`        | `/api/timetable?studyProgram=&isoWeek=` | Weekly timetable (omit `studyProgram` to merge all)    |
| `POST`       | `/api/messaging/subscribe`              | `{ fcmToken?, email?, studyProgramId, timeZone? }`     |
| `POST`       | `/api/messaging/unsubscribe`            | `{ fcmToken?, email?, studyProgramId }`; idempotent    |
| `GET`/`POST` | `/api/messaging/unsubscribe/{id}`       | Email unsubscribe link (GET confirms, POST deletes)    |
| `GET`        | `/api/health`                           | Liveness and enabled notification channels             |

Subscribe needs at least one of `fcmToken` and `email` and returns one subscription per
destination. Subscribing again is not an error: it updates the time zone and restarts the
pruning clock, so clients resubscribe whenever their FCM token or time zone changes (and
unsubscribe the old token). It answers 400 if
FCM rejects the token, and 503 if that channel is disabled or the subscription limit is reached.

OpenAPI 3.1 spec at `/api/v3/api-docs` (same path, server URL and schema names as the Java
backend). Errors use the `FsreError` shape `{ status, error, message, details? }`.

FCM data keys (all strings): `change` (`added`/`removed`/`updated`/`summary`), `group`,
`studyProgramId`, `timetableKey`, `timestamp`, `summary`, plus the Java backend's
`newTimetableEvents`/`removedTimetableEvents` JSON lists (an update is in both; `[]` if they
would exceed FCM's 4 KB limit). Event times in the data are UTC; the notification text is
already localized to the subscriber's `timeZone`.

## Configuration

| Variable                         | Default                                            |
| -------------------------------- | -------------------------------------------------- |
| `PORT`                           | `5000`                                             |
| `DATABASE_URL`                   | `file:./data/fsre-sync-backend.db`                 |
| `EDUPAGE_URL`                    | `https://fsre.edupage.org`                         |
| `SYNC_CRON`                      | `*/15 * * * *`                                     |
| `LOG_LEVEL`                      | `info`                                             |
| `SUBSCRIPTION_TTL_DAYS`          | `365`                                              |
| `MAX_SUBSCRIPTIONS`              | `10000`                                            |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset (push disabled)                              |
| `MAIL_USERNAME`, `MAIL_PASSWORD` | unset (email disabled)                             |
| `PUBLIC_URL`                     | unset; needed for email (origin serving `/api`)    |
| `SMTP_HOST`, `SMTP_PORT`         | `smtp.gmail.com`, `587` (STARTTLS; `465` uses TLS) |
| `MAIL_FROM`                      | `FSRE Notifier <MAIL_USERNAME>`                    |

## Code

| File             | Contents                                                          |
| ---------------- | ----------------------------------------------------------------- |
| `src/model.ts`   | API schemas (also the TS types and OpenAPI spec), ISO weeks, diff |
| `src/edupage.ts` | Edupage RPC client, wire format validation, Croatian name parsing |
| `src/sync.ts`    | In-memory state, cached timetable reads, the change-detection job |
| `src/notify.ts`  | `Transport` interface, delivery bookkeeping, shared wording       |
| `src/fcm.ts`     | FCM HTTP v1 transport (service account JWT), push messages        |
| `src/email.ts`   | SMTP transport (nodemailer, loaded only if configured), emails    |
| `src/api.ts`     | Hono routes                                                       |
| `src/db.ts`      | Prisma client and startup migrations                              |
| `src/result.ts`  | `Result<T, E>`                                                    |
| `src/config.ts`  | Environment and logging                                           |

Expected failures (Edupage down, invalid input, FCM rejections) are `Result` values with
exhaustively matched error unions; `oxlint` runs type-aware and rejects `any`, type
assertions, unsafe `any` flows, non-exhaustive `switch`es and implicit truthiness checks.

## Differences from the Java backend

- Subscriptions are one row per destination (`channel`, `address`) with a `timeZone`; a
  subscribe request needs a token or email, and `studyProgramId` must exist.
- One notification per change (with reschedules as updates) instead of one summary.
- Stale subscriptions are pruned and the total is capped; FCM tokens are validated
  (dry run) when subscribing.
- The timetable database is refreshed every sync (was: once at startup) and uses the same
  academic year rule as timetables (was: always `year - 1`, which served last year's
  study programs from September to December).
- Events are deduplicated by content, not by subject ID per day (which dropped e.g. an
  exercise held on the same day as its lecture).
- Only schedule changes trigger notifications (time, name, rooms, teachers, programs), not
  renamed teachers/rooms. Notification times are in the subscriber's time zone (was: UTC).
- Unregistered FCM tokens are deleted. If the event lists would exceed FCM's 4 KB limit they
  are sent as `[]` instead of the message failing.
- One failing Edupage request no longer aborts the rest of the sync run.
- `department`, `year` and the `*Names` entries are nullable in the schema when Edupage
  references unknown IDs (the Java backend returned 502 or `null`s in that case).
