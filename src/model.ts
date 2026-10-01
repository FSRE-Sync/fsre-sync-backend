import { z } from "@hono/zod-openapi";

import { err, errorMessage, fromThrowable, ok, type Result } from "./result.ts";

export const TIME_ZONE = "Europe/Sarajevo";

// ---- Timetable database ------------------------------------------------------------------

// Enums are named schemas so generated clients share one type per enum. Where they are nullable, use
// `orNull`: `.nullable()` on a named schema loses the null in the generated OpenAPI document.
const orNull = <Schema extends z.ZodType>(schema: Schema) => z.union([schema, z.null()]);

export const Department = z
  .enum(["COMPUTER_SCIENCE", "ELECTRICAL_ENGINEERING", "MECHANICAL_ENGINEERING"])
  .openapi("Department");
export type Department = z.infer<typeof Department>;

export const EventType = z.enum(["LECTURE", "EXERCISE", "LECTURE_AND_EXERCISE", "LABS"]).openapi("EventType");
export type EventType = z.infer<typeof EventType>;

export const StudyYear = z.enum(["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH"]).openapi("StudyYear");
export type StudyYear = z.infer<typeof StudyYear>;

const idNamePair = <Id extends z.ZodType>(id: Id, name: string) =>
  z.object({ id, name: z.string() }).openapi(name);

const NumericIdName = idNamePair(z.int(), "IdNamePairLong");
const TextIdName = idNamePair(z.string(), "IdNamePairString");

export const StudyProgram = z
  .object({
    id: z.int().openapi({ example: -54 }),
    name: z.string().openapi({ example: "Preddiplomski studij računarstva- 1. godina" }),
    studyYear: StudyYear,
    department: Department,
    direction: z.string().nullable(),
  })
  .openapi("StudyProgram");
export type StudyProgram = z.infer<typeof StudyProgram>;

export const TimetableDatabase = z
  .object({
    studyPrograms: z.array(StudyProgram),
    classRooms: z.array(NumericIdName),
    eventTypes: z.array(TextIdName),
    subjects: z.array(NumericIdName),
    teachers: z.array(NumericIdName),
  })
  .openapi("TimetableDatabase");
export type TimetableDatabase = z.infer<typeof TimetableDatabase>;

// ---- Timetable ---------------------------------------------------------------------------

export const TimetableEvent = z
  .object({
    id: z.int().openapi({ description: "Edupage subject ID" }),
    department: orNull(Department),
    type: EventType,
    year: orNull(StudyYear),
    directions: z.array(z.string()).nullable(),
    name: z.string(),
    startDateTime: z.iso.datetime().openapi({ example: "2026-03-09T07:30:00Z" }),
    endDateTime: z.iso.datetime().openapi({ example: "2026-03-09T09:00:00Z" }),
    studyProgramIds: z.array(z.int()),
    classRoomIds: z.array(z.int()),
    teacherIds: z.array(z.int()),
    studyProgramNames: z.array(z.string().nullable()),
    classRoomNames: z.array(z.string().nullable()),
    teacherNames: z.array(z.string().nullable()),
  })
  .openapi("TimetableEvent");
export type TimetableEvent = z.infer<typeof TimetableEvent>;

export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Day = (typeof DAYS)[number];

const DayEvents = z.array(TimetableEvent);
export const Timetable = z
  .object({
    monday: DayEvents,
    tuesday: DayEvents,
    wednesday: DayEvents,
    thursday: DayEvents,
    friday: DayEvents,
    saturday: DayEvents,
    sunday: DayEvents,
  })
  .openapi("Timetable");
export type Timetable = z.infer<typeof Timetable>;

export const emptyTimetable = (): Timetable => ({
  monday: [],
  tuesday: [],
  wednesday: [],
  thursday: [],
  friday: [],
  saturday: [],
  sunday: [],
});

export const allEvents = (timetable: Timetable): TimetableEvent[] => DAYS.flatMap((day) => timetable[day]);

/** Fields that describe the real-world event; everything else is derived from these + the database. */
export const eventIdentity = (e: TimetableEvent): string =>
  JSON.stringify([e.id, e.name, e.startDateTime, e.endDateTime, e.studyProgramIds, e.classRoomIds, e.teacherIds]);

export const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => [
  ...new Map(items.map((item) => [key(item), item] as const)).values(),
];

/** `event` is always the event as it is now (or was, for removals). */
export type Change =
  | { readonly kind: "added"; readonly event: TimetableEvent }
  | { readonly kind: "removed"; readonly event: TimetableEvent }
  | { readonly kind: "updated"; readonly event: TimetableEvent; readonly before: TimetableEvent };

export const chronologically = (a: TimetableEvent, b: TimetableEvent): number =>
  a.startDateTime.localeCompare(b.startDateTime);

const subjectOf = (e: TimetableEvent): string => JSON.stringify([e.id, e.name, e.type]);

/**
 * Events that vanished and appeared with the same subject and type are reported as updates
 * (moved, other room, other teacher, …), paired up in chronological order.
 */
export function diffTimetables(before: Timetable, after: Timetable): Change[] {
  const previous = uniqueBy(allEvents(before), eventIdentity).toSorted(chronologically);
  const next = uniqueBy(allEvents(after), eventIdentity).toSorted(chronologically);
  const previousKeys = new Set(previous.map(eventIdentity));
  const nextKeys = new Set(next.map(eventIdentity));
  const removed = Map.groupBy(previous.filter((e) => !nextKeys.has(eventIdentity(e))), subjectOf);
  const added = Map.groupBy(next.filter((e) => !previousKeys.has(eventIdentity(e))), subjectOf);

  const changes: Change[] = [];
  for (const key of new Set([...removed.keys(), ...added.keys()])) {
    const gone = removed.get(key) ?? [];
    const appeared = added.get(key) ?? [];
    for (let i = 0; i < Math.max(gone.length, appeared.length); i++) {
      const [was, is] = [gone[i], appeared[i]];
      if (was !== undefined && is !== undefined) changes.push({ kind: "updated", event: is, before: was });
      else if (is !== undefined) changes.push({ kind: "added", event: is });
      else if (was !== undefined) changes.push({ kind: "removed", event: was });
    }
  }
  return changes.toSorted((a, b) => chronologically(a.event, b.event));
}

// ---- ISO weeks ---------------------------------------------------------------------------

export type IsoWeek = { readonly year: number; readonly week: number };

export const formatIsoWeek = ({ year, week }: IsoWeek): string => `${year}-W${String(week).padStart(2, "0")}`;

export function isoWeekOf(date: Temporal.PlainDate): IsoWeek {
  const { yearOfWeek, weekOfYear } = date;
  if (yearOfWeek === undefined || weekOfYear === undefined) {
    throw new Error(`The ${date.calendarId} calendar has no ISO weeks`);
  }
  return { year: yearOfWeek, week: weekOfYear };
}

export function mondayOf({ year, week }: IsoWeek): Temporal.PlainDate {
  const january4th = Temporal.PlainDate.from({ year, month: 1, day: 4 });
  return january4th.subtract({ days: january4th.dayOfWeek - 1 }).add({ weeks: week - 1 });
}

export const addWeeks = (week: IsoWeek, weeks: number): IsoWeek => isoWeekOf(mondayOf(week).add({ weeks }));

export const currentIsoWeek = (): IsoWeek => isoWeekOf(Temporal.Now.plainDateISO(TIME_ZONE));

/** FSRE academic years start in autumn: weeks 1–26 belong to the year that started the previous autumn. */
export const academicYear = ({ year, week }: IsoWeek): number => (week <= 26 ? year - 1 : year);

export function parseIsoWeek(value: string): Result<IsoWeek, string> {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return err(`"${value}" is not an ISO week (expected e.g. 2024-W09)`);
  const week = { year: Number(match[1]), week: Number(match[2]) };
  if (week.week < 1 || formatIsoWeek(isoWeekOf(mondayOf(week))) !== value) {
    return err(`${value} does not exist`);
  }
  return ok(week);
}

export const IsoWeekParam = z
  .string()
  .transform((value, ctx) => {
    const parsed = parseIsoWeek(value);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  })
  .openapi({ description: "ISO week", example: "2024-W09" });

// ---- Errors & messaging ------------------------------------------------------------------

export const FsreError = z
  .object({
    status: z.int().openapi({ example: 502 }),
    error: z.string().openapi({ example: "Bad Gateway" }),
    message: z.string(),
    details: z.string().optional(),
  })
  .openapi("FsreError");
export type FsreError = z.infer<typeof FsreError>;

export const CHANNELS = ["fcm", "email"] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (value: string): value is Channel => CHANNELS.some((channel) => channel === value);

export const isTimeZone = (value: string): boolean =>
  fromThrowable(() => Temporal.Now.zonedDateTimeISO(value), errorMessage).ok;

const Destinations = z.object({
  fcmToken: z.string().min(1).optional().openapi({ description: "Firebase Cloud Messaging registration token" }),
  email: z.email().toLowerCase().optional(),
  studyProgramId: z.int().openapi({ example: -54 }),
});
const hasDestination = (body: z.output<typeof Destinations>): boolean =>
  body.fcmToken !== undefined || body.email !== undefined;
const destinationRequired = { message: "Provide an fcmToken, an email or both" };

export const SubscribeRequest = Destinations.extend({
  // Optional rather than `.default()`: generators turn defaulted properties into required ones.
  timeZone: z
    .string()
    .refine(isTimeZone, "Unknown IANA time zone")
    .optional()
    .openapi({
      description: `IANA time zone that times in notifications are shown in (default ${TIME_ZONE})`,
      example: "Europe/Berlin",
    }),
})
  .refine(hasDestination, destinationRequired)
  .openapi("MessagingSubscribeDto");

export const UnsubscribeRequest = Destinations.refine(hasDestination, destinationRequired).openapi(
  "MessagingUnsubscribeDto",
);

export const Subscription = z
  .object({
    id: z.uuid(),
    channel: z.enum(CHANNELS),
    address: z.string(),
    studyProgramId: z.int(),
    timeZone: z.string(),
    createdAt: z.iso.datetime(),
    lastNotifiedAt: z.iso.datetime().nullable(),
  })
  .openapi("MessagingSubscription");
