import { createTransport } from "nodemailer";
import { z } from "zod";

import { log } from "./config.ts";
import { mondayOf } from "./model.ts";
import {
  describeChange,
  isTransient,
  summarizeChanges,
  type ChangeBatch,
  type DeliveryError,
  type Recipient,
  type Transport,
} from "./notify.ts";
import { err, errorMessage, fromPromise, ok, retry } from "./result.ts";

export type EmailOptions = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
  /** Origin the API is reachable at, for unsubscribe links. */
  readonly publicUrl: string;
};

const escapeHtml = (text: string): string => text.replaceAll(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function renderEmail(recipient: Recipient, batch: ChangeBatch, unsubscribeUrl: string) {
  const weekOf = mondayOf(batch.week).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const changes = batch.changes.map((change) => describeChange(change, recipient.timeZone));
  const intro = `${summarizeChanges(batch.changes)} in the timetable of ${batch.studyProgramName}, week of ${weekOf}:`;
  const footer = `Times are shown in ${recipient.timeZone}. You get this email because you subscribed to FSRE timetable changes.`;
  return {
    subject: `Timetable changes: ${batch.studyProgramName}, week of ${weekOf}`,
    text: [
      intro,
      "",
      ...changes.flatMap(({ title, body }) => [title, `  ${body}`, ""]),
      footer,
      `Unsubscribe: ${unsubscribeUrl}`,
    ].join("\n"),
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<ul>${changes.map(({ title, body }) => `<li><strong>${escapeHtml(title)}</strong><br>${escapeHtml(body)}</li>`).join("")}</ul>`,
      `<p style="color:#666;font-size:12px">${escapeHtml(footer)} <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
    ].join("\n"),
  };
}

const SmtpError = z.looseObject({ code: z.string().optional(), responseCode: z.number().optional() });

function toDeliveryError(cause: unknown): DeliveryError {
  const message = errorMessage(cause);
  const parsed = SmtpError.safeParse(cause);
  const { code, responseCode } = parsed.success ? parsed.data : {};
  // 5xx replies are permanent; for the envelope (MAIL FROM/RCPT TO) they mean the mailbox is refused.
  if (responseCode !== undefined && responseCode >= 500) {
    return code === "EENVELOPE" ? { kind: "invalid-address", message } : { kind: "failed", retryable: false, message };
  }
  return { kind: "failed", retryable: true, message };
}

export async function createEmail(options: EmailOptions): Promise<Transport> {
  const transporter = createTransport({
    host: options.host,
    port: options.port,
    secure: options.port === 465,
    requireTLS: options.port !== 465,
    auth: { user: options.user, pass: options.password },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  const verified = await fromPromise(transporter.verify(), errorMessage);
  if (!verified.ok) log.warn(`SMTP server ${options.host}:${options.port} did not accept the login: ${verified.error}`);

  return {
    channel: "email",
    verify: async () => ok(undefined),
    deliver: async (recipient, batch) => {
      const unsubscribeUrl = `${options.publicUrl.replace(/\/+$/, "")}/api/messaging/unsubscribe/${recipient.subscriptionId}`;
      const mail = {
        from: options.from,
        to: recipient.address,
        ...renderEmail(recipient, batch, unsubscribeUrl),
        headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      };
      return retry(async () => {
        const sent = await fromPromise(transporter.sendMail(mail), toDeliveryError);
        return sent.ok ? ok(undefined) : err(sent.error);
      }, isTransient);
    },
  };
}
