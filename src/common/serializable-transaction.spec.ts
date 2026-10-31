import { describe, expect, it } from "bun:test";
import { ServiceUnavailableException } from "@nestjs/common";

import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma.service";
import { runSerializableTransaction } from "./serializable-transaction";

/**
 * A prisma whose `$transaction` throws `failTimes` times (with `failure`) before
 * it lets the operation through, recording how it was called.
 */
function prismaWithTransactions(
  failTimes: number,
  failure: (attempt: number) => unknown,
) {
  let attempts = 0;
  let lastOptions: unknown;

  const prisma = {
    $transaction: async (
      operation: (tx: Record<string, never>) => unknown,
      options: unknown,
    ) => {
      attempts += 1;
      lastOptions = options;
      if (attempts <= failTimes) {
        throw failure(attempts);
      }
      // The operation runs only once the connection stops failing.
      return operation({});
    },
  };

  return {
    attempts: () => attempts,
    lastOptions: () => lastOptions,
    prisma: prisma as unknown as PrismaService,
  };
}

function serializationFailure(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Transaction failed due to a write conflict or a deadlock",
    { code: "P2034", clientVersion: "test" },
  );
}

describe("runSerializableTransaction", () => {
  it("runs the operation in a Serializable transaction", async () => {
    const { lastOptions, prisma } = prismaWithTransactions(0, () => null);

    const result = await runSerializableTransaction(prisma, async () => "done");

    expect(result).toBe("done");
    expect(lastOptions()).toMatchObject({
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("retries a serialization failure and answers on the attempt that gets through", async () => {
    // Two conflicts, then a calm connection: a pair of concurrent writers, not
    // a broken one.
    const { attempts, prisma } = prismaWithTransactions(2, () =>
      serializationFailure(),
    );

    const result = await runSerializableTransaction(prisma, async () => "won");

    expect(result).toBe("won");
    expect(attempts()).toBe(3);
  });

  it("gives up as a 503 after three conflicts", async () => {
    const { attempts, prisma } = prismaWithTransactions(
      Number.POSITIVE_INFINITY,
      () => serializationFailure(),
    );

    const error = await runSerializableTransaction(
      prisma,
      async () => undefined,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(attempts()).toBe(3);
  });

  it("lets any other Prisma failure out immediately, without retrying", async () => {
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    const { attempts, prisma } = prismaWithTransactions(
      Number.POSITIVE_INFINITY,
      // A P2002 is a certainty: retrying it would collide for the same reason
      // every time.
      () => uniqueViolation,
    );

    const error = await runSerializableTransaction(prisma, async () => null)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBe(uniqueViolation);
    expect(attempts()).toBe(1);
  });

  it("lets an application's own refusal out without retrying", async () => {
    const { attempts, prisma } = prismaWithTransactions(
      Number.POSITIVE_INFINITY,
      () => new Error("refusal: not closeable"),
    );

    const error = await runSerializableTransaction(prisma, async () => null)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("refusal: not closeable");
    expect(attempts()).toBe(1);
  });
});
