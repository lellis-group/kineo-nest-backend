import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { HttpAdapterHost } from "@nestjs/core";
import { ZodSerializationException, ZodValidationException } from "nestjs-zod";
import { z } from "zod";
import { HttpExceptionFilter } from "./http-exception.filter";

type Captured = { status: number; body: unknown };

function makeHost(url = "/account/confirm-deletion") {
  const captured: Captured[] = [];
  const request = { method: "POST", url };

  const httpServer = {
    status: (status: number) => ({
      json: (body: unknown) => captured.push({ status, body }),
    }),
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => httpServer,
      getRequest: () => request,
    }),
    // BaseExceptionFilter reads the response off the argument list, not off
    // switchToHttp.
    getArgByIndex: () => httpServer,
  } as unknown as ArgumentsHost;

  return { host, captured };
}

function makeFilter(nodeEnv?: string) {
  // The base filter answers through the adapter with the raw exception body, so
  // the double records it: that is how a test tells delegation from the
  // sanitized branch.
  const adapter = {
    isHeadersSent: () => false,
    reply: (response: unknown, body: unknown, status?: number) => {
      const server = response as {
        status: (code: number) => { json: (b: unknown) => void };
      };
      server.status(status ?? 500).json(body);
    },
  };

  const config = {
    get: (key: string) => (key === "nodeEnv" ? nodeEnv : undefined),
  } as unknown as ConfigService;

  // Nest injects an applicationRef on an APP_FILTER provider; the base filter
  // falls back to the adapter without one, and that is what happens here.
  return new HttpExceptionFilter(
    { httpAdapter: adapter } as unknown as HttpAdapterHost,
    config,
  );
}

/** A real zod error, so the issues carry the shape the filter maps. */
function missingToken() {
  const result = z.object({ token: z.string() }).safeParse({});
  if (result.success) {
    throw new Error("expected the parse to fail");
  }
  return result.error;
}

/** A serialization mismatch: a Date where the schema wants an ISO string. */
function dateAsString() {
  const result = z.object({ startDate: z.iso.datetime() }).safeParse({
    startDate: new Date(),
  });
  if (result.success) {
    throw new Error("expected the parse to fail");
  }
  return result.error;
}

const previousNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.NODE_ENV;
});

afterEach(() => {
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

describe("HttpExceptionFilter outside production", () => {
  it("replaces the message of a 500", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("production");

    filter.catch(
      new HttpException(
        "connection to 10.0.0.7 failed",
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
      host,
    );

    expect(captured[0].status).toBe(500);
    expect(captured[0].body).toMatchObject({
      statusCode: 500,
      message: "Internal server error",
    });
    expect(JSON.stringify(captured[0].body)).not.toContain("10.0.0.7");
  });

  it("keeps the message of a 4xx, which the caller can act on", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("production");

    filter.catch(
      new HttpException(
        "This listing can no longer be modified",
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    expect(captured[0]).toMatchObject({
      status: 400,
      body: { message: "This listing can no longer be modified" },
    });
  });

  it("keeps the query string out of the body", () => {
    const { host, captured } = makeHost(
      "/account/confirm-deletion?token=super-secret-token",
    );
    const filter = makeFilter("production");

    filter.catch(new HttpException("nope", HttpStatus.NOT_FOUND), host);

    expect(captured[0].body).toMatchObject({
      path: "/account/confirm-deletion",
    });
    expect(JSON.stringify(captured[0].body)).not.toContain(
      "super-secret-token",
    );
  });

  it("keeps the query string out of a URL that has none intact", () => {
    const { host, captured } = makeHost("/health");
    const filter = makeFilter("production");

    filter.catch(new HttpException("nope", HttpStatus.NOT_FOUND), host);

    expect(captured[0].body).toMatchObject({ path: "/health" });
  });

  it("treats an unset NODE_ENV as hardened", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter(undefined);

    filter.catch(
      new HttpException("leaked detail", HttpStatus.INTERNAL_SERVER_ERROR),
      host,
    );

    expect(captured[0].body).toMatchObject({
      message: "Internal server error",
    });
  });

  it("keeps the code an exception carries, and the shape when it does not", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("production");

    // `refusal()` raises exactly this body, and the client branches on the code.
    filter.catch(
      new BadRequestException({
        statusCode: 400,
        code: "LISTING_NOT_CLOSEABLE",
        message: "Only open or filled listings can be closed",
      }),
      host,
    );

    expect(captured[0].body).toMatchObject({
      statusCode: 400,
      message: "Only open or filled listings can be closed",
      code: "LISTING_NOT_CLOSEABLE",
    });
  });

  it("answers with no code field when the exception carries none", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("production");

    filter.catch(new HttpException("nope", HttpStatus.NOT_FOUND), host);

    expect(captured[0].body).not.toHaveProperty("code");
  });

  it("keeps the code in development too, so the two agree", () => {
    // Development delegates to the base filter, which writes the exception body
    // as it is. A code present in one environment and absent in the other would
    // make the client behave differently depending on where it ran.
    const { host, captured } = makeHost();
    const filter = makeFilter("development");

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        code: "LISTING_NOT_CLOSEABLE",
        message: "Only open or filled listings can be closed",
      }),
      host,
    );

    expect(captured[0].body).toMatchObject({
      code: "LISTING_NOT_CLOSEABLE",
    });
  });

  it("keeps a token out of a message that quotes the URL", () => {
    // Nest's own "route not found" message is the URL, query string included, so
    // stripping the request path was not enough on its own.
    const { host, captured } = makeHost(
      "/account/confirm-deletion?token=super-secret-token",
    );
    const filter = makeFilter("production");

    filter.catch(
      new HttpException(
        "Cannot GET /account/confirm-deletion?token=super-secret-token",
        HttpStatus.NOT_FOUND,
      ),
      host,
    );

    expect(JSON.stringify(captured[0].body)).not.toContain(
      "super-secret-token",
    );
    // The sentence keeps its shape rather than losing its tail.
    expect(captured[0].body).toMatchObject({
      message: expect.stringContaining("Cannot GET /account/confirm-deletion"),
    });
  });

  it("treats a staging NODE_ENV as hardened", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("staging");

    filter.catch(
      new HttpException("leaked detail", HttpStatus.INTERNAL_SERVER_ERROR),
      host,
    );

    expect(captured[0].body).toMatchObject({
      message: "Internal server error",
    });
  });
});

describe("HttpExceptionFilter in development", () => {
  it("delegates to the base filter, which answers with the raw body", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("development");

    filter.catch(
      new HttpException("the real reason", HttpStatus.NOT_FOUND),
      host,
    );

    // The sanitized branch always writes statusCode + message + path +
    // timestamp. The base filter writes the exception body alone.
    expect(captured[0].body).toEqual({
      statusCode: 404,
      message: "the real reason",
    });
    expect(captured[0].body).not.toHaveProperty("path");
    expect(captured[0].body).not.toHaveProperty("timestamp");
  });
});

describe("HttpExceptionFilter validation", () => {
  it("answers 400 with the issue list, hardened or not", () => {
    const { host, captured } = makeHost();
    const filter = makeFilter("production");

    filter.catch(new ZodValidationException(missingToken()), host);

    const body = captured[0].body as {
      statusCode: number;
      message: string;
      errors: { path: unknown[]; message: string }[];
    };
    expect(captured[0].status).toBe(400);
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe("Validation failed");
    expect(body.errors[0].path).toEqual(["token"]);
    expect(body.errors[0].message).toEqual(expect.any(String));
  });

  it("does not leak the token value in a validation error", () => {
    const { host, captured } = makeHost("/account/confirm-deletion");
    const filter = makeFilter("production");

    filter.catch(new ZodValidationException(missingToken()), host);

    // The validation branch answers before the sanitized one and never echoes
    // the request path, so a single-use token cannot ride along on it.
    expect(captured[0].body).not.toHaveProperty("path");
  });

  it("logs a serialization failure rather than answering with it", () => {
    const { host, captured } = makeHost();
    const withApplicationRef = makeFilter("development");

    // The point of the branch: the mismatch is logged with its detail and the
    // caller still gets an answer rather than an exception escaping the filter.
    expect(() =>
      withApplicationRef.catch(
        new ZodSerializationException(dateAsString()),
        host,
      ),
    ).not.toThrow();

    // It falls through to the base filter, which is what answers.
    expect(captured).toHaveLength(1);
    expect(captured[0].body).not.toHaveProperty("errors");
  });
});
