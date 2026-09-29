import { sendEmail } from "./mailer";
import {
  type NotificationWarning,
  notificationEmailTemplate,
} from "./templates/notification";
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

export async function sendDeleteAccountEmail({
  email,
  name,
  url,
  listingsUrl,
  pendingApplications = 0,
  purgeGraceDays,
  trailRetentionDays,
}: {
  email: string;
  name?: string | null;
  url: string;
  listingsUrl?: string;
  pendingApplications?: number;
  purgeGraceDays: number;
  trailRetentionDays: number;
}) {
  return sendNotificationEmail({
    email,
    name,
    subject: "Suppression de votre compte",
    title: "Suppression de votre compte",
    message:
      "Vous avez demandé la suppression de votre compte et de vos données. Ce lien est valable 24 heures. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : rien ne sera supprimé.\n\n" +
      `Au moment de la confirmation, vos données personnelles (nom, e-mail, numéro RPPS, localisation, annonces et messages) sont anonymisées immédiatement et votre compte est déconnecté sur-le-champ. Elles sont définitivement effacées sous ${purgeGraceDays} jours. Vous pourrez recréer un compte avec cette adresse dès maintenant.\n\n` +
      `Pour prouver l'effacement, une trace de votre demande est conservée ${trailRetentionDays} jours : elle ne contient que deux empreintes non réversibles de votre identité et les dates de la demande, jamais votre e-mail.`,
    warning:
      pendingApplications > 0
        ? {
            title: "Action requise avant de confirmer",
            body: `${pendingApplications} candidature${pendingApplications > 1 ? "s" : ""} en attente d'autres candidats repose${pendingApplications > 1 ? "nt" : ""} sur vos annonces. Fermez ou annulez ces annonces, sinon la suppression sera refusée au moment de la confirmation.`,
            actionUrl: listingsUrl,
            actionLabel: "Gérer mes annonces",
          }
        : undefined,
    url,
    ctaLabel: "Supprimer mon compte",
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
  warning,
}: {
  email: string;
  name?: string | null;
  subject: string;
  title: string;
  message: string;
  url?: string;
  ctaLabel?: string;
  warning?: NotificationWarning;
}) {
  return sendEmail({
    to: email,
    subject,
    html: notificationEmailTemplate({
      name,
      title,
      message,
      url,
      ctaLabel,
      warning,
    }),
  });
}
