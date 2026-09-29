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

function pathOnly(url?: string): string | undefined {
  if (!url) return undefined;
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
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

  private get isHardened(): boolean {
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

    if (this.isHardened) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse();
      const request = ctx.getRequest();
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      this.logger.error(
        `HTTP ${status} on ${request?.method} ${pathOnly(request?.url)}: ${exception.message}`,
      );

      const sanitizedResponse = {
        statusCode: status,
        message: status >= 500 ? "Internal server error" : exception.message,
        // Preserved from an exception that carries one. A single status can
        // mean several unrelated things — 409 covers both "a third party
        // blocks this" and "no matching pending request exists" — and without a
        // discriminator the client can only guess, and guesses wrong. Only
        // echoed when the exception supplies it, so the body shape is
        // unchanged for every existing route.
        ...(typeof codeOf(exceptionResponse) === "string"
          ? { code: codeOf(exceptionResponse) }
          : {}),
        path: pathOnly(request?.url),
        timestamp: new Date().toISOString(),
      };

      return response.status(status).json(sanitizedResponse);
    }

    super.catch(exception, host);
  }
}

/** Reads a `code` off an exception response, whether it is a string or an object. */
function codeOf(exceptionResponse: string | object): unknown {
  if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
    return (exceptionResponse as { code?: unknown }).code;
  }
  return undefined;
}
