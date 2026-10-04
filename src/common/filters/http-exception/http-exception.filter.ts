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

// Query strings carry single-use tokens, so they are kept out of the logged path
// and out of the response body.
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

  private get isProduction(): boolean {
    return (
      (
        this.config?.get<string>("nodeEnv", "development") ??
        process.env.NODE_ENV ??
        "development"
      ).toString() === "production"
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

      this.logger.error(
        `HTTP ${status} on ${request?.method} ${pathOnly(request?.url)}: ${exception.message}`,
      );

      const sanitizedResponse = {
        statusCode: status,
        message: status >= 500 ? "Internal server error" : exception.message,
        path: pathOnly(request?.url),
        timestamp: new Date().toISOString(),
      };

      return response.status(status).json(sanitizedResponse);
    }

    super.catch(exception, host);
  }
}
