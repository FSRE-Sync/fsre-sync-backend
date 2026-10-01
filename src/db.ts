import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadMigrationsFromDir, PrismaBunSqlite, runMigrations } from "prisma-adapter-bun-sqlite";

import { config, log } from "./config.ts";
import { PrismaClient } from "./generated/prisma/client.ts";

const adapter = new PrismaBunSqlite({ url: config.DATABASE_URL, wal: { enabled: true } });

export const prisma = new PrismaClient({ adapter });

/** Applies `prisma/migrations` at startup, so the runtime image doesn't need the Prisma CLI. */
export async function migrate(): Promise<void> {
  await mkdir(dirname(config.DATABASE_URL.slice("file:".length)), { recursive: true });
  const connection = await adapter.connect();
  try {
    const migrations = await loadMigrationsFromDir("prisma/migrations");
    await runMigrations(connection, migrations, { useTransaction: true, logger: log.debug });
  } finally {
    await connection.dispose();
  }
}
