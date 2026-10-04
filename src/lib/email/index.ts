import { sendEmail } from "./mailer";
import { notificationEmailTemplate } from "./templates/notification";
import { resetPasswordEmailTemplate } from "./templates/reset-password";
import { verificationEmailTemplate } from "./templates/verification";

export async function sendVerificationEmail({
  email,
  name,
  url,
}: {
  email: string;
  name?: string | null;
  url: string;
}) {
  return sendEmail({
    to: email,
    subject: "Verify your email address",
    html: verificationEmailTemplate({
      name,
      url,
    }),
  });
}

export async function sendResetPasswordEmail({
  email,
  name,
  url,
}: {
  email: string;
  name?: string | null;
  url: string;
}) {
  return sendEmail({
    to: email,
    subject: "Reset your password",
    html: resetPasswordEmailTemplate({
      name,
      url,
    }),
  });
}

export async function sendChangeEmailEmail({
  email,
  name,
  url,
}: {
  email: string;
  name?: string | null;
  url: string;
}) {
  return sendNotificationEmail({
    email,
    name,
    subject: "Confirm your new email address",
    title: "Email address change",
    message:
      "A request to change the email address on your account was made. Confirm this address with the button below to apply it. If you did not make this request, ignore this email and your current address stays unchanged.",
    url,
    ctaLabel: "Confirm my new address",
  });
}

/**
 * The erasure request email.
 *
 * It has to be exact, because it is the disclosure that makes the consent
 * meaningful: the account is anonymized rather than deleted, some applications
 * are kept because they belong to other people, and the trail that proves the
 * erasure is keyed rather than readable.
 */
export async function sendDeleteAccountEmail({
  email,
  name,
  url,
  thirdPartyApplications = 0,
  purgeGraceDays,
  trailRetentionDays,
}: {
  email: string;
  name?: string | null;
  url: string;
  thirdPartyApplications?: number;
  purgeGraceDays: number;
  trailRetentionDays: number;
}) {
  const keptApplications = thirdPartyApplications > 0;

  return sendNotificationEmail({
    email,
    name,
    subject: "Account deletion",
    title: "Account deletion",
    message: [
      "You asked for your account to be deleted. This link is valid for 24 hours.",
      "If you did not make this request, ignore this email: nothing will be deleted.",
      "",
      "What happens when you confirm, in order:",
      "1. Your account is disconnected immediately. The address " +
        email +
        " is released immediately.",
      "2. Your personal data is anonymized on the spot: name, email, RPPS number, location, and the title, description and dates of your listings.",
      "3. Your listings leave the public search and take no more applications.",
      "4. After " +
        purgeGraceDays +
        " days, whatever is left is permanently deleted.",
      "",
      "What we keep, and why:",
      "To prove the erasure happened, a trace of your request is kept for " +
        trailRetentionDays +
        " days. It holds two non-reversible fingerprints of your identity and the dates, never your email address.",
      keptApplications
        ? "The applications other candidates sent you. They are not yours: we cannot delete them at your request. They stay accessible to their authors."
        : "Nothing else besides that trace. None of your data is passed to a third party.",
    ].join("\n"),
    url,
    ctaLabel: "Delete my account for good",
  });
}

export async function sendNotificationEmail({
  email,
  name,
  subject,
  title,
  message,
  url,
  ctaLabel,
}: {
  email: string;
  name?: string | null;
  subject: string;
  title: string;
  message: string;
  url?: string;
  ctaLabel?: string;
}) {
  return sendEmail({
    to: email,
    subject,
    html: notificationEmailTemplate({ name, title, message, url, ctaLabel }),
  });
}
