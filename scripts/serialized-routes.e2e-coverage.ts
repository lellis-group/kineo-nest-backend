/**
 * Every serialized route has to be exercised by an e2e suite.
 *
 * The delete route on listings answered 500 for two days and one e2e test caught
 * it only because that test happened to delete a listing on a branch where a
 * schema change had not landed. That was luck: the unit suite drives the
 * service, so a mismatch between a DTO and what a handler actually returns can
 * only be observed through the HTTP layer, and nothing was checking that any of
 * these routes went through it at all. A route added with a serializer and no
 * e2e coverage is the same failure waiting to be missed again.
 *
 * So the rule is stated once, here, and checked on every run: for each
 * controller route carrying `@ZodSerializerDto`, at least one e2e test must
 * issue that method and path.
 *
 * What this is not: it does not check that the e2e test asserts the right thing
 * about the answer, and it does not check unserialized routes. It is a floor —
 * the cheapest test that can only ever have found that class of bug, and the one
 * that fails on the commit that adds a route rather than the commit after it.
 *
 * Run: `bun run test:e2e:routes`
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** HTTP verbs a controller route can carry, in the order Nest spells them. */
const VERBS = ["Get", "Post", "Patch", "Put", "Delete"] as const;

interface Route {
  /** `GET`, `POST`… */
  method: string;
  /** The full path, prefix included: `/applications/:id/accept`. */
  path: string;
  /** Where the route is declared, for the report. */
  file: string;
  line: number;
}

function filesUnder(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...filesUnder(full));
    } else {
      found.push(full);
    }
  }

  return found;
}

/**
 * The serialized routes of one controller file.
 *
 * Parsed rather than imported: the application is what is being checked, and
 * booting it to read its route table would need a database and a config. The
 * decorator order is what this relies on — every route in this codebase
 * declares its verb, then its guards and swagger metadata, then its serializer,
 * then the handler — so the serializer belonging to a verb is the first one
 * after it.
 */
function serializedRoutesIn(file: string): Route[] {
  const source = readFileSync(file, "utf8");
  const prefix = source.match(/@Controller\(\s*["'`]([^"'`]*)["'`]/)?.[1] ?? "";
  const routes: Route[] = [];

  const verbPattern = new RegExp(
    `@(${VERBS.join("|")})\\(\\s*(?:["'\`]([^"'\`]*)["'\`])?\\s*\\)`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = verbPattern.exec(source)) !== null) {
    const [whole, verb, subPath = ""] = match;
    const window = source.slice(match.index, verbPattern.lastIndex + 400);

    // The serializer has to belong to *this* handler: a decorator of the next
    // one sits in the same window otherwise, so the scan stops at the next verb
    // declaration.
    const nextVerb = window
      .slice(whole.length)
      .search(/@(Get|Post|Patch|Put|Delete)\(/);
    const owned =
      nextVerb === -1 ? window : window.slice(0, whole.length + nextVerb);
    if (!owned.includes("@ZodSerializerDto")) {
      continue;
    }

    routes.push({
      method: verb.toUpperCase(),
      path: `/${[prefix, subPath].filter(Boolean).join("/")}`.replace(
        /\/{2,}/g,
        "/",
      ),
      file,
      line: source.slice(0, match.index).split("\n").length,
    });
  }

  return routes;
}

/** Every request an e2e suite issues, as `METHOD /path` with ids resolved to a wildcard. */
function requestsIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const pattern = /\.(get|post|patch|put|delete)\(\s*(["'`])([^"'`]*)\2/g;
  const requests: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const [, verb, , path] = match;
    // A path built from an id is `${id}` here; the route's `:id` matches it.
    requests.push(
      `${verb.toUpperCase()} ${path.replace(/\$\{[^}]*\}/g, ":x")}`,
    );
  }

  return requests;
}

const controllers = filesUnder(SRC).filter((file) =>
  file.endsWith(".controller.ts"),
);
const suites = filesUnder(SRC).filter((file) => file.endsWith(".e2e.test.ts"));

const routes = controllers.flatMap(serializedRoutesIn);
const requests = suites.flatMap(requestsIn);

/**
 * Whether a request hits a route.
 *
 * Compared segment by segment rather than as a prefix: `GET /applications/mine`
 * is not `GET /applications/:id`, and a prefix match would call the first proof
 * of the second.
 */
function hits(route: Route, request: string): boolean {
  const [method, ...requestSegments] = request.split(" ");
  if (method !== route.method) {
    return false;
  }

  const routeSegments = route.path.split("/").filter(Boolean);
  const asked = requestSegments.join("/").split("/").filter(Boolean);
  if (asked.length !== routeSegments.length) {
    return false;
  }

  return routeSegments.every((segment, at) => {
    if (segment.startsWith(":")) {
      return asked[at] !== undefined && asked[at].length > 0;
    }
    return segment === asked[at];
  });
}

const untouched = routes.filter(
  (route) => !requests.some((request) => hits(route, request)),
);

const relative = (file: string) => file.slice(ROOT.length + 1);

if (untouched.length === 0) {
  console.log(
    `✔ ${routes.length} serialized routes, all exercised by ${suites.length} e2e suites`,
  );
} else {
  console.error(
    `✖ ${untouched.length} serialized route(s) never exercised over HTTP:`,
  );
  for (const route of untouched) {
    console.error(
      `  ${route.method} ${route.path} — ${relative(route.file)}:${route.line}`,
    );
  }
  console.error(
    "\nA route with a serializer that no e2e suite calls is a DTO nothing checks: a\nmismatch between the schema and what the handler returns can only be observed\nthrough the HTTP layer, and this is the only test that notices one.",
  );
  process.exit(1);
}
