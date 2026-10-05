import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import {
  callbackUrlSchema,
  emailSchema,
  httpsImageUrlSchema,
  nameSchema,
  passwordInputSchema,
  passwordSchema,
  tokenSchema,
} from "./schemas";

/**
 * Schema, plus what a rejected field answers with.
 *
 * `code` is the part a client branches on, `message` the part a person reads.
 * Both are needed because this hook runs *before* the endpoint handler, so it is
 * the one rejecting a malformed field most of the time — and it was answering
 * with prose alone. The frontend then had no stable string to match and fell
 * back to looking for English sentences in a response, which is the kind of
 * contract that holds until a message is reworded.
 *
 * The codes are better-auth's own where it has one for the failure
 * (`INVALID_EMAIL`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`), so a client sees
 * the same code whichever of the two layers rejects.
 */
type FieldValidator = { schema: z.ZodType; message: string; code: string };

const nameField: FieldValidator = {
  schema: nameSchema,
  message: "The name contains characters that are not allowed.",
  code: "INVALID_NAME",
};
const imageField: FieldValidator = {
  schema: httpsImageUrlSchema,
  message: "URL d'image invalide.",
  code: "INVALID_IMAGE",
};
const emailField: FieldValidator = {
  schema: emailSchema,
  message: "Invalid email address.",
  code: "INVALID_EMAIL",
};
const passwordField: FieldValidator = {
  schema: passwordSchema,
  message: "The password must be between 8 and 128 characters.",
  code: "PASSWORD_TOO_SHORT_OR_LONG",
};
const passwordVerifyField: FieldValidator = {
  schema: passwordInputSchema,
  message: "Mot de passe invalide.",
  code: "INVALID_PASSWORD",
};
const tokenField: FieldValidator = {
  schema: tokenSchema,
  message: "Jeton invalide.",
  code: "INVALID_TOKEN",
};
const idField: FieldValidator = {
  schema: tokenSchema,
  message: "Identifiant invalide.",
  code: "INVALID_ID",
};

/** better-auth endpoints whose body fields are validated with `./schemas`. */
const PATH_FIELD_VALIDATORS: Record<string, Record<string, FieldValidator>> = {
  "/sign-up/email": {
    name: nameField,
    email: emailField,
    password: passwordField,
    image: imageField,
  },
  "/update-user": { name: nameField, image: imageField },
  "/sign-in/email": { email: emailField, password: passwordVerifyField },
  "/verify-password": { password: passwordVerifyField },
  "/change-password": { currentPassword: passwordVerifyField },
  "/delete-user": { password: passwordVerifyField, token: tokenField },
  "/reset-password": { token: tokenField },
  "/revoke-session": { token: tokenField },
  "/change-email": { newEmail: emailField },
  "/send-verification-email": { email: emailField },
  "/request-password-reset": { email: emailField },
  "/unlink-account": { providerId: idField, accountId: idField },
  "/refresh-token": {
    providerId: idField,
    accountId: idField,
    userId: idField,
  },
  "/get-access-token": {
    providerId: idField,
    accountId: idField,
    userId: idField,
  },
};

/** Redirect fields validated on every endpoint, on top of better-auth's own trustedOrigins check. */
const ANY_PATH_FIELD_VALIDATORS: Record<string, FieldValidator> = {
  callbackURL: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
    code: "INVALID_CALLBACK_URL",
  },
  newUserCallbackURL: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
    code: "INVALID_CALLBACK_URL",
  },
  errorCallbackURL: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
    code: "INVALID_CALLBACK_URL",
  },
  redirectTo: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
    code: "INVALID_CALLBACK_URL",
  },
};

/**
 * Validates a body field with the given schema and returns the parsed value
 * (including `trim` normalization); throws a 400 `APIError` on failure.
 */
function parseBodyField(validator: FieldValidator, value: unknown): unknown {
  const result = validator.schema.safeParse(value);
  if (!result.success) {
    throw new APIError("BAD_REQUEST", {
      message: validator.message,
      code: validator.code,
    });
  }
  return result.data;
}

/**
 * `before` hook: normalizes and bounds better-auth body inputs before the
 * endpoint handlers run. Endpoint-to-field mapping: `PATH_FIELD_VALIDATORS`.
 */
export const inputValidationHook = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return;

  const fieldValidators = {
    ...ANY_PATH_FIELD_VALIDATORS,
    ...PATH_FIELD_VALIDATORS[ctx.path],
  };

  for (const [field, validator] of Object.entries(fieldValidators)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    body[field] = parseBodyField(validator, value);
  }
});
