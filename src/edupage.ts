import { z } from "zod";

import { config, log } from "./config.ts";
import {
  academicYear,
  DAYS,
  emptyTimetable,
  eventIdentity,
  mondayOf,
  TIME_ZONE,
  uniqueBy,
  type Day,
  type Department,
  type EventType,
  type IsoWeek,
  type StudyProgram,
  type StudyYear,
  type Timetable,
  type TimetableDatabase,
  type TimetableEvent,
} from "./model.ts";
import { collect, err, errorMessage, fromPromise, ok, parseJson, type Result } from "./result.ts";

export type EdupageError =
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "invalid-response"; readonly message: string };

export function describeEdupageError(error: EdupageError): string {
  switch (error.kind) {
    case "network":
      return `Edupage is unreachable: ${error.message}`;
    case "http":
      return `Edupage responded with HTTP ${error.status}`;
    case "invalid-response":
      return `Edupage sent an unexpected response: ${error.message}`;
  }
}

const networkError = (cause: unknown): EdupageError => ({ kind: "network", message: errorMessage(cause) });

/** Edupage has no public API; these are the RPC endpoints its own web UI calls. */
async function rpc<Schema extends z.ZodType>(
  path: string,
  args: readonly unknown[],
  schema: Schema,
): Promise<Result<z.output<Schema>, EdupageError>> {
  const response = await fromPromise(
    fetch(new URL(path, config.EDUPAGE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ __args: args, __gsh: "00000000" }),
      signal: AbortSignal.timeout(30_000),
    }),
    networkError,
  );
  if (!response.ok) return response;
  if (!response.value.ok) return err({ kind: "http", status: response.value.status });

  const text = await fromPromise(response.value.text(), networkError);
  if (!text.ok) return text;
  const json = parseJson(text.value);
  if (!json.ok) return err({ kind: "invalid-response", message: json.error });
  const parsed = schema.safeParse(json.value);
  return parsed.success ? ok(parsed.data) : err({ kind: "invalid-response", message: z.prettifyError(parsed.error) });
}

// ---- Wire format ---------------------------------------------------------------------------

const NumericId = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number);
const IdList = z
  .array(z.string())
  .transform((ids) => ids.filter((id) => id !== ""))
  .pipe(z.array(NumericId));

const rows = <Id extends z.ZodType>(id: Id) =>
  z.array(z.object({ id, name: z.string().default(""), short: z.string().default("") }));

const DatabaseResponse = z.object({
  r: z.object({
    tables: z
      .array(z.object({ id: z.string(), data_rows: z.array(z.unknown()) }))
      .transform((tables) => Object.fromEntries(tables.map((table) => [table.id, table.data_rows])))
      .pipe(
        z.object({
          teachers: rows(NumericId),
          subjects: rows(NumericId),
          classrooms: rows(NumericId),
          classes: rows(NumericId),
          event_types: rows(z.string()),
        }),
      ),
  }),
});

const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const EventItem = z.object({
  type: z.literal("event"),
  name: z.string(),
  date: z.iso.date(),
  starttime: LocalTime,
  endtime: LocalTime,
  subjectid: NumericId,
  classids: IdList,
  classroomids: IdList,
  teacherids: IdList,
});
type EventItem = z.output<typeof EventItem>;

const TimetableResponse = z.object({
  r: z.object({
    ttitems: z
      .array(z.looseObject({ type: z.string() }))
      .transform((items) => items.filter((item) => item.type === "event"))
      .pipe(z.array(EventItem)),
  }),
});

// ---- Croatian study program / subject name heuristics ----------------------------------------

export function parseDepartment(studyProgramName: string): Department | null {
  const name = studyProgramName.toLowerCase();
  if (name.includes("računarstv")) return "COMPUTER_SCIENCE";
  if (name.includes("elektrotehnik")) return "ELECTRICAL_ENGINEERING";
  if (name.includes("strojarstv")) return "MECHANICAL_ENGINEERING";
  return null;
}

/** Graduate programs restart counting at "1. godina", which is the 4th year overall. */
export function parseStudyYear(studyProgramName: string): StudyYear | null {
  const undergraduate = studyProgramName.toLowerCase().includes("preddiplomsk");
  switch (/.*(\d)\.? ?god/.exec(studyProgramName)?.[1]) {
    case "1":
      return undergraduate ? "FIRST" : "FOURTH";
    case "2":
      return undergraduate ? "SECOND" : "FIFTH";
    case "3":
      return "THIRD";
    case "4":
      return "FOURTH";
    case "5":
      return "FIFTH";
    case undefined:
    default:
      return null;
  }
}

export function parseDirection(studyProgramName: string): string | null {
  const raw = /^.+(?:godina, |god |god\.)(?:smjer|modul)?(.+)$/.exec(studyProgramName)?.[1] ?? "";
  const direction = raw.replaceAll(/[^a-zA-Z0-9 ]/g, "").trim();
  return direction === "" ? null : direction;
}

export function parseEventType(subjectName: string): EventType {
  switch (/-\s*(P\+V|V\+P|P|V)\s*$/.exec(subjectName)?.[1]) {
    case "V":
      return "EXERCISE";
    case "P+V":
    case "V+P":
      return "LECTURE_AND_EXERCISE";
    case undefined:
    default:
      return "LECTURE";
  }
}

// ---- Timetable database ----------------------------------------------------------------------

export type Database = {
  readonly academicYear: number;
  readonly data: TimetableDatabase;
  readonly studyPrograms: ReadonlyMap<number, string>;
  readonly classRooms: ReadonlyMap<number, string>;
  readonly teachers: ReadonlyMap<number, string>;
};

type IdNamePair<Id> = { readonly id: Id; readonly name: string };

const pairsBy =
  (column: "name" | "short") =>
  <Id>(row: { id: Id; name: string; short: string }): IdNamePair<Id> => ({ id: row.id, name: row[column] });

const nameLookup = <Id>(pairs: readonly IdNamePair<Id>[]): ReadonlyMap<Id, string> =>
  new Map(pairs.map(({ id, name }) => [id, name]));

function toStudyProgram({ id, name }: IdNamePair<number>): StudyProgram | null {
  const studyYear = parseStudyYear(name);
  const department = parseDepartment(name);
  if (studyYear !== null && department !== null) {
    return { id, name, studyYear, department, direction: parseDirection(name) };
  }
  log.warn(`Ignoring study program "${name}": unknown ${studyYear === null ? "study year" : "department"}`);
  return null;
}

export async function fetchDatabase(year: number): Promise<Result<Database, EdupageError>> {
  const response = await rpc(
    "/rpr/server/maindbi.js?__func=mainDBIAccessor",
    [
      null,
      year,
      {},
      {
        needed_part: {
          classes: ["short", "name"],
          classrooms: ["short"],
          event_types: ["name"],
          subjects: ["short", "name"],
          teachers: ["short"],
        },
        op: "fetch",
      },
    ],
    DatabaseResponse,
  );
  if (!response.ok) return response;

  const { teachers, subjects, classrooms, classes, event_types } = response.value.r.tables;
  const data: TimetableDatabase = {
    studyPrograms: classes.map(pairsBy("name")).flatMap((pair) => toStudyProgram(pair) ?? []),
    classRooms: classrooms.map(pairsBy("short")),
    eventTypes: event_types.map(pairsBy("name")),
    subjects: subjects.map(pairsBy("name")),
    teachers: teachers.map(pairsBy("short")),
  };
  return ok({
    academicYear: year,
    data,
    studyPrograms: nameLookup(data.studyPrograms),
    classRooms: nameLookup(data.classRooms),
    teachers: nameLookup(data.teachers),
  });
}

// ---- Timetables ------------------------------------------------------------------------------

function dayOf(date: Temporal.PlainDate): Day {
  const day = DAYS[date.dayOfWeek - 1];
  if (day === undefined) throw new Error(`Invalid ISO day of week ${date.dayOfWeek}`);
  return day;
}

const lookup = <Id>(names: ReadonlyMap<Id, string>, ids: readonly Id[]): (string | null)[] =>
  ids.map((id) => names.get(id) ?? null);

function toEvent(db: Database, item: EventItem): { day: Day; event: TimetableEvent } {
  const date = Temporal.PlainDate.from(item.date);
  const utc = (time: string): string =>
    date.toPlainDateTime(Temporal.PlainTime.from(time)).toZonedDateTime(TIME_ZONE).toInstant().toString();

  const studyProgramNames = lookup(db.studyPrograms, item.classids);
  const knownProgramNames = studyProgramNames.filter((name) => name !== null);
  const primaryProgram = knownProgramNames[0];
  const directions = [...new Set(knownProgramNames.flatMap((name) => parseDirection(name) ?? []))];

  return {
    day: dayOf(date),
    event: {
      id: item.subjectid,
      department: primaryProgram === undefined ? null : parseDepartment(primaryProgram),
      type: parseEventType(item.name),
      year: primaryProgram === undefined ? null : parseStudyYear(primaryProgram),
      directions: directions.length > 0 ? directions : null,
      name: item.name,
      startDateTime: utc(item.starttime),
      endDateTime: utc(item.endtime),
      studyProgramIds: item.classids,
      classRoomIds: item.classroomids,
      teacherIds: item.teacherids,
      studyProgramNames,
      classRoomNames: lookup(db.classRooms, item.classroomids),
      teacherNames: lookup(db.teachers, item.teacherids),
    },
  };
}

/** Fetches and merges the timetables of the given study programs; shared events appear once. */
export async function fetchTimetable(
  db: Database,
  studyProgramIds: readonly number[],
  week: IsoWeek,
): Promise<Result<Timetable, EdupageError>> {
  const monday = mondayOf(week);
  const responses = collect(
    await Promise.all(
      studyProgramIds.map((id) =>
        rpc(
          "/timetable/server/currenttt.js?__func=curentttGetData",
          [
            null,
            {
              datefrom: monday.toString(),
              dateto: monday.add({ days: 6 }).toString(),
              id: String(id),
              table: "classes",
              year: academicYear(week),
            },
          ],
          TimetableResponse,
        ),
      ),
    ),
  );
  if (!responses.ok) return responses;

  const events = responses.value.flatMap((response) => response.r.ttitems).map((item) => toEvent(db, item));
  const timetable = emptyTimetable();
  for (const { day, event } of uniqueBy(events, (entry) => eventIdentity(entry.event))) {
    timetable[day].push(event);
  }
  return ok(timetable);
}
