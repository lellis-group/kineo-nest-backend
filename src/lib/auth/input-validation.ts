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

/** Schema plus the 400 message thrown when a body field fails validation. */
type FieldValidator = { schema: z.ZodType; message: string };

const nameField: FieldValidator = {
  schema: nameSchema,
  message: "The name contains characters that are not allowed.",
};
const imageField: FieldValidator = {
  schema: httpsImageUrlSchema,
  message: "URL d'image invalide.",
};
const emailField: FieldValidator = {
  schema: emailSchema,
  message: "Invalid email address.",
};
const passwordField: FieldValidator = {
  schema: passwordSchema,
  message: "The password must be between 8 and 128 characters.",
};
const passwordVerifyField: FieldValidator = {
  schema: passwordInputSchema,
  message: "Mot de passe invalide.",
};
const tokenField: FieldValidator = {
  schema: tokenSchema,
  message: "Jeton invalide.",
};
const idField: FieldValidator = {
  schema: tokenSchema,
  message: "Identifiant invalide.",
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
  },
  newUserCallbackURL: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
  },
  errorCallbackURL: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
  },
  redirectTo: {
    schema: callbackUrlSchema,
    message: "URL de redirection invalide.",
  },
};

/**
 * Validates a body field with the given schema and returns the parsed value
 * (including `trim` normalization); throws a 400 `APIError` on failure.
 */
function parseBodyField<S extends z.ZodType>(
  schema: S,
  value: unknown,
  errorMessage: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new APIError("BAD_REQUEST", {
      message: errorMessage,
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

  for (const [field, { schema, message }] of Object.entries(fieldValidators)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    body[field] = parseBodyField(schema, value, message);
  }
});
