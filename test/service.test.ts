import { beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/api.ts";
import { migrate, prisma } from "../src/db.ts";
import { currentIsoWeek, formatIsoWeek, mondayOf, Timetable, type Channel } from "../src/model.ts";
import { describeChange, type ChangeBatch, type Recipient, type Transport } from "../src/notify.ts";
import { err, ok } from "../src/result.ts";
import { sync } from "../src/sync.ts";
import { edupage } from "./fake-edupage.ts";

const monday = mondayOf(currentIsoWeek());
const tuesday = monday.add({ days: 1 }).toString();

const item = (date: string, starttime: string, endtime: string, name: string) => ({
  type: "event",
  name,
  date,
  starttime,
  endtime,
  subjectid: "-10",
  classids: ["-54"],
  classroomids: ["-5"],
  teacherids: ["-1", ""],
  groupnames: [""],
  eventid: crypto.randomUUID(),
});

const lecture = item(monday.toString(), "08:15", "10:00", "Sat: Operacijski sustavi-P");

const deliveries: { channel: Channel; recipient: Recipient; batch: ChangeBatch }[] = [];
const fakeTransport = (channel: Channel): Transport => ({
  channel,
  verify: (address) =>
    Promise.resolve(address === "malformed" ? err({ kind: "invalid-address", message: "bad token" }) : ok(undefined)),
  deliver: (recipient, batch) => {
    deliveries.push({ channel, recipient, batch });
    const gone = recipient.address === "uninstalled-app";
    return Promise.resolve(gone ? err({ kind: "invalid-address", message: "unregistered" }) : ok(undefined));
  },
});
const transports = new Map([
  ["fcm", fakeTransport("fcm")],
  ["email", fakeTransport("email")],
] as const);
const app = createApp(transports);

const post = (path: string, body: object, target = app) =>
  target.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  await migrate();
  edupage.items = [lecture, { ...lecture, eventid: "same event, other group" }, { type: "card" }];
  await sync(transports);
});

describe("API", () => {
  test("serves the parsed timetable database", async () => {
    const response = await app.request("/api/timetable-database");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      studyPrograms: [{ id: -54, studyYear: "SECOND", department: "COMPUTER_SCIENCE", direction: null }],
      teachers: [{ id: -1, name: "Prof. Ivo Ivić" }],
      eventTypes: [{ id: "ttcancel", name: "Otkazana nastava" }],
    });
  });

  test("serves enriched, deduplicated timetables", async () => {
    const response = await app.request(`/api/timetable?studyProgram=-54&isoWeek=${formatIsoWeek(currentIsoWeek())}`);
    expect(response.status).toBe(200);
    const timetable = Timetable.parse(await response.json());
    expect(timetable.monday).toHaveLength(1);
    expect(timetable.monday[0]).toMatchObject({
      id: -10,
      type: "LECTURE",
      year: "SECOND",
      startDateTime: `${monday.toString()}T06:15:00Z`,
      teacherIds: [-1],
      teacherNames: ["Prof. Ivo Ivić"],
      classRoomNames: ["115"],
    });
  });

  test("subscribes each destination, updates on resubscription and rejects invalid requests", async () => {
    const both = await post("/api/messaging/subscribe", {
      fcmToken: "phone",
      email: "Student@Example.com",
      studyProgramId: -54,
      timeZone: "America/New_York",
    });
    expect(both.status).toBe(200);
    expect(await both.json()).toMatchObject([
      { channel: "fcm", address: "phone", timeZone: "America/New_York" },
      { channel: "email", address: "student@example.com" },
    ]);

    const status = async (body: object) => (await post("/api/messaging/subscribe", body)).status;
    expect(await status({ fcmToken: "phone", studyProgramId: -54, timeZone: "Asia/Tokyo" })).toBe(200);
    const phone = await prisma.subscription.findMany({ where: { address: "phone" } });
    expect(phone.map(({ timeZone }) => timeZone)).toEqual(["Asia/Tokyo"]);
    const mixed = { email: "student@example.com", fcmToken: "tablet", studyProgramId: -54, timeZone: "America/New_York" };
    expect(await status(mixed)).toBe(200);
    expect(await prisma.subscription.count({ where: { address: { in: ["student@example.com", "tablet"] } } })).toBe(2);
    expect(await status({ fcmToken: "phone", studyProgramId: -99 })).toBe(400);
    expect(await status({ studyProgramId: -54 })).toBe(400);
    expect(await status({ email: "not an email", studyProgramId: -54 })).toBe(400);
    expect(await status({ fcmToken: "tablet", studyProgramId: -54, timeZone: "Mars/Olympus" })).toBe(400);
    expect(await status({ fcmToken: "malformed", studyProgramId: -54 })).toBe(400);

    expect(await status({ fcmToken: "tablet", studyProgramId: -54 })).toBe(200);
    expect((await prisma.subscription.findFirst({ where: { address: "tablet" } }))?.timeZone).toBe("Europe/Sarajevo");
    expect((await post("/api/messaging/unsubscribe", { fcmToken: "tablet", studyProgramId: -54 })).status).toBe(200);
    expect(await prisma.subscription.count({ where: { address: "tablet" } })).toBe(0);
  });

  test("without transports it only serves timetables", async () => {
    const proxy = createApp(new Map());
    expect((await post("/api/messaging/subscribe", { fcmToken: "x", studyProgramId: -54 }, proxy)).status).toBe(503);
    expect((await proxy.request("/api/timetable-database")).status).toBe(200);
  });

  test("email unsubscribe links confirm before deleting", async () => {
    const { id } = await prisma.subscription.create({
      data: { channel: "email", address: "leaving@example.com", studyProgramId: -54, timeZone: "UTC", deviceInfo: "" },
    });
    expect(await (await app.request(`/api/messaging/unsubscribe/${id}`)).text()).toContain('<form method="post">');
    expect(await prisma.subscription.count({ where: { id } })).toBe(1);
    expect((await app.request(`/api/messaging/unsubscribe/${id}`, { method: "POST" })).status).toBe(200);
    expect(await prisma.subscription.count({ where: { id } })).toBe(0);
  });
});

describe("sync", () => {
  test("prunes subscriptions without notifications or resubscriptions for a year", async () => {
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    const data = { channel: "fcm", studyProgramId: -54, timeZone: "UTC", deviceInfo: "", createdAt: longAgo };
    await prisma.subscription.createMany({
      data: [
        { ...data, address: "spam", updatedAt: longAgo },
        { ...data, address: "quiet", updatedAt: longAgo, lastNotifiedAt: longAgo },
        { ...data, address: "resubscribed", updatedAt: longAgo },
      ],
    });
    await post("/api/messaging/subscribe", { fcmToken: "resubscribed", studyProgramId: -54 });
    await sync(transports);
    const addresses = (await prisma.subscription.findMany({ where: { createdAt: longAgo } })).map((s) => s.address);
    expect(addresses).toEqual(["resubscribed"]);
    await prisma.subscription.deleteMany({ where: { address: "resubscribed" } });
  });

  test("records a baseline first, then sends each subscriber the changes", async () => {
    await post("/api/messaging/subscribe", { fcmToken: "uninstalled-app", studyProgramId: -54 });
    await sync(transports);
    expect(deliveries).toHaveLength(0);

    const exercise = item(monday.toString(), "12:15", "14:00", "Sat: Operacijski sustavi-V");
    edupage.items = [{ ...lecture, date: tuesday }, exercise];
    await sync(transports);

    expect(deliveries.map(({ recipient }) => recipient.address).toSorted()).toEqual([
      "phone",
      "student@example.com",
      "uninstalled-app",
    ]);
    const { batch, recipient } = deliveries.find(({ channel }) => channel === "email") ?? {};
    expect(recipient?.timeZone).toBe("America/New_York");
    expect(batch?.changes.map(({ kind, event }) => [kind, event.name])).toEqual([
      ["added", "Sat: Operacijski sustavi-V"],
      ["updated", "Sat: Operacijski sustavi-P"],
    ]);
    const updated = batch?.changes[1];
    if (updated !== undefined) expect(describeChange(updated, "Europe/Sarajevo").body).toContain(" → ");

    const subscriptions = await prisma.subscription.findMany({ orderBy: { channel: "asc" } });
    expect(subscriptions.map(({ address }) => address)).toEqual(["student@example.com", "phone"]);
    expect(subscriptions.every(({ lastNotifiedAt }) => lastNotifiedAt instanceof Date)).toBe(true);

    await sync(transports);
    expect(deliveries).toHaveLength(3);
  });
});
