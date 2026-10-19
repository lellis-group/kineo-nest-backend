/**
 * The Prisma client's own logger, and what the flag may do to it.
 *
 * This is the one switch in the application read at two places — the module
 * default and the Nest client — because Prisma needs its options before any
 * dependency injection exists, while the value is validated like every other
 * configuration. What matters is that the two readings cannot disagree: both go
 * through the same two functions below.
 *
 * The rule pinned here is the one that was wrong first. Passing a `log` option
 * replaces Prisma's defaults, so the original `["query"]` / `[]` pair silenced
 * `warn` and `error` in both positions — and the switch written to help
 * diagnose a problem was what hid the warnings during one.
 */

import { describe, expect, it } from "bun:test";

import { prismaLogFor, resolvePrismaLog } from "./prisma";

describe("prismaLogFor", () => {
  it("adds query logging without dropping Prisma's own levels", () => {
    expect(prismaLogFor(true)).toEqual(["query", "warn", "error"]);
  });

  it("keeps warnings and errors when the switch is off", () => {
    // The default, restated rather than left implicit: an empty array is not the
    // same as "no option", it is "no logging at all".
    expect(prismaLogFor(false)).toEqual(["warn", "error"]);
  });

  it("never returns an empty list, in either position", () => {
    expect(prismaLogFor(false)).not.toEqual([]);
    expect(prismaLogFor(true)).not.toEqual([]);
  });
});

describe("resolvePrismaLog", () => {
  it("reads the flag the way every other boolean in this repository is read", () => {
    // Absent, and the values that do not mean yes, all leave the client where it
    // was. `envBoolean` is the one definition of that; the point of routing
    // through it is that this switch stops having rules of its own.
    for (const raw of [undefined, "", "1", "yes", "false", "off"]) {
      expect(resolvePrismaLog({ PRISMA_LOG_QUERIES: raw })).toEqual([
        "warn",
        "error",
      ]);
    }
  });

  it("accepts the ways a human writes true", () => {
    // A flag that only answers to one exact spelling fails quietly: someone sets
    // `TRUE` in a deployment file, gets no log, and concludes the feature is
    // broken rather than the spelling.
    for (const raw of ["true", "TRUE", " true ", "True"]) {
      expect(resolvePrismaLog({ PRISMA_LOG_QUERIES: raw })).toEqual([
        "query",
        "warn",
        "error",
      ]);
    }
  });

  it("reads an environment with no flag in it at all", () => {
    expect(resolvePrismaLog({})).toEqual(["warn", "error"]);
  });
});
