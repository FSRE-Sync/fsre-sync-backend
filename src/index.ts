import { createApp } from "./api.ts";
import { config, log } from "./config.ts";
import { migrate, prisma } from "./db.ts";
import { createFcm } from "./fcm.ts";
import type { Channel } from "./model.ts";
import type { Transport, Transports } from "./notify.ts";
import { errorMessage } from "./result.ts";
import { sync } from "./sync.ts";

/** Every channel is optional; without any, the service is a read-only timetable API. */
async function createTransports(): Promise<Transports> {
  const transports = new Map<Channel, Transport>();

  const credentials = config.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentials !== undefined) {
    const fcm = await createFcm(credentials);
    if (fcm.ok) transports.set(fcm.value.channel, fcm.value);
    else log.error(`Invalid Firebase service account ${credentials}, push notifications are disabled: ${fcm.error}`);
  }

  const { MAIL_USERNAME: user, MAIL_PASSWORD: password, PUBLIC_URL: publicUrl } = config;
  if (user !== undefined && password !== undefined && publicUrl !== undefined) {
    const { createEmail } = await import("./email.ts");
    const from = config.MAIL_FROM ?? `FSRE Notifier <${user}>`;
    const email = await createEmail({ host: config.SMTP_HOST, port: config.SMTP_PORT, user, password, from, publicUrl });
    transports.set(email.channel, email);
  } else if (user !== undefined || password !== undefined) {
    log.error("Email notifications need MAIL_USERNAME, MAIL_PASSWORD and PUBLIC_URL; email is disabled");
  }

  log.info(
    transports.size > 0
      ? `Notifications enabled via ${[...transports.keys()].join(" and ")}`
      : "No notification channels configured, serving the timetable API only",
  );
  return transports;
}

await migrate();
const transports = await createTransports();

const server = Bun.serve({ port: config.PORT, fetch: createApp(transports).fetch, idleTimeout: 60 });
log.info(`Listening on ${server.url.href}api`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, shutting down`);
    void server.stop().then(() => prisma.$disconnect()).finally(() => process.exit(0));
  });
}

const runSync = (): Promise<void> =>
  sync(transports).catch((cause: unknown) => {
    log.error(`Sync failed: ${errorMessage(cause)}`);
  });

await runSync();
Bun.cron(config.SYNC_CRON, runSync);
