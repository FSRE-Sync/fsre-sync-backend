import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z, type Hook } from "@hono/zod-openapi";
import { Hono, type Context, type Env } from "hono";
import { getConnInfo } from "hono/bun";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import { config, log } from "./config.ts";
import { prisma } from "./db.ts";
import { describeEdupageError } from "./edupage.ts";
import type { Subscription as SubscriptionRow } from "./generated/prisma/client.ts";
import {
  FsreError,
  isChannel,
  IsoWeekParam,
  SubscribeRequest,
  Subscription,
  TIME_ZONE,
  Timetable,
  TimetableDatabase,
  UnsubscribeRequest,
  type Channel,
} from "./model.ts";
import type { Transport, Transports } from "./notify.ts";
import { fromThrowable } from "./result.ts";
import { getDatabase, getTimetable } from "./sync.ts";

type ErrorStatus = 400 | 404 | 500 | 502 | 503;

const REASONS = {
  400: "Bad Request",
  404: "Not Found",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
} as const satisfies Record<ErrorStatus, string>;

const problem = <Status extends ErrorStatus>(c: Context, status: Status, message: string, details?: string) =>
  c.json(
    { status, error: REASONS[status], message, ...(details === undefined ? {} : { details }) } satisfies FsreError,
    status,
  );

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const failure = (description: string) => json(FsreError, description);

const DATABASE_UNAVAILABLE = "The timetable database has not been loaded from Edupage yet";

/** Clients show `message` to users, so it names the first problem; `details` lists all of them. */
const defaultHook: Hook<unknown, Env, string, unknown> = (result, c) => {
  if (result.success) return undefined;
  const [issue] = result.error.issues;
  const message = issue === undefined ? "Invalid request" : `${issue.path.join(".") || "Request"}: ${issue.message}`;
  return problem(c, 400, message, z.prettifyError(result.error));
};

const timetables = new OpenAPIHono({ defaultHook });

timetables.openapi(
  createRoute({
    method: "get",
    path: "/timetable-database",
    operationId: "getTimetableDatabase",
    summary: "Get the timetable definitions database for the current study year",
    responses: {
      200: json(TimetableDatabase, "Timetable database retrieved successfully"),
      503: failure(DATABASE_UNAVAILABLE),
    },
  }),
  (c) => {
    const db = getDatabase();
    return db === undefined ? problem(c, 503, DATABASE_UNAVAILABLE) : c.json(db.data, 200);
  },
);

timetables.openapi(
  createRoute({
    method: "get",
    path: "/timetable",
    operationId: "getTimetable",
    summary: "Get the timetable data for a study program",
    request: {
      query: z.object({
        studyProgram: z.coerce
          .number()
          .int()
          .openapi({ description: "Study program ID; omit to merge all study programs", example: -54 })
          .optional(),
        isoWeek: IsoWeekParam,
      }),
    },
    responses: {
      200: json(Timetable, "Timetable data retrieved successfully"),
      400: failure("Invalid study program or ISO week"),
      404: failure("Unknown study program"),
      502: failure("Edupage request failed"),
      503: failure(DATABASE_UNAVAILABLE),
    },
  }),
  async (c) => {
    const { studyProgram, isoWeek } = c.req.valid("query");
    const timetable = await getTimetable(studyProgram, isoWeek);
    if (timetable.ok) return c.json(timetable.value, 200);

    const error = timetable.error;
    switch (error.kind) {
      case "database-unavailable":
        return problem(c, 503, DATABASE_UNAVAILABLE);
      case "unknown-study-program":
        return problem(c, 404, `Study program ${error.studyProgramId} does not exist`);
      case "network":
      case "http":
      case "invalid-response":
        return problem(c, 502, "Failed to make request to upstream server", describeEdupageError(error));
    }
  },
);

const CHANNEL_NAMES = { fcm: "FCM", email: "Email" } as const satisfies Record<Channel, string>;

type Destination = { readonly channel: Channel; readonly address: string };

function destinationsOf(body: { readonly fcmToken?: string | undefined; readonly email?: string | undefined }) {
  const destinations: Destination[] = [];
  if (body.fcmToken !== undefined) destinations.push({ channel: "fcm", address: body.fcmToken });
  if (body.email !== undefined) destinations.push({ channel: "email", address: body.email });
  return destinations;
}

function toSubscription(row: SubscriptionRow): z.infer<typeof Subscription>[] {
  const { id, channel, address, studyProgramId, timeZone, createdAt, lastNotifiedAt } = row;
  if (!isChannel(channel)) return [];
  return [
    {
      id,
      channel,
      address,
      studyProgramId,
      timeZone,
      createdAt: createdAt.toISOString(),
      lastNotifiedAt: lastNotifiedAt?.toISOString() ?? null,
    },
  ];
}

const page = (title: string, content: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>${title}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
  `<h1>${title}</h1>${content}</body></html>`;

function deviceInfo(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const direct = fromThrowable(
    () => getConnInfo(c).remote.address,
    () => undefined,
  );
  const ip = forwarded ?? (direct.ok ? direct.value : undefined) ?? "unknown";
  return `${c.req.header("user-agent") ?? "unknown"} | IP: ${ip}`;
}

/** The timetable routes work without transports; the messaging routes accept only enabled channels. */
export function createApp(transports: Transports) {
  const messaging = new OpenAPIHono({ defaultHook });

  messaging.openapi(
    createRoute({
      method: "post",
      path: "/subscribe",
      operationId: "subscribe",
      summary: "Subscribe an FCM token and/or an email address to timetable changes of a study program",
      description:
        "Idempotent: subscribing again updates the time zone and keeps the subscription from being pruned. " +
        "Clients should resubscribe when their FCM token or time zone changes.",
      request: { body: { required: true, content: { "application/json": { schema: SubscribeRequest } } } },
      responses: {
        200: json(z.array(Subscription), "Subscribed; one subscription per destination"),
        400: failure("Invalid request, unknown study program or an address that cannot receive notifications"),
        503: failure("Timetable database not loaded yet, channel disabled or subscription limit reached"),
      },
    }),
    async (c) => {
      const { studyProgramId, timeZone = TIME_ZONE, ...addresses } = c.req.valid("json");
      const db = getDatabase();
      if (db === undefined) return problem(c, 503, DATABASE_UNAVAILABLE);
      if (!db.studyPrograms.has(studyProgramId)) {
        return problem(c, 400, `Study program ${studyProgramId} does not exist`);
      }

      const destinations: (Destination & { readonly transport: Transport })[] = [];
      for (const destination of destinationsOf(addresses)) {
        const transport = transports.get(destination.channel);
        if (transport === undefined) {
          return problem(c, 503, `${CHANNEL_NAMES[destination.channel]} notifications are disabled on this server`);
        }
        destinations.push({ ...destination, transport });
      }

      const where = { studyProgramId, OR: destinations.map(({ channel, address }) => ({ channel, address })) };
      const existing = new Set(
        (await prisma.subscription.findMany({ where })).map(({ channel, address }) => `${channel}:${address}`),
      );
      const added = destinations.filter(({ channel, address }) => !existing.has(`${channel}:${address}`));
      if (added.length > 0 && (await prisma.subscription.count()) + added.length > config.MAX_SUBSCRIPTIONS) {
        log.warn(`Rejected a subscription: the limit of ${config.MAX_SUBSCRIPTIONS} subscriptions is reached`);
        return problem(c, 503, "This server does not accept new subscriptions at the moment");
      }
      for (const { channel, transport, address } of added) {
        const verified = await transport.verify(address);
        if (verified.ok) continue;
        if (verified.error.kind === "invalid-address") {
          return problem(c, 400, `This ${CHANNEL_NAMES[channel]} address cannot receive notifications`, verified.error.message);
        }
        log.warn(`Could not verify a new ${channel} subscription, accepting it anyway: ${verified.error.message}`);
      }

      const info = deviceInfo(c);
      const subscriptions = await prisma.$transaction(
        destinations.map(({ channel, address }) =>
          prisma.subscription.upsert({
            where: { channel_address_studyProgramId: { channel, address, studyProgramId } },
            create: { channel, address, studyProgramId, timeZone, deviceInfo: info },
            update: { timeZone, deviceInfo: info },
          }),
        ),
      );
      return c.json(subscriptions.flatMap(toSubscription), 200);
    },
  );

  messaging.openapi(
    createRoute({
      method: "post",
      path: "/unsubscribe",
      operationId: "unsubscribe",
      summary: "Unsubscribe an FCM token and/or an email address from a study program",
      request: { body: { required: true, content: { "application/json": { schema: UnsubscribeRequest } } } },
      responses: {
        200: { description: "Successfully unsubscribed (also if there was no such subscription)" },
        400: failure("Invalid request"),
      },
    }),
    async (c) => {
      const { studyProgramId, ...addresses } = c.req.valid("json");
      await prisma.subscription.deleteMany({ where: { studyProgramId, OR: destinationsOf(addresses) } });
      return c.body(null, 200);
    },
  );

  // Unsubscribe links in emails. GET only asks for confirmation because mail scanners prefetch links;
  // POST unsubscribes, from that page or as RFC 8058 one-click unsubscribe.
  messaging.get("/unsubscribe/:id", (c) =>
    c.html(
      page(
        "Unsubscribe",
        `<p>Stop receiving FSRE timetable change emails for this study program?</p>` +
          `<form method="post"><button type="submit">Unsubscribe</button></form>`,
      ),
    ),
  );
  messaging.post("/unsubscribe/:id", async (c) => {
    await prisma.subscription.deleteMany({ where: { id: c.req.param("id") } });
    return c.html(page("Unsubscribed", "<p>You will not receive any more emails for this study program.</p>"));
  });

  const api = new OpenAPIHono({ defaultHook }).route("/", timetables).route("/messaging", messaging);
  api.doc31("/v3/api-docs", {
    openapi: "3.1.0",
    info: { title: "FSRE Timetable Notify API", version: "2.0.0" },
    servers: [{ url: "/api" }],
  });
  api.get("/docs", swaggerUI({ url: "/api/v3/api-docs" }));
  api.get("/health", (c) =>
    c.json({
      status: "ok",
      timetableDatabaseLoaded: getDatabase() !== undefined,
      notificationChannels: [...transports.keys()],
    }),
  );

  return new Hono()
    .use(cors())
    .route("/api", api)
    .notFound((c) => problem(c, 404, `${c.req.method} ${c.req.path} does not exist`))
    .onError((error, c) => {
      if (error instanceof HTTPException && error.status === 400) return problem(c, 400, error.message);
      log.error(`${c.req.method} ${c.req.path} failed: ${error.stack ?? error.message}`);
      return problem(c, 500, "Internal server error");
    });
}
