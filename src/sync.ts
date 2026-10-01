import { config, log } from "./config.ts";
import { prisma } from "./db.ts";
import { describeEdupageError, fetchDatabase, fetchTimetable, type Database, type EdupageError } from "./edupage.ts";
import type { Subscription } from "./generated/prisma/client.ts";
import {
  academicYear,
  addWeeks,
  currentIsoWeek,
  diffTimetables,
  formatIsoWeek,
  type IsoWeek,
  type Timetable,
} from "./model.ts";
import { notifySubscriber, summarizeChanges, transportFor, type Transports } from "./notify.ts";
import { err, ok, type Result } from "./result.ts";

const CACHE_TTL_MS = 15 * 60_000;

let database: Database | undefined;
/** Short-lived cache for API reads. */
const cache = new Map<string, { readonly timetable: Timetable; readonly expiresAt: number }>();
/** Last timetable subscribers were notified about, per monitored (program, week). Only `sync` writes it. */
const baselines = new Map<string, Timetable>();

const keyOf = (studyProgramId: number | "all", week: IsoWeek): string => `${studyProgramId}/${formatIsoWeek(week)}`;

export const getDatabase = (): Database | undefined => database;

export type TimetableError =
  | EdupageError
  | { readonly kind: "database-unavailable" }
  | { readonly kind: "unknown-study-program"; readonly studyProgramId: number };

/** `studyProgramId === undefined` merges the timetables of all study programs. */
export async function getTimetable(
  studyProgramId: number | undefined,
  week: IsoWeek,
): Promise<Result<Timetable, TimetableError>> {
  const db = database;
  if (db === undefined) return err({ kind: "database-unavailable" });
  if (studyProgramId !== undefined && !db.studyPrograms.has(studyProgramId)) {
    return err({ kind: "unknown-study-program", studyProgramId });
  }

  const key = keyOf(studyProgramId ?? "all", week);
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return ok(cached.timetable);

  const fetched = await fetchTimetable(db, studyProgramId === undefined ? [...db.studyPrograms.keys()] : [studyProgramId], week);
  if (fetched.ok) cache.set(key, { timetable: fetched.value, expiresAt: Date.now() + CACHE_TTL_MS });
  return fetched;
}

type Target = { readonly studyProgramId: number; readonly week: IsoWeek; readonly subscriptions: Subscription[] };

async function checkForChanges(db: Database, transports: Transports, target: Target): Promise<void> {
  const { studyProgramId, week, subscriptions } = target;
  const key = keyOf(studyProgramId, week);
  const fetched = await fetchTimetable(db, [studyProgramId], week);
  if (!fetched.ok) {
    log.error(`Could not refresh ${key}: ${describeEdupageError(fetched.error)}`);
    return;
  }

  const previous = baselines.get(key);
  baselines.set(key, fetched.value);
  cache.set(key, { timetable: fetched.value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (previous === undefined) return;

  const changes = diffTimetables(previous, fetched.value);
  if (changes.length === 0) return;
  log.info(`${key} has ${summarizeChanges(changes)}, notifying ${subscriptions.length} subscriptions`);
  const batch = { studyProgramId, studyProgramName: db.studyPrograms.get(studyProgramId) ?? "", week, changes };
  await Promise.all(subscriptions.map((subscription) => notifySubscriber(transports, subscription, batch)));
}

/** Drops subscriptions with neither a notification nor a re-subscription for a whole TTL. */
async function pruneSubscriptions(): Promise<void> {
  const cutoff = new Date(Date.now() - config.SUBSCRIPTION_TTL_DAYS * 86_400_000);
  const { count } = await prisma.subscription.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  if (count > 0) log.info(`Pruned ${count} subscriptions inactive for ${config.SUBSCRIPTION_TTL_DAYS} days`);
}

async function refreshDatabase(): Promise<void> {
  const loaded = await fetchDatabase(academicYear(currentIsoWeek()));
  if (loaded.ok) {
    if (database?.academicYear !== loaded.value.academicYear) {
      log.info(`Loaded timetable database for ${loaded.value.academicYear}/${loaded.value.academicYear + 1}`);
    }
    database = loaded.value;
  } else {
    log.error(`Could not refresh the timetable database: ${describeEdupageError(loaded.error)}`);
  }
}

/**
 * Refetches the current and next week of every subscribed study program and notifies subscribers of
 * changes. The first run after startup (or after a program gains its first subscriber) only records a
 * baseline, so a restart never produces "everything is new" notifications.
 */
export async function sync(transports: Transports): Promise<void> {
  await refreshDatabase();
  await pruneSubscriptions();
  const db = database;
  if (db === undefined) return;

  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);

  const subscriptions = await prisma.subscription.findMany();
  const byProgram = Map.groupBy(
    subscriptions.filter(
      ({ channel, studyProgramId }) =>
        transportFor(transports, channel) !== undefined && db.studyPrograms.has(studyProgramId),
    ),
    (subscription) => subscription.studyProgramId,
  );
  const thisWeek = currentIsoWeek();
  const targets = [...byProgram].flatMap(([studyProgramId, programSubscriptions]) =>
    [thisWeek, addWeeks(thisWeek, 1)].map((week): Target => ({ studyProgramId, week, subscriptions: programSubscriptions })),
  );

  const monitored = new Set(targets.map(({ studyProgramId, week }) => keyOf(studyProgramId, week)));
  for (const key of baselines.keys()) if (!monitored.has(key)) baselines.delete(key);

  log.debug(`Checking ${targets.length} timetables for ${subscriptions.length} subscriptions`);
  await Promise.all(targets.map((target) => checkForChanges(db, transports, target)));
}
