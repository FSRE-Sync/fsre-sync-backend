# FSRE Timetable Notify Backend

Spring Boot backend that exposes a clean REST API over [Edupage](https://fsre.edupage.org)
timetable data for FSRE (Faculty of Mechanical Engineering, Computer Science and
Electrical Engineering), SUM (University of Mostar). Edupage has no public API - this
service reverse-engineers it, enriches events with human-readable names, and
polls for schedule changes to send push/email notifications.

**Clients:** [fsre-app](https://github.com/mapokapo/fsre-app) (official FSRE mobile app) and a separate [web
app](https://github.com/FSRE-Timetable-Notify/fsre-timetable-notify-frontend). Both consume this API; the original Flutter notifier app is no longer maintained.

## What it does

- Fetches and caches weekly timetables per study program and ISO week
- Serves reference data (study programs, teachers, rooms, subjects)
- Accepts FCM/email subscriptions per study program
- Detects timetable changes every 15 minutes and notifies subscribers

The API preserves all schedule-relevant Edupage information in a restructured
form - enough to rebuild the Edupage timetable UI, without Edupage's internal cruft.

## API

Base path: `/api` · OpenAPI UI: `/api/docs` (disabled in production)

| Method | Path                                | Description                            |
| ------ | ----------------------------------- | -------------------------------------- |
| `GET`  | `/timetable-database`               | Reference data for filters and lookups |
| `GET`  | `/timetable?studyProgram=&isoWeek=` | Weekly timetable for a study program   |
| `POST` | `/messaging/subscribe`              | Subscribe to change notifications      |
| `POST` | `/messaging/unsubscribe`            | Unsubscribe from a study program       |

Subscribe body: `{ "email"?, "fcmToken"?, "studyProgramId" }` - at least one of
`email` or `fcmToken` should be provided.

## Get started

### Docker (recommended)

1. Copy environment variables

   ```bash
   cp .env.example .env
   ```

2. Add `service_account_key.json` (Firebase) for push notifications

3. Start the stack

   ```bash
   docker compose up --build
   ```

The app listens on port `5000`. Production deploy expects an external `nginx-proxy`
network (see `docker-compose.yml`).

### Local development

Requires Java 21+, MariaDB, and the same env vars as `.env.example` plus mail
credentials (`MAIL_USERNAME`, `MAIL_PASSWORD`).

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
```

Dev profile uses `ddl-auto=create-drop` and DEBUG logging.

### Client types

The mobile app generates its typed client from this backend's OpenAPI spec (see
[fsre-app README](https://github.com/mapokapo/fsre-app#api-types)). Regenerate after API changes.

## Project structure

```
src/main/java/me/leopetrovic/fsretimetablenotify/
├── timetabledatabase/   reference data from Edupage (fetch, parse, serve)
├── timetable/           weekly timetable fetch, cache, enrichment
├── timing/              scheduled change detection
├── messaging/           subscriptions, FCM/email delivery
└── common/              shared parsing, error types, properties
```

Custom Jackson serializers for Edupage's RPC wire format live in each module's
`transformers/` package.

## Code conventions

1. **Request DTOs** - Java records; no custom Jackson logic (keeps OpenAPI accurate)
2. **Response objects** - Lombok `@Data` POJOs or JPA entities, not records
3. **JPA entities** - `@Getter`/`@Setter` only, not `@Data`
4. **De/serialization** - `@JsonComponent` classes in `transformers/`
5. **Errors** - module `exceptions/`, `FsreError` is the common HTTP error response shape

More domain context lives in [`.cursor/rules/`](.cursor/rules/).
