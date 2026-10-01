import { z } from "zod";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

/** Unset and empty (`KEY=`) are the same thing in env files. */
const optional = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

const count = z.coerce.number().int().positive();

const Env = z.object({
  PORT: count.default(5000),
  DATABASE_URL: z
    .string()
    .startsWith("file:")
    .default("file:./data/fsre-sync-backend.db"),
  EDUPAGE_URL: z.url().default("https://fsre.edupage.org"),
  SYNC_CRON: z.string().default("*/15 * * * *"),
  LOG_LEVEL: z.enum(LEVELS).default("info"),
  /** Base URL clients reach this service at; used for unsubscribe links in emails. */
  PUBLIC_URL: optional(z.url()),
  SUBSCRIPTION_TTL_DAYS: count.default(365),
  MAX_SUBSCRIPTIONS: count.default(10_000),
  GOOGLE_APPLICATION_CREDENTIALS: optional(z.string()),
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: count.default(587),
  MAIL_USERNAME: optional(z.string()),
  MAIL_PASSWORD: optional(z.string()),
  MAIL_FROM: optional(z.string()),
});

export const config = Env.parse(process.env);

const threshold = LEVELS.indexOf(config.LOG_LEVEL);

const logAt =
  (level: Level) =>
  (message: string): void => {
    if (LEVELS.indexOf(level) < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };

export const log: Record<Level, (message: string) => void> = {
  debug: logAt("debug"),
  info: logAt("info"),
  warn: logAt("warn"),
  error: logAt("error"),
};
