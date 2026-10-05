import {
  type ArgumentsHost,
  Catch,
  HttpException,
  Inject,
  Logger,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import { ZodSerializationException, ZodValidationException } from "nestjs-zod";
import { ZodError, type ZodIssue } from "zod";
import { isHardenedEnv } from "../../../config/env";

// Query strings carry single-use tokens, so they are kept out of the logged path
// and out of the response body.
function pathOnly(url?: string): string | undefined {
  if (!url) return undefined;
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * The same, for a message that embeds a URL.
 *
 * Needed because Nest's own "route not found" message *is* the URL, query string
 * included, so stripping the request path was not enough to keep a token out of
 * a 404 body. An exception message can equally quote the URL it was about.
 */
function withoutQueryString(message: string): string {
  const queryStart = message.indexOf("?");
  if (queryStart === -1) return message;

  // Stop at the first character that ends the URL rather than assume the message
  // ends with it: "Cannot GET /x?token=abc (already handled)" must keep its tail.
  const rest = message.slice(queryStart + 1);
  const terminator = rest.search(/[\s"'`)\]}]/);
  if (terminator === -1) return message.slice(0, queryStart);

  return message.slice(0, queryStart) + "<redacted>" + rest.slice(terminator);
}

/**
 * The machine-readable code an exception carries, when it carries one.
 *
 * `refusal()` and the erasure endpoint both raise a body of
 * `{ statusCode, code, message }` and the client branches on `code`. This filter
 * rebuilt the body from `exception.message` alone, so in a hardened environment
 * every one of those codes was dropped — while development, which delegates to
 * the base filter, kept them. The same request would then be read two different
 * ways depending on where it ran.
 *
 * Echoed only when the exception supplies one, so every route that has no code
 * keeps the body shape it had.
 */
function codeOf(body: string | object | undefined): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = (body as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

@Catch(HttpException)
export class HttpExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(
    httpAdapterHost: HttpAdapterHost,
    @Optional()
    @Inject(ConfigService)
    private readonly config?: ConfigService,
  ) {
    super(httpAdapterHost.httpAdapter);
  }

  private get isProduction(): boolean {
    return isHardenedEnv(
      this.config?.get<string>("nodeEnv") ?? process.env.NODE_ENV,
    );
  }

  catch(exception: HttpException, host: ArgumentsHost) {
    if (exception instanceof ZodSerializationException) {
      const zodError = exception.getZodError();
      if (zodError instanceof ZodError) {
        this.logger.error(`ZodSerializationException: ${zodError.message}`);
      }
    }

    if (exception instanceof ZodValidationException) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse();
      const zodError = exception.getZodError() as { issues: ZodIssue[] };
      const errors = zodError.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      }));

      return response.status(400).json({
        statusCode: 400,
        message: "Validation failed",
        errors,
      });
    }

    if (this.isProduction) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse();
      const request = ctx.getRequest();
      const status = exception.getStatus();
      const exceptionBody = exception.getResponse();
      const code = codeOf(exceptionBody);
      const message = withoutQueryString(exception.message);

      this.logger.error(
        `HTTP ${status} on ${request?.method} ${pathOnly(request?.url)}: ${message}`,
      );

      const sanitizedResponse = {
        statusCode: status,
        message: status >= 500 ? "Internal server error" : message,
        // A single status can mean several unrelated things — 409 covers both "a
        // third party blocks this" and "no matching pending request" — so without a
        // discriminator the client can only guess, and guesses wrong. Echoed only
        // when the exception supplies one, so routes without a code are unchanged.
        ...(code ? { code } : {}),
        path: pathOnly(request?.url),
        timestamp: new Date().toISOString(),
      };

      return response.status(status).json(sanitizedResponse);
    }

    super.catch(exception, host);
  }
}
