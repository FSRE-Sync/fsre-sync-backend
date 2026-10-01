import { describe, expect, test } from "bun:test";

import { parseDepartment, parseDirection, parseEventType, parseStudyYear } from "../src/edupage.ts";
import { renderEmail } from "../src/email.ts";
import { fcmMessages } from "../src/fcm.ts";
import {
  academicYear,
  addWeeks,
  diffTimetables,
  emptyTimetable,
  formatIsoWeek,
  mondayOf,
  parseIsoWeek,
  type Change,
  type Department,
  type EventType,
  type StudyYear,
  type TimetableEvent,
} from "../src/model.ts";
import { describeChange, formatTimeSlot, summarizeChanges } from "../src/notify.ts";

describe("study program names", () => {
  test.each<[string, Department | null, StudyYear | null, string | null]>([
    ["Preddiplomski studij računarstva- 1. godina", "COMPUTER_SCIENCE", "FIRST", null],
    ["Preddiplomski studij računarstva-3.godina", "COMPUTER_SCIENCE", "THIRD", null],
    ["Preddiplomski studij strojarstva-1.god", "MECHANICAL_ENGINEERING", "FIRST", null],
    ["Preddiplomski studij strojarstva - 3. godina, modul KiRP", "MECHANICAL_ENGINEERING", "THIRD", "KiRP"],
    ["Diplomski studij elektrotehnike - 1 godina, smjer EE", "ELECTRICAL_ENGINEERING", "FOURTH", "EE"],
    ["Diplomski studij računarstva - 1.god PIiIS", "COMPUTER_SCIENCE", "FOURTH", "PIiIS"],
    ["Diplomski studij računarstva 2.god.-PIIS", "COMPUTER_SCIENCE", "FIFTH", "PIIS"],
    ["Diplomski studij strojarstva - 2.godina, smjer PI", "MECHANICAL_ENGINEERING", "FIFTH", "PI"],
    ["Tečaj bez godine", null, null, null],
  ])("%s", (name, department, year, direction) => {
    expect(parseDepartment(name)).toBe(department);
    expect(parseStudyYear(name)).toBe(year);
    expect(parseDirection(name)).toBe(direction);
  });

  test.each<[string, EventType]>([
    ["Sat: Operacijski sustavi-P", "LECTURE"],
    ["Sat: Obrada deformiranjem - V", "EXERCISE"],
    ["Sat: Algoritmi -P+V ", "LECTURE_AND_EXERCISE"],
    ["Sat: Informacije i komunikacije - Vježbe", "LECTURE"],
  ])("event type of %s", (name, type) => {
    expect(parseEventType(name)).toBe(type);
  });
});

describe("ISO weeks", () => {
  test("parses and validates", () => {
    expect(parseIsoWeek("2026-W53")).toEqual({ ok: true, value: { year: 2026, week: 53 } });
    expect(parseIsoWeek("2027-W53").ok).toBe(false);
    expect(parseIsoWeek("2026-W00").ok).toBe(false);
    expect(parseIsoWeek("2026-41").ok).toBe(false);
  });

  test("week arithmetic crosses year boundaries", () => {
    expect(mondayOf({ year: 2026, week: 1 }).toString()).toBe("2025-12-29");
    expect(formatIsoWeek(addWeeks({ year: 2026, week: 53 }, 1))).toBe("2027-W01");
  });

  test("academic year switches after week 26", () => {
    expect(academicYear({ year: 2026, week: 26 })).toBe(2025);
    expect(academicYear({ year: 2026, week: 27 })).toBe(2026);
  });
});

const event = (overrides: Partial<TimetableEvent> = {}): TimetableEvent => ({
  id: -46,
  department: "COMPUTER_SCIENCE",
  type: "LECTURE",
  year: "SECOND",
  directions: null,
  name: "Sat: Operacijski sustavi-P",
  startDateTime: "2026-10-05T11:15:00Z",
  endDateTime: "2026-10-05T13:00:00Z",
  studyProgramIds: [-54],
  classRoomIds: [-35],
  teacherIds: [-73],
  studyProgramNames: ["Preddiplomski studij računarstva- 2.godina"],
  classRoomNames: ["114"],
  teacherNames: ["Prof. Ivo Ivić"],
  ...overrides,
});

const timetable = (...events: TimetableEvent[]) => ({ ...emptyTimetable(), monday: events });
const tuesday = { startDateTime: "2026-10-06T11:15:00Z", endDateTime: "2026-10-06T13:00:00Z" };

describe("timetable diff", () => {
  test("a rescheduled event is an update", () => {
    const moved = event(tuesday);
    expect(diffTimetables(timetable(event()), timetable(moved))).toEqual([
      { kind: "updated", event: moved, before: event() },
    ]);
  });

  test("pairs updates chronologically and reports the rest as added or removed", () => {
    const exercise = event({ name: "Sat: Operacijski sustavi-V", type: "EXERCISE" });
    const later = event({ startDateTime: "2026-10-07T11:15:00Z", endDateTime: "2026-10-07T13:00:00Z" });
    const changes = diffTimetables(timetable(event(), later), timetable(event(tuesday), exercise));
    expect(changes).toEqual([
      { kind: "added", event: exercise },
      { kind: "updated", event: event(tuesday), before: event() },
      { kind: "removed", event: later },
    ]);
    expect(summarizeChanges(changes)).toBe("1 new, 1 removed and 1 changed classes");
  });

  test("renamed teachers or rooms are not schedule changes", () => {
    expect(diffTimetables(timetable(event()), timetable(event({ teacherNames: ["Izv. prof. Ivo Ivić"] })))).toEqual([]);
  });
});

describe("notification wording", () => {
  test("uses FSRE time unless the subscriber is elsewhere", () => {
    expect(formatTimeSlot(event(), "Europe/Sarajevo")).toBe("Mon 5 Oct, 13:15–15:00");
    expect(formatTimeSlot(event(), "America/New_York")).toBe("Mon 5 Oct, 07:15–09:00 GMT-4");
  });

  test("describes only what changed about an update", () => {
    const moved = event({ ...tuesday, classRoomNames: ["201"] });
    expect(describeChange({ kind: "updated", event: moved, before: event() }, "Europe/Sarajevo")).toEqual({
      title: "Class changed: Sat: Operacijski sustavi-P",
      body: "Mon 5 Oct, 13:15–15:00 → Tue 6 Oct, 13:15–15:00 · 114 → 201 · Prof. Ivo Ivić",
    });
    expect(describeChange({ kind: "removed", event: event() }, "Europe/Sarajevo").title).toBe(
      "Class removed: Sat: Operacijski sustavi-P",
    );
  });
});

const recipient = { subscriptionId: "id", address: "a@b.c", timeZone: "Europe/Sarajevo" };
const batchOf = (changes: Change[]) => ({
  studyProgramId: -54,
  studyProgramName: "Računarstvo <2>",
  week: { year: 2026, week: 41 },
  changes,
});

describe("push notifications", () => {
  test("one per change, grouped by study program", () => {
    const changes: Change[] = [
      { kind: "added", event: event({ name: "Sat: Algoritmi-V" }) },
      { kind: "updated", event: event(tuesday), before: event() },
    ];
    const [added, updated, ...rest] = fcmMessages(recipient, batchOf(changes));
    expect(rest).toEqual([]);
    expect(added).toMatchObject({ title: "New class: Sat: Algoritmi-V", group: "timetable:-54" });
    expect(added?.data).toMatchObject({
      change: "added",
      newTimetableEvents: JSON.stringify([changes[0]?.event]),
      removedTimetableEvents: "[]",
      timetableKey: '{"studyProgramId":-54,"yearWeek":"2026-W41"}',
    });
    expect(updated?.data).toMatchObject({
      newTimetableEvents: JSON.stringify([event(tuesday)]),
      removedTimetableEvents: JSON.stringify([event()]),
    });
    expect(added?.tag).not.toBe(updated?.tag);
    const resentTags = fcmMessages(recipient, batchOf(changes)).map(({ tag }) => tag);
    expect(resentTags).toEqual([added?.tag ?? "", updated?.tag ?? ""]);
  });

  test("collapses large batches into one summary without oversized payloads", () => {
    const changes = Array.from({ length: 20 }, (_, i): Change => ({ kind: "added", event: event({ id: i }) }));
    const messages = fcmMessages(recipient, batchOf(changes));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("20 new classes in week 41. Open the timetable for details.");
    expect(messages[0]?.data["newTimetableEvents"]).toBe("[]");
  });
});

describe("email", () => {
  test("lists every change in the subscriber's time zone, HTML-escaped", () => {
    const mail = renderEmail(
      { ...recipient, timeZone: "Asia/Tokyo" },
      batchOf([{ kind: "added", event: event({ name: "Sat: <script>" }) }]),
      "https://example.com/api/messaging/unsubscribe/id",
    );
    expect(mail.subject).toBe("Timetable changes: Računarstvo <2>, week of 5 Oct 2026");
    expect(mail.text).toContain("New class: Sat: <script>\n  Mon 5 Oct, 20:15–22:00 GMT+9 · 114 · Prof. Ivo Ivić");
    expect(mail.text).toContain("Times are shown in Asia/Tokyo.");
    expect(mail.html).toContain("Sat: &#60;script&#62;");
    expect(mail.html).not.toContain("<script>");
  });
});
