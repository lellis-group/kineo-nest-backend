import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";

@ApiTags("App")
@Controller()
export class AppController {
  @AllowAnonymous()
  @Get()
  @ApiOperation({ summary: "Get API welcome message" })
  @ApiResponse({
    status: 200,
    description: "The application is answering",
    schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  })
  getRoot() {
    return {
      message: "hello",
    };
  }

  @AllowAnonymous()
  @Get("ping")
  @ApiOperation({ summary: "Health check endpoint" })
  @ApiResponse({
    status: 200,
    description: "The process is answering",
    schema: { type: "string" },
  })
  ping() {
    return "pong";
  }
}
