import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { logError } from "../log";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  pass?: string;
}

const DEFAULT_SMTP: SmtpConfig = {
  host: "localhost",
  port: 1025,
  secure: false,
  from: "noreply@localhost",
};

let smtpOverride: Partial<SmtpConfig> | undefined;
let cachedTransporter:
  | ReturnType<typeof nodemailer.createTransport>
  | undefined;
let cachedKey: string | undefined;

/** Override the SMTP config (DI path, tests). Pass `undefined` to clear. */
export function configureMailer(config?: Partial<SmtpConfig>): void {
  smtpOverride = config;
  cachedTransporter = undefined;
  cachedKey = undefined;
}

export function resolveSmtpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig {
  const port = Number(smtpOverride?.port ?? env.SMTP_PORT ?? DEFAULT_SMTP.port);
  return {
    host: smtpOverride?.host ?? env.SMTP_HOST ?? DEFAULT_SMTP.host,
    port: Number.isSafeInteger(port) && port > 0 ? port : DEFAULT_SMTP.port,
    secure: smtpOverride?.secure ?? (env.SMTP_SECURE === "true" ? true : false),
    from: smtpOverride?.from ?? env.SMTP_FROM ?? DEFAULT_SMTP.from,
    user: smtpOverride?.user ?? env.SMTP_USER ?? undefined,
    pass: smtpOverride?.pass ?? env.SMTP_PASS ?? undefined,
  };
}

function getTransporter() {
  const smtp = resolveSmtpConfig();
  const key = JSON.stringify({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    user: smtp.user ?? null,
    from: smtp.from,
    passHash: smtp.pass ? hashSecret(smtp.pass) : null,
  });
  if (!cachedTransporter || cachedKey !== key) {
    cachedTransporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user
        ? {
            user: smtp.user,
            pass: smtp.pass,
          }
        : undefined,
    });
    cachedKey = key;
  }
  return cachedTransporter;
}

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  const smtp = resolveSmtpConfig();
  try {
    return await getTransporter().sendMail({
      from: smtp.from,
      to,
      subject,
      html,
    });
  } catch (error) {
    logError("email.send_failed", error, {
      recipientDomain: to.split("@")[1] ?? "unknown",
    });
    throw error;
  }
}
