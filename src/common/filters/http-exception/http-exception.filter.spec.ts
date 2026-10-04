import { describe, expect, it } from "bun:test";
import {
  type ArgumentsHost,
  ConflictException,
  GoneException,
  type HttpException,
  NotFoundException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { HttpAdapterHost } from "@nestjs/core";
import { HttpExceptionFilter } from "./http-exception.filter";

/**
 * The hardened branch rebuilds the response body from scratch, which is what
 * makes it a sanitizer. It must not also strip the machine-readable
 * discriminator: a status code that means several things is unusable without
 * one.
 */

function run(
  exception: HttpException,
  hardened: boolean,
  request: { method: string; url: string } = {
    method: "POST",
    url: "/account/confirm-deletion",
  },
) {
  let payload: Record<string, unknown> | undefined;

  const response = {
    status: (status: number) => ({
      json: (body: Record<string, unknown>) => {
        payload = { ...body, __status: status };
        return response;
      },
    }),
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  const filter = new HttpExceptionFilter(
    { httpAdapter: {} } as unknown as HttpAdapterHost,
    {
      get: () => (hardened ? "production" : "development"),
    } as unknown as ConfigService,
  );

  filter.catch(exception, host);
  return payload;
}

describe("HttpExceptionFilter (hardened)", () => {
  it("forwards a code supplied by the exception", () => {
    const payload = run(
      new ConflictException({
        code: "NO_PENDING_REQUEST",
        message: "No pending erasure request matches this confirmation.",
      }),
      true,
    );

    expect(payload).toMatchObject({
      statusCode: 409,
      code: "NO_PENDING_REQUEST",
      __status: 409,
    });
  });

  it("forwards a code on a 410 too", () => {
    const payload = run(
      new GoneException({
        code: "ALREADY_ERASED",
        message: "Ce compte a déjà été supprimé.",
      }),
      true,
    );

    expect(payload).toMatchObject({ code: "ALREADY_ERASED", __status: 410 });
  });

  it("leaves the body shape unchanged when there is no code", () => {
    const payload = run(new NotFoundException("Ce lien est invalide."), true);

    expect(payload).not.toHaveProperty("code");
    expect(payload).toMatchObject({ statusCode: 404 });
  });

  it("ignores a non-string code rather than echoing it", () => {
    const payload = run(
      new ConflictException({ code: { nested: true }, message: "nope" }),
      true,
    );

    expect(payload).not.toHaveProperty("code");
  });

  it("drops the query string from a generated 404", () => {
    // Nest composes that message from the raw URL, so echoing it verbatim put
    // the query string in the body — and in the log line above it. A mistyped
    // route carrying a single-use erasure link is exactly how a token reaches
    // log storage, which is what redacting `path` was meant to prevent.
    const token = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const payload = run(
      new NotFoundException(
        `Cannot GET /account/confirm-deletionx?token=${token}`,
      ),
      true,
      { method: "GET", url: `/account/confirm-deletionx?token=${token}` },
    );

    expect(payload?.message).toBe("Cannot GET /account/confirm-deletionx");
    expect(JSON.stringify(payload)).not.toContain(token);
  });

  it("leaves an application's own 404 message alone", () => {
    // A question mark in a hand-written message is not a URL.
    const payload = run(new NotFoundException("Ce lien est invalide ?"), true);

    expect(payload?.message).toBe("Ce lien est invalide ?");
  });
});
