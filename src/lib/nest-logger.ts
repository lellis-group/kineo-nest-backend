import { ConsoleLogger } from "@nestjs/common";

/**
 * Nest's own logger, as single-line JSON.
 *
 * Domain events already leave as JSON through `./log`, so making Nest's own
 * lines (bootstrap, guards, the exception filter, the throttler) leave the same
 * way lets one pipeline index every record without a text parser. `flattenParams`
 * keeps structured params at the root, matching how `logEvent` spreads its data,
 * so both producers emit the same shape.
 */
export const nestLogger = new ConsoleLogger({
  json: true,
  flattenParams: true,
  colors: true,
});
