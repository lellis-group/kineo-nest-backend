import { describe, expect, it } from "bun:test";
import { errorMessage, logError } from "./log";

/**
 * The shape Prisma throws when the database is not listening.
 *
 * Reproduced from a real boot: `message` is the empty `Invalid ... invocation`
 * header, and everything that identifies the failure is in `code` and `meta`.
 * A test built on `new Error("some message")` cannot catch a regression here,
 * because it never exercises the case that produced no output at all.
 */
function prismaConnectionError() {
  return Object.assign(
    new Error("\nInvalid `prisma.user.createMany()` invocation:\n\n\n"),
    {
      code: "ECONNREFUSED",
      meta: { modelName: "User" },
    },
  );
}

function captureLog(work: () => void): string {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(" "));

  try {
    work();
  } finally {
    console.error = original;
  }

  return lines.join("\n");
}

describe("errorMessage", () => {
  it("names the failure when the message is empty and the code is not", () => {
    // The regression this whole change exists for: an unreachable database logged
    // as a line naming nothing, because the diagnostic was in `code`.
    expect(errorMessage(prismaConnectionError())).toContain("ECONNREFUSED");
  });

  it("keeps the Prisma header that identifies the failing call", () => {
    expect(errorMessage(prismaConnectionError())).toContain(
      "prisma.user.createMany()",
    );
  });

  it("carries the meta that names the model", () => {
    expect(errorMessage(prismaConnectionError())).toContain("User");
  });

  it("does not start with a separator when the message is blank", () => {
    const blank = Object.assign(new Error("   "), { code: "ECONNREFUSED" });

    expect(errorMessage(blank)).toBe("[code=ECONNREFUSED]");
  });

  it("leaves a plain error readable as it was", () => {
    // No regression for the logs that already work: the message is first and
    // unmodified, so existing greps keep matching.
    const plain = new Error("the database is not reachable");

    expect(errorMessage(plain)).toBe("the database is not reachable");
  });

  it("appends the code of a Prisma known error without losing the message", () => {
    const unique = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { modelName: "User", target: ["email"] },
    });

    const line = errorMessage(unique);

    expect(line.startsWith("Unique constraint failed")).toBe(true);
    expect(line).toContain("[code=P2002]");
    expect(line).toContain("email");
  });

  it("ignores a non-string code rather than printing [object Object]", () => {
    const odd = Object.assign(new Error("failed"), { code: 42 });

    expect(errorMessage(odd)).toBe("failed");
  });

  it("serialises a non-Error rejection as it was", () => {
    expect(errorMessage("secret connection string")).toBe(
      "secret connection string",
    );
  });

  describe("redaction", () => {
    it("does not leak the password of a connection string in meta", () => {
      // `P1001` carries the whole connection string in `meta.databaseUrl`, and
      // this project's traces are JSON meant to be indexed by a log pipeline.
      const withUrl = Object.assign(new Error("Can't reach database server"), {
        code: "P1001",
        meta: {
          databaseUrl:
            "postgresql://johndoe:randompassword@localhost:5432/mydb?schema=public",
        },
      });

      const line = errorMessage(withUrl);

      expect(line).not.toContain("randompassword");
      expect(line).not.toContain("johndoe");
      expect(line).not.toContain("postgresql://");
      expect(line).toContain("[redacted]");
    });

    it("names the field that held the secret, which is the debuggable half", () => {
      const withUrl = Object.assign(new Error("failed"), {
        meta: { databaseUrl: "postgresql://johndoe:randompassword@localhost" },
      });

      expect(errorMessage(withUrl)).toContain("databaseUrl");
    });

    it("redacts a connection string quoted in the message itself", () => {
      // `main.ts` logs through this on the way out of a failed boot, and a driver
      // is free to quote the connection string it failed on.
      const quoted = new Error(
        "failed to connect to postgresql://johndoe:randompassword@localhost:5432",
      );

      const line = errorMessage(quoted);

      expect(line).not.toContain("randompassword");
      expect(line).toContain("[redacted]");
    });

    it("redacts a credential nested under any matching key", () => {
      const nested = Object.assign(new Error("failed"), {
        meta: {
          smtpPassword: "hunter2",
          apiToken: "abc",
          host: "mail.example",
        },
      });

      const line = errorMessage(nested);

      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("abc");
      // A key that is not a credential stays readable, or the redaction would
      // cost more than it protects.
      expect(line).toContain("mail.example");
    });

    it("walks arrays and nested objects rather than only the top level", () => {
      const nested = Object.assign(new Error("failed"), {
        meta: { target: [{ password: "hunter2" }, { field: "email" }] },
      });

      const line = errorMessage(nested);

      expect(line).not.toContain("hunter2");
      expect(line).toContain("email");
    });
  });
});

describe("logError", () => {
  it("emits one JSON line carrying the diagnostic", () => {
    const line = captureLog(() =>
      logError("system_scaffold.ensure_failed", prismaConnectionError()),
    );

    const entry = JSON.parse(line);

    expect(entry).toMatchObject({
      level: "error",
      event: "system_scaffold.ensure_failed",
    });
    expect(entry.error).toContain("ECONNREFUSED");
  });

  it("keeps the contextual fields alongside the diagnostic", () => {
    const line = captureLog(() =>
      logError("data_lifecycle.step_failed", prismaConnectionError(), {
        step: "session",
      }),
    );

    expect(JSON.parse(line)).toMatchObject({ step: "session" });
  });

  it("does not leak a credential through the log line either", () => {
    const withUrl = Object.assign(new Error("failed"), {
      meta: { databaseUrl: "postgresql://johndoe:randompassword@localhost" },
    });

    const line = captureLog(() => logError("health.db_check_failed", withUrl));

    expect(line).not.toContain("randompassword");
  });
});
