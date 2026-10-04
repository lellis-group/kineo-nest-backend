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
    subject: "Vérifiez votre adresse email",
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
    subject: "Réinitialisation de votre mot de passe",
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
    subject: "Confirmez votre nouvelle adresse email",
    title: "Changement d'adresse email",
    message:
      "Une demande de changement d'adresse email a été effectuée sur votre compte. Confirmez cette adresse via le bouton ci-dessous pour l'appliquer. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email et votre adresse actuelle restera inchangée.",
    url,
    ctaLabel: "Confirmer ma nouvelle adresse",
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
    subject: "Suppression de votre compte",
    title: "Suppression de votre compte",
    message: [
      "Vous avez demandé la suppression de votre compte. Ce lien est valable 24 heures.",
      "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : rien ne sera supprimé.",
      "",
      "Ce qui se passe si vous confirmez, dans l'ordre :",
      "1. Votre compte est déconnecté immédiatement. L'adresse " +
        email +
        " est libérée dès maintenant.",
      "2. Vos données personnelles sont anonymisées sur-le-champ : nom, e-mail, numéro RPPS, localisation, ainsi que le titre, la description et les dates de vos annonces.",
      "3. Vos annonces sortent de la recherche publique et ne reçoivent plus de candidature.",
      "4. Sous " +
        purgeGraceDays +
        " jours, ce qui reste est définitivement effacé.",
      "",
      "Ce que nous conservons, et pourquoi :",
      "Pour prouver que l'effacement a bien eu lieu, une trace de votre demande est gardée " +
        trailRetentionDays +
        " jours. Elle ne contient que deux empreintes non réversibles de votre identité et les dates, jamais votre e-mail.",
      keptApplications
        ? "Les candidatures que d'autres candidats vous ont adressées. Elles ne vous appartiennent pas : nous ne pouvons pas les supprimer à votre demande. Elles restent accessibles à leurs auteurs."
        : "Rien d'autre que cette trace. Aucune de vos données n'est transmise à un tiers.",
    ].join("\n"),
    url,
    ctaLabel: "Supprimer définitivement mon compte",
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
