import { log } from "./config.ts";
import { prisma } from "./db.ts";
import type { Subscription } from "./generated/prisma/client.ts";
import { isChannel, TIME_ZONE, type Change, type Channel, type IsoWeek, type TimetableEvent } from "./model.ts";
import type { Result } from "./result.ts";

// ---- Transports ------------------------------------------------------------------------------
// A transport delivers change notifications over one channel. Adding a channel means adding it to
// `CHANNELS`, writing a `Transport` and registering it in `createTransports` (src/index.ts).

export type Recipient = { readonly subscriptionId: string; readonly address: string; readonly timeZone: string };

/** Everything that changed in one study program's timetable for one week. */
export type ChangeBatch = {
  readonly studyProgramId: number;
  readonly studyProgramName: string;
  readonly week: IsoWeek;
  readonly changes: readonly Change[];
};

export type DeliveryError =
  /** The address will never work again (uninstalled app, rejected mailbox); the subscription is dropped. */
  | { readonly kind: "invalid-address"; readonly message: string }
  | { readonly kind: "failed"; readonly retryable: boolean; readonly message: string };

export type Transport = {
  readonly channel: Channel;
  /** Checks that an address can receive messages before it is stored. */
  readonly verify: (address: string) => Promise<Result<void, DeliveryError>>;
  readonly deliver: (recipient: Recipient, batch: ChangeBatch) => Promise<Result<void, DeliveryError>>;
};

export type Transports = ReadonlyMap<Channel, Transport>;

export const isTransient = (error: DeliveryError): boolean => error.kind === "failed" && error.retryable;

export const transportFor = (transports: Transports, channel: string): Transport | undefined =>
  isChannel(channel) ? transports.get(channel) : undefined;

export async function notifySubscriber(transports: Transports, subscription: Subscription, batch: ChangeBatch) {
  const { id, address, timeZone, channel } = subscription;
  const transport = transportFor(transports, channel);
  if (transport === undefined) return;

  const delivered = await transport.deliver({ subscriptionId: id, address, timeZone }, batch);
  if (delivered.ok) {
    await prisma.subscription.update({ where: { id }, data: { lastNotifiedAt: new Date() } });
    return;
  }
  switch (delivered.error.kind) {
    case "invalid-address":
      log.info(`Removing ${channel} subscription ${id}: ${delivered.error.message}`);
      await prisma.subscription.delete({ where: { id } });
      return;
    case "failed":
      log.error(`Could not notify ${channel} subscription ${id}: ${delivered.error.message}`);
      return;
  }
}

// ---- Shared wording ----------------------------------------------------------------------------

/** "Mon 5 Oct, 08:15–10:00", with the zone appended for anyone not on FSRE's local time. */
export function formatTimeSlot(event: TimetableEvent, timeZone: string): string {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === TIME_ZONE ? {} : { timeZoneName: "short" }),
  });
  return format.formatRange(new Date(event.startDateTime), new Date(event.endDateTime));
}

const names = (values: readonly (string | null)[]): string => values.filter((value) => value !== null).join(", ");

/** Details of an event, or of what changed about it: "Mon 5 Oct, 08:15–10:00 · 115 → 201 · Prof. Ivić" */
function describeDetails(change: Change, timeZone: string): string {
  const parts: ((event: TimetableEvent) => string)[] = [
    (event) => formatTimeSlot(event, timeZone),
    (event) => names(event.classRoomNames),
    (event) => names(event.teacherNames),
  ];
  return parts
    .map((part) => {
      const now = part(change.event);
      const before = change.kind === "updated" ? part(change.before) : now;
      return before === now ? now : `${before || "?"} → ${now || "?"}`;
    })
    .filter((part) => part !== "")
    .join(" · ");
}

const HEADINGS = { added: "New class", removed: "Class removed", updated: "Class changed" } as const satisfies Record<
  Change["kind"],
  string
>;

export const describeChange = (change: Change, timeZone: string): { title: string; body: string } => ({
  title: `${HEADINGS[change.kind]}: ${change.event.name}`,
  body: describeDetails(change, timeZone),
});

/** "3 new, 2 removed and 1 changed class" */
export function summarizeChanges(changes: readonly Change[]): string {
  const counts = (["added", "removed", "updated"] as const)
    .map((kind) => ({ kind, n: changes.filter((change) => change.kind === kind).length }))
    .filter(({ n }) => n > 0)
    .map(({ kind, n }) => `${n} ${{ added: "new", removed: "removed", updated: "changed" }[kind]}`);
  const list = counts.length > 1 ? `${counts.slice(0, -1).join(", ")} and ${counts.at(-1) ?? ""}` : (counts[0] ?? "0");
  return `${list} ${changes.length === 1 ? "class" : "classes"}`;
}
