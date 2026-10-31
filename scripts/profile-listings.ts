/**
 * Profiling for the two listing reads whose growth was left to measurement:
 * `/places` reads every OPEN listing of the practices the map draws, and the
 * free-text `q` runs an `ILIKE` over title and description with no index
 * behind it.
 *
 * The measurement answers both over a corpus the script builds itself in a
 * throwaway database — the same throwaway-database discipline the e2e suites
 * run, with `prisma migrate deploy` replaying the real history — so a rerun
 * today starts from the same place a rerun next quarter will:
 *
 *   TEST_DATABASE_ADMIN_URL="postgres://…" DATABASE_URL="postgres://…" \
 *     bun run profile
 *
 * The knobs put the product's own scale (`PROFILE_PRACTICES=620`,
 * `PROFILE_LISTINGS_MAX=6`) around the two growth cases:
 * `PROFILE_LISTINGS_MAX=200` asks what a practice with hundreds of postings
 * costs the map, `PROFILE_PRACTICES=5000` asks what a corpus grown well past
 * today's costs the free-text search — the same cases named where those reads
 * are written. `PROFILE_PASSES` exists so the medians
 * rest on more runs than the ones a warm cache finishes before being noticed.
 *
 * Every scenario runs against the real `ReplacementlistingsService`, without
 * the HTTP layer in between: wall time, what the read answered, and the byte
 * length of what the service returns (the JSON the transport would carry) are
 * all measured, and the SQL the client actually sends is captured for an
 * `EXPLAIN ANALYZE` of its slowest statements — a `PREPARE`/`EXECUTE` pair,
 * so no filter is ever written a second time in SQL to explain the first one.
 *
 * The free-text scenarios are finally rerun against the candidate GIN trigram
 * index, created in — and dropped with — the throwaway database itself. The
 * before/after comparison comes from one corpus in one run, and no migration
 * changes until these numbers, rather than a prediction, ask for it.
 *
 * Run: `bun run profile`
 */

import { execFileSync } from "node:child_process";
import { Client } from "pg";

// ↓ Knobs, read before anything reads the environment.
const PRACTICE_COUNT = Number(process.env.PROFILE_PRACTICES ?? 620);
const LISTINGS_MIN = Number(process.env.PROFILE_LISTINGS_MIN ?? 1);
const LISTINGS_MAX = Number(process.env.PROFILE_LISTINGS_MAX ?? 6);
const PASS_COUNT = Number(process.env.PROFILE_PASSES ?? 5);
const MAP_PLACE_CAP = Number(process.env.PROFILE_MAP_PLACES ?? 200);
/** One practice in `N` left without coordinates, as the seed's corpus. */
const UNMAPPED_EVERY = Number(process.env.PROFILE_UNMAPPED_EVERY ?? 24);
/** The term the free-text scenarios search for. */
const SEARCH_TERM = process.env.PROFILE_Q ?? "elderly patients";
/** The chunk a `createMany` pushes in one statement. */
const BATCH = 500;

/** The throwaway database, named apart from the e2e ones. */
const PROFILE_DB = process.env.PROFILE_DATABASE_NAME ?? "kineo_profile";

const PROFILE_DATABASE_URL = urlFor(PROFILE_DB);

function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`${name} is required to profile`);
  }
  return value;
}

/** The admin URL of the instance the throwaway database is created on. */
function adminUrl(): string {
  return requireEnv("TEST_DATABASE_ADMIN_URL");
}

/**
 * Credentials of the developer's own instance, like the e2e harness: the
 * throwaway database accepts the same role, and the pathname is rebuilt
 * rather than cleared, because an empty pathname leaves a bare `/`.
 */
function urlFor(database: string): string {
  const url = new URL(requireEnv("DATABASE_URL"));
  return `${url.protocol}//${url.username}:${url.password}@${url.host}/${database}${url.search}`;
}

async function runAs(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function dropIfExists(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  // A run killed mid-profiling leaves live connections, and DROP DATABASE
  // would block on them — the same thing every e2e teardown does.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [PROFILE_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${PROFILE_DB}"`);
  await admin.end();
}

/**
 * Deterministic picks, so a corpus of 620 practices is the same corpus next
 * run. The seed randomises; a profiling corpus is compared against itself,
 * and one that reshuffles between runs makes the comparison lie.
 */
function hash(index: number): number {
  return (index * 2654435761) % 4294967296;
}

function pick<T>(array: readonly T[], index: number): T {
  return array[hash(index) % array.length];
}

/** Rough city centres, spread like the seed's so a viewport clusters honestly. */
const CITIES: Array<{ name: string; latitude: number; longitude: number }> = [
  { name: "Paris", latitude: 48.8566, longitude: 2.3522 },
  { name: "Lyon", latitude: 45.764, longitude: 4.8357 },
  { name: "Marseille", latitude: 43.2965, longitude: 5.3698 },
  { name: "Toulouse", latitude: 43.6047, longitude: 1.4442 },
  { name: "Nice", latitude: 43.7102, longitude: 7.262 },
  { name: "Nantes", latitude: 47.2184, longitude: -1.5536 },
  { name: "Strasbourg", latitude: 48.5734, longitude: 7.7521 },
  { name: "Bordeaux", latitude: 44.8378, longitude: -0.5792 },
  { name: "Lille", latitude: 50.6292, longitude: 3.0574 },
  { name: "Rennes", latitude: 48.1173, longitude: -1.6778 },
];

/** The words a posting plausibly carries, for a search that matches like one. */
const TITLE_WORDS = [
  "Generalist replacement",
  "Dental filling",
  "Psychiatry consultations",
  "Urgent weekend cover",
  "Dermatology cabinet",
  "Psychiatric ward stand-in",
];
const DESCRIPTION_WORDS = [
  "Replacement needed during the holidays.",
  "A steady flow of patients, elderly people among them.",
  "Consultations at the practice, no house visits.",
  "Experience with elderly patients preferred.",
  "Schedule to be agreed with the incumbent.",
  "Full substitution over one month, weekends excepted.",
];
const SPECIALTIES = [
  "GENERALIST",
  "DENTIST",
  "DERMATOLOGIST",
  "PSYCHIATRIST",
] as const;

function listingFor(practiceIndex: number, withinPractice: number) {
  const index = practiceIndex * 10_000 + withinPractice;
  const start = new Date(
    Date.UTC(2026, 10, 1) + (hash(index) % 60) * 86_400_000,
  );
  return {
    id: `listing-${practiceIndex}-${withinPractice}`,
    practiceId: `practice-${practiceIndex}`,
    createdById: `profile-${practiceIndex}`,
    title: pick(TITLE_WORDS, index),
    startDate: start,
    endDate: new Date(start.getTime() + 3 * 86_400_000),
    specialty: pick(SPECIALTIES, index),
    status: "OPEN" as const,
    urgent: hash(index) % 11 === 0,
    description: hash(index) % 7 === 0 ? null : pick(DESCRIPTION_WORDS, index),
    maxApplications: null,
    createdAt: new Date(Date.UTC(2026, 8, 1) + (hash(index) % 30) * 86_400_000),
    updatedAt: new Date(),
  };
}

/**
 * The corpus every scenario stands on: one user and one owner profile per
 * practice, postings in the band the knobs name, all OPEN. No applications by
 * design: the reads profiled here answer from the listings and the organized
 * city coordinates, and the per-page application counts are a page-sized
 * aggregate the corpus size cannot move.
 */
async function createCorpus(
  prisma: import("../src/generated/prisma/client").PrismaClient,
): Promise<{ listings: number; unmapped: number }> {
  const userRows = Array.from({ length: PRACTICE_COUNT }, (_, index) => ({
    id: `user-${index}`,
    email: `owner-${index}@profile.test`,
    name: `Owner ${index}`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const profileRows = Array.from({ length: PRACTICE_COUNT }, (_, index) => ({
    id: `profile-${index}`,
    userId: `user-${index}`,
    specialty: pick(SPECIALTIES, index),
    profileType: "INSTALLED" as const,
    verified: true,
    isPublic: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const practiceRows = Array.from({ length: PRACTICE_COUNT }, (_, index) => {
    const city = pick(CITIES, index);
    const unmapped = index % UNMAPPED_EVERY === 0;
    return {
      id: `practice-${index}`,
      ownerId: `profile-${index}`,
      name: `Cabinet ${index}`,
      address: `${index + 1}, rue de la Santé`,
      city: city.name,
      latitude: unmapped ? null : city.latitude,
      longitude: unmapped ? null : city.longitude,
      isPublic: true,
      createdAt: new Date(),
    };
  });

  const listingRows: Array<ReturnType<typeof listingFor>> = [];
  for (let index = 0; index < PRACTICE_COUNT; index++) {
    // The band of postings one practice carries — the knob, so the stress
    // corpus can name the growth case instead of trusting the seed's average
    // to answer it.
    const spread =
      LISTINGS_MIN + (hash(index) % (LISTINGS_MAX - LISTINGS_MIN + 1));
    for (let within = 0; within < spread; within++) {
      listingRows.push(listingFor(index, within));
    }
  }

  for (let offset = 0; offset < PRACTICE_COUNT; offset += BATCH) {
    await prisma.user.createMany({
      data: userRows.slice(offset, offset + BATCH),
    });
    await prisma.profile.createMany({
      data: profileRows.slice(offset, offset + BATCH),
    });
    await prisma.practice.createMany({
      data: practiceRows.slice(offset, offset + BATCH),
    });
  }
  for (let offset = 0; offset < listingRows.length; offset += BATCH) {
    await prisma.replacementListing.createMany({
      data: listingRows.slice(offset, offset + BATCH),
    });
  }
  return {
    listings: listingRows.length,
    unmapped: practiceRows.filter((row) => row.latitude === null).length,
  };
}

// ————— Query capture and EXPLAIN —————

type CapturedQuery = { sql: string; params: string; durationMs: number };
const capturedQueries: CapturedQuery[] = [];

/**
 * The plans, over the statements Prisma actually sent. The SQL is not
 * rewritten: it is run under `EXPLAIN ANALYZE` with the params the client
 * passed as bind values, so the plan explains the query the service runs,
 * not a hand-copied relative of it that would be the drift the service
 * refuses.
 */
async function explainCaptured(capture: CapturedQuery): Promise<string | null> {
  let values: unknown[];
  try {
    const parsed: unknown = JSON.parse(capture.params);
    if (!Array.isArray(parsed)) {
      return null;
    }
    values = parsed;
  } catch {
    // The params print in one shape per Prisma version. A shape this script
    // cannot read loses only the plan for that statement, never the timings.
    return null;
  }

  const client = new Client({ connectionString: PROFILE_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query({
      text: `EXPLAIN (ANALYZE, BUFFERS) ${capture.sql}`,
      values,
    });
    return (result.rows.map((row) => row["QUERY PLAN"]) as string[]).join("\n");
  } catch (error) {
    return `EXPLAIN failed for this statement shape: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    await client.end();
  }
}

/** One line that says what a statement is, for the header above its plan. */
function labelCaptured(sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}…` : normalized;
}

/** What a read answered, beside the timings rather than instead of them. */
function describeRows(result: unknown): string {
  const shape = result as Record<string, unknown>;
  if (shape && "places" in shape) {
    return `${(shape.places as unknown[]).length}/${shape.totalPlaces} places, ${shape.unlocated} unlocated`;
  }
  if (shape && "data" in shape) {
    const meta = shape.meta as { total: number };
    return `page of ${(shape.data as unknown[]).length} / total ${meta.total}`;
  }
  if (shape && "total" in shape) {
    return `total ${shape.total}, urgent ${shape.urgent}`;
  }
  return "unknown shape";
}

interface PassReport {
  name: string;
  minMs: number;
  medianMs: number;
  maxMs: number;
  payloadBytes: number;
  rows: string;
}

async function measure(
  name: string,
  call: () => Promise<unknown>,
): Promise<PassReport> {
  // One warmup the buffers answer from, then the passes that are measured: a
  // first-touch miss belongs to the corpus, not to the query.
  await call();

  const timings: number[] = [];
  let payloadBytes = 0;
  let rows = "";
  for (let pass = 0; pass < PASS_COUNT; pass++) {
    const started = performance.now();
    const result = await call();
    timings.push(performance.now() - started);
    payloadBytes = Buffer.byteLength(JSON.stringify(result));
    rows = describeRows(result);
  }
  timings.sort((a, b) => a - b);
  return {
    name,
    minMs: timings[0],
    medianMs: timings[Math.floor(timings.length / 2)],
    maxMs: timings[timings.length - 1],
    payloadBytes,
    rows,
  };
}

function printReports(title: string, reports: PassReport[]): void {
  console.log(`\n=== ${title} ===`);
  for (const report of reports) {
    console.log(
      `${report.name.padEnd(34)} ` +
        `median ${report.medianMs.toFixed(1).padStart(7)} ms ` +
        `(min ${report.minMs.toFixed(1)} / max ${report.maxMs.toFixed(1)}) ` +
        `· ${report.payloadBytes.toLocaleString("en-US").padStart(10)} bytes ` +
        `· ${report.rows}`,
    );
  }
}

/** One plan per captured statement, slowest first, capped so the run stays readable. */
function topCaptures(
  captures: CapturedQuery[],
  count: number,
): CapturedQuery[] {
  const byStatement = new Map<string, CapturedQuery>();
  for (const capture of captures) {
    // The same statement ran several passes: keep its slowest record, which is
    // the one whose plan explains why the others are that slow.
    const heard = byStatement.get(capture.sql);
    if (!heard || heard.durationMs < capture.durationMs) {
      byStatement.set(capture.sql, capture);
    }
  }
  return [...byStatement.values()]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, count);
}

async function printPlans(
  scenario: string,
  captures: CapturedQuery[],
): Promise<void> {
  console.log(`\n--- ${scenario} ---`);
  for (const capture of topCaptures(captures, 2)) {
    console.log(
      `statement (~${capture.durationMs.toFixed(1)} ms): ${labelCaptured(capture.sql)}`,
    );
    const plan = await explainCaptured(capture);
    if (plan) {
      for (const line of plan.split("\n")) {
        console.log(`    ${line}`);
      }
    }
  }
}

/** The candidate index this script measures. Created here only — see the header. */
const CANDIDATE_SEARCH_INDEX_SQL =
  "CREATE INDEX profile_candidate_search_trgm " +
  "ON replacement_listing " +
  "USING gin ((title || ' ' || coalesce(description, '')) gin_trgm_ops)";

/** The report card the run leaves: what exists, how big the reads cost in space. */
async function printDatabaseSizes(): Promise<void> {
  const client = new Client({ connectionString: PROFILE_DATABASE_URL });
  await client.connect();
  try {
    const answer = await client.query<{
      database_bytes: string;
      listings_table_bytes: string;
      listings_indexes_bytes: string;
    }>(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS database_bytes,
              pg_size_pretty(pg_relation_size('replacement_listing')) AS listings_table_bytes,
              pg_size_pretty(pg_indexes_size('replacement_listing')) AS listings_indexes_bytes`,
    );
    console.log("\n=== Sizes ===");
    for (const [key, value] of Object.entries(answer.rows[0])) {
      console.log(`${key.replace(/_bytes$/, "")}: ${value}`);
    }
  } finally {
    await client.end();
  }
}

type Scenario = {
  name: string;
  kind: "places" | "feed" | "facets";
  filters: Record<string, unknown>;
};

async function main() {
  console.log("=== Profiling the listing reads ===");
  console.log(
    `corpus: ${PRACTICE_COUNT} practices × ${LISTINGS_MIN}–${LISTINGS_MAX} open postings, ` +
      `${PASS_COUNT} measured passes, the map capped at ${MAP_PLACE_CAP} places, search "${SEARCH_TERM}"`,
  );

  // The environment has to exist before anything from src is imported: the
  // shared lib/prisma reads DATABASE_URL at module scope, the same order the
  // e2e harness keeps.
  await dropIfExists();
  await runAs(adminUrl(), `CREATE DATABASE "${PROFILE_DB}"`);
  process.env.DATABASE_URL = PROFILE_DATABASE_URL;
  process.env.NODE_ENV = "test";
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env },
    stdio: "pipe",
  });

  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { createPrismaAdapter } = await import("../src/lib/prisma");
  const { ReplacementlistingsService } = await import(
    "../src/replacementlistings/replacementlistings.service"
  );

  // One client, whose own logger answers as events: the capture feeds the
  // EXPLAIN step, and the run stays readable instead of a firehose.
  const prisma = new PrismaClient({
    adapter: createPrismaAdapter(PROFILE_DATABASE_URL),
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "warn" },
    ],
  });
  prisma.$on("query", (event) => {
    capturedQueries.push({
      sql: event.query,
      params: event.params,
      durationMs: event.duration,
    });
  });

  try {
    console.log("--- Building the corpus ---");
    const { listings, unmapped } = await createCorpus(prisma);
    console.log(
      `${listings.toLocaleString("en-US")} open listings across ` +
        `${PRACTICE_COUNT} practices (${unmapped} without coordinates)`,
    );

    type ServiceArguments = ConstructorParameters<
      typeof ReplacementlistingsService
    >;
    const service = new ReplacementlistingsService(
      prisma as ServiceArguments[0],
      {
        get: (key: string, fallback?: unknown) => fallback,
      } as ServiceArguments[1],
    );

    const scenarios: Scenario[] = [
      { name: "places: unfiltered", kind: "places", filters: {} },
      {
        name: 'places: city "Lyon"',
        kind: "places",
        filters: { city: "Lyon" },
      },
      { name: "places: urgent", kind: "places", filters: { urgent: true } },
      {
        name: `places: q "${SEARCH_TERM}"`,
        kind: "places",
        filters: { q: SEARCH_TERM },
      },
      { name: "feed: unfiltered", kind: "feed", filters: {} },
      {
        name: `feed: q "${SEARCH_TERM}"`,
        kind: "feed",
        filters: { q: SEARCH_TERM },
      },
      { name: "facets: unfiltered", kind: "facets", filters: {} },
    ];

    function runScenario(scenario: Scenario): Promise<unknown> {
      switch (scenario.kind) {
        case "places":
          return service.findPlaces(scenario.filters as never, MAP_PLACE_CAP);
        case "feed":
          return service.findAll({
            page: 1,
            limit: 20,
            ...scenario.filters,
          } as never);
        case "facets":
          return service.findFacets(scenario.filters as never);
      }
    }

    const reports: PassReport[] = [];
    for (const scenario of scenarios) {
      reports.push(await measure(scenario.name, () => runScenario(scenario)));
    }
    printReports("Scenario timings", reports);

    // The plans, per scenario: the capture window reopens for two passes, so
    // every statement printed belongs to the scenario heading it.
    for (const scenario of scenarios) {
      capturedQueries.length = 0;
      for (let pass = 0; pass < 2; pass++) {
        await runScenario(scenario);
      }
      await printPlans(scenario.name, [...capturedQueries]);
    }

    await printDatabaseSizes();

    // The free-text index, measured where it would land if the numbers asked
    // for one: created inside the throwaway database, measured against, and
    // dropped with it. It is not a proposal here either — it is the question
    // the free-text read left open, answered on the corpus that has to answer
    // it.
    const searchScenarios = scenarios.filter(
      (scenario) => "q" in scenario.filters,
    );
    if (searchScenarios.length > 0) {
      const before = reports.filter((report) =>
        searchScenarios.some((scenario) => scenario.name === report.name),
      );

      const client = new Client({ connectionString: PROFILE_DATABASE_URL });
      await client.connect();
      let buildMs = 0;
      try {
        const started = performance.now();
        await client.query(CANDIDATE_SEARCH_INDEX_SQL);
        buildMs = performance.now() - started;
      } finally {
        await client.end();
      }

      const after: PassReport[] = [];
      for (const scenario of searchScenarios) {
        after.push(await measure(scenario.name, () => runScenario(scenario)));
      }
      printReports(
        `Search timings with the candidate GIN trigram index (build: ${buildMs.toFixed(0)} ms)`,
        after,
      );
      for (const report of after) {
        const previous = before.find((entry) => entry.name === report.name);
        if (!previous) {
          continue;
        }
        const moved = report.medianMs - previous.medianMs;
        console.log(
          `${report.name}: median ${previous.medianMs.toFixed(1)} → ` +
            `${report.medianMs.toFixed(1)} ms (${moved >= 0 ? "+" : ""}${moved.toFixed(1)})`,
        );
      }

      const size = new Client({ connectionString: PROFILE_DATABASE_URL });
      await size.connect();
      try {
        const answer = await size.query<{ bytes: string }>(
          `SELECT pg_size_pretty(pg_relation_size('profile_candidate_search_trgm')) AS bytes`,
        );
        console.log(`candidate index size: ${answer.rows[0].bytes}`);
      } finally {
        await size.end();
        await runAs(
          PROFILE_DATABASE_URL,
          "DROP INDEX IF EXISTS profile_candidate_search_trgm",
        );
      }
    }

    console.log(
      "\nThe candidate index was measured in the throwaway database and dropped with it: " +
        "no migration in this repository has changed, and none should until a rerun of " +
        "this profile says so.",
    );
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      // Nothing hangs on this closure: the drop below terminates the strays.
    }
    await dropIfExists();
    console.log(
      `\n--- ${PROFILE_DB} dropped; rerun for the same corpus, or resize it with the PROFILE_* knobs ---`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
