import { z } from "zod";

import { eventIdentity, formatIsoWeek, type Change } from "./model.ts";
import {
  describeChange,
  isTransient,
  summarizeChanges,
  type ChangeBatch,
  type DeliveryError,
  type Recipient,
  type Transport,
} from "./notify.ts";
import { err, errorMessage, fromPromise, ok, parseJson, retry, type Result } from "./result.ts";

// Firebase Cloud Messaging over its HTTP v1 API (what firebase-admin wraps), authenticated with a
// service account through Google's OAuth 2.0 JWT bearer flow.
// https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages

const ServiceAccount = z.object({
  project_id: z.string(),
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.url().default("https://oauth2.googleapis.com/token"),
});

const TokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });

const ErrorResponse = z.object({
  error: z.object({
    message: z.string(),
    details: z.array(z.looseObject({ errorCode: z.string().optional() })).default([]),
  }),
});

/** `status` is undefined when the server could not be reached at all. */
type Failure = { readonly status: number | undefined; readonly code: string | undefined; readonly message: string };

const networkFailure = (cause: unknown): Failure => ({ status: undefined, code: undefined, message: errorMessage(cause) });

async function post<Schema extends z.ZodType>(
  url: string,
  init: { headers?: Record<string, string>; body: string | URLSearchParams },
  schema: Schema,
): Promise<Result<z.output<Schema>, Failure>> {
  const response = await fromPromise(
    fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(15_000) }),
    networkFailure,
  );
  if (!response.ok) return response;
  const text = await fromPromise(response.value.text(), networkFailure);
  if (!text.ok) return text;

  const json = parseJson(text.value);
  const { status } = response.value;
  if (!response.value.ok) {
    const failure = ErrorResponse.safeParse(json.ok ? json.value : null);
    if (!failure.success) return err({ status, code: undefined, message: text.value.slice(0, 500) });
    const code = failure.data.error.details.find((detail) => detail.errorCode !== undefined)?.errorCode;
    return err({ status, code, message: failure.data.error.message });
  }
  const parsed = schema.safeParse(json.ok ? json.value : null);
  return parsed.success
    ? ok(parsed.data)
    : err({ status, code: undefined, message: `Unexpected response: ${z.prettifyError(parsed.error)}` });
}

// https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
function toDeliveryError({ status, code, message }: Failure): DeliveryError {
  const description = `FCM ${status ?? "unreachable"}${code === undefined ? "" : ` ${code}`}: ${message}`;
  if (code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") return { kind: "invalid-address", message: description };
  const retryable = status === undefined || status === 429 || status >= 500;
  return { kind: "failed", retryable, message: description };
}

const base64Url = (data: string | ArrayBuffer): string =>
  (typeof data === "string" ? Buffer.from(data) : Buffer.from(new Uint8Array(data))).toString("base64url");

// ---- Messages ----------------------------------------------------------------------------------

/** Above this, one summary notification is sent instead of one per change. */
const MAX_NOTIFICATIONS_PER_BATCH = 10;
const MAX_TEXT_LENGTH = 240;
/** FCM rejects messages over 4 KB; larger event lists are sent empty and clients refetch the timetable. */
const MAX_EVENT_PAYLOAD_BYTES = 3000;

export type FcmMessage = {
  readonly title: string;
  readonly body: string;
  /** Notifications of one study program; bundled together on iOS (thread-id) and by clients. */
  readonly group: string;
  /** Replaces an earlier notification with the same tag instead of stacking another one. */
  readonly tag: string;
  readonly data: Readonly<Record<string, string>>;
};

const truncate = (text: string): string =>
  text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;

/** Event lists in the format the original clients read (`newTimetableEvents`/`removedTimetableEvents`). */
function eventLists(changes: readonly Change[]): Record<string, string> {
  const lists = {
    newTimetableEvents: JSON.stringify(changes.flatMap((c) => (c.kind === "removed" ? [] : [c.event]))),
    removedTimetableEvents: JSON.stringify(
      changes.flatMap((c) => (c.kind === "added" ? [] : [c.kind === "updated" ? c.before : c.event])),
    ),
  };
  const fits = Buffer.byteLength(lists.newTimetableEvents + lists.removedTimetableEvents) <= MAX_EVENT_PAYLOAD_BYTES;
  return fits ? lists : { newTimetableEvents: "[]", removedTimetableEvents: "[]" };
}

/**
 * One notification per change, all in the study program's group so clients can bundle them. Data keys
 * stay strings (FCM requirement); times are UTC ISO strings for clients that render them locally.
 */
export function fcmMessages(recipient: Recipient, batch: ChangeBatch): FcmMessage[] {
  const group = `timetable:${batch.studyProgramId}`;
  const common = {
    group,
    studyProgramId: String(batch.studyProgramId),
    timetableKey: JSON.stringify({ studyProgramId: batch.studyProgramId, yearWeek: formatIsoWeek(batch.week) }),
    timestamp: new Date().toISOString(),
  };

  if (batch.changes.length > MAX_NOTIFICATIONS_PER_BATCH) {
    const body = `${summarizeChanges(batch.changes)} in week ${batch.week.week}. Open the timetable for details.`;
    return [
      {
        title: `Timetable changed: ${batch.studyProgramName}`,
        body,
        group,
        tag: `${group}:${formatIsoWeek(batch.week)}`,
        data: { ...common, ...eventLists(batch.changes), change: "summary", summary: body },
      },
    ];
  }
  return batch.changes.map((change) => {
    const { title, body } = describeChange(change, recipient.timeZone);
    return {
      title: truncate(title),
      body: truncate(body),
      group,
      tag: `${group}:${Bun.hash(change.kind + eventIdentity(change.event)).toString(36)}`,
      data: { ...common, ...eventLists([change]), change: change.kind, summary: truncate(`${title}. ${body}`) },
    };
  });
}

// ---- Transport ---------------------------------------------------------------------------------

export async function createFcm(credentialsPath: string): Promise<Result<Transport, string>> {
  const text = await fromPromise(Bun.file(credentialsPath).text(), errorMessage);
  if (!text.ok) return text;
  const json = parseJson(text.value);
  if (!json.ok) return json;
  const account = ServiceAccount.safeParse(json.value);
  if (!account.success) return err(z.prettifyError(account.error));
  const { project_id, client_email, private_key, token_uri } = account.data;

  const key = await fromPromise(
    crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(private_key.replaceAll(/-----[A-Z ]+-----|\s/g, ""), "base64"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    errorMessage,
  );
  if (!key.ok) return key;
  const signingKey = key.value;

  let cachedToken: { readonly value: string; readonly expiresAt: number } | undefined;

  async function accessToken(): Promise<Result<string, Failure>> {
    if (cachedToken !== undefined && cachedToken.expiresAt > Date.now()) return ok(cachedToken.value);

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: token_uri,
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`,
    });

    const token = await post(token_uri, { body }, TokenResponse);
    if (!token.ok) return token;
    cachedToken = { value: token.value.access_token, expiresAt: Date.now() + (token.value.expires_in - 60) * 1000 };
    return ok(cachedToken.value);
  }

  async function send(message: object, validateOnly = false): Promise<Result<void, Failure>> {
    const auth = await accessToken();
    if (!auth.ok) return auth;
    const sent = await post(
      `https://fcm.googleapis.com/v1/projects/${project_id}/messages:send`,
      {
        headers: { authorization: `Bearer ${auth.value}`, "content-type": "application/json" },
        body: JSON.stringify({ message, validate_only: validateOnly }),
      },
      z.object({ name: z.string() }),
    );
    return sent.ok ? ok(undefined) : sent;
  }

  const sendWithRetries = async (message: object): Promise<Result<void, DeliveryError>> =>
    retry(async () => {
      const sent = await send(message);
      return sent.ok ? sent : err(toDeliveryError(sent.error));
    }, isTransient);

  return ok({
    channel: "fcm",
    verify: async (token) => {
      const checked = await send({ token }, true);
      if (checked.ok) return checked;
      // A malformed token is rejected with INVALID_ARGUMENT rather than UNREGISTERED.
      if (checked.error.code === "INVALID_ARGUMENT") {
        return err({ kind: "invalid-address", message: checked.error.message });
      }
      return err(toDeliveryError(checked.error));
    },
    deliver: async (recipient, batch) => {
      for (const { title, body, group, tag, data } of fcmMessages(recipient, batch)) {
        const sent = await sendWithRetries({
          token: recipient.address,
          notification: { title, body },
          data,
          android: { priority: "HIGH", notification: { tag, notification_priority: "PRIORITY_HIGH" } },
          apns: { payload: { aps: { "thread-id": group } } },
        });
        if (!sent.ok) return sent;
      }
      return ok(undefined);
    },
  });
}
