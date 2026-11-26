import { z } from "zod";

/** INSEE commune codes: five digits, or `2A`/`2B` followed by three digits. */
export const CITY_CODE_REGEX = /^(?:\d{5}|2[AB]\d{3})$/i;
/** Department codes: two digits, `2A`/`2B`, or the three-digit overseas codes. */
export const DEPARTMENT_CODE_REGEX = /^(?:\d{2}|2[AB]|97\d)$/i;
export const POSTAL_CODE_REGEX = /^\d{5}$/;

/**
 * Derive a department code from a commune code without a reference dataset.
 * This is a consistency check on what the frontend sent — the backend does
 * not resolve places, it only refuses incoherent pairs.
 */
export function departmentCodeFromCityCode(code: string): string {
  const upper = code.toUpperCase();
  if (/^2[AB]\d{3}$/.test(upper)) return upper.slice(0, 2);
  if (/^97\d{3}$/.test(upper)) return upper.slice(0, 3);
  return upper.slice(0, 2);
}

export function geoCodesAgree(input: {
  cityCodeInsee?: string;
  departmentCode?: string;
}): boolean {
  if (!input.cityCodeInsee || !input.departmentCode) return true;
  return (
    departmentCodeFromCityCode(input.cityCodeInsee) ===
    input.departmentCode.toUpperCase()
  );
}

/**
 * The fields a location combobox commits, shared by profile and practice
 * bodies. `city` stays the human label; the code is what the read path filters
 * on, because a substring match cannot tell two homonymous communes apart.
 */
export const geoWriteFields = {
  cityCodeInsee: z
    .string()
    .trim()
    .regex(CITY_CODE_REGEX, "Expected an INSEE commune code")
    .optional()
    .describe("INSEE code of the selected commune"),
  postalCode: z
    .string()
    .trim()
    .regex(POSTAL_CODE_REGEX, "Postal code must be five digits")
    .optional()
    .describe("Postal code of the selected commune"),
  departmentCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(DEPARTMENT_CODE_REGEX, "Expected a French department code")
    .optional()
    .describe("Code of the selected department"),
};
