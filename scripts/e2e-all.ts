/**
 * Every e2e suite, found rather than listed.
 *
 * The chain in `package.json` named one file per suite, and a suite that nobody
 * remembered to add there did not run — in CI or locally. It already cost one
 * round of coverage: a new suite passed locally through its own script, was
 * never added to the chain, and the routes it covered were still reported as
 * untested. A test that has to be registered in a second place to exist is a
 * test that quietly does not exist.
 *
 * So the suites are discovered, and the per-suite scripts stay in `package.json`
 * for running one of them by hand while working on it.
 *
 * Sequential, one process per suite, and each with its own throwaway database
 * name: the suites reset the database between tests, so two of them at once
 * would delete each other's rows. The suite name is derived from the file, which
 * is why the harness reads it from the environment rather than being told it.
 *
 * Run: `bun run test:e2e`
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** Bun's own ceiling is 5 s per hook, which a cold Postgres boot can exceed. */
const TEST_TIMEOUT_MS = "15000";

function suitesIn(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...suitesIn(full));
    } else if (entry.endsWith(".e2e.test.ts")) {
      found.push(full);
    }
  }

  return found;
}

/**
 * The database name a suite gets, from its path.
 *
 * `src/common/e2e/third-party-cascade.e2e.test.ts` is `third-party-cascade`,
 * which is what the suite's own script calls it. A basename shared by two
 * suites would mean two suites resetting the same database, so the directory
 * disambiguates — and the guard below fails the run rather than letting it
 * happen quietly.
 */
function suiteNameFor(file: string, taken: Map<string, string>): string {
  const name = basename(file, ".e2e.test.ts");
  const previous = taken.get(name);

  if (previous) {
    throw new Error(
      `Two e2e suites would share the database "${name}": ${previous} and ${file}.\n` +
        "Rename one of them, or this run would reset the other's rows.",
    );
  }
  taken.set(name, file);

  return name;
}

/**
 * The floor on how many suites there are.
 *
 * `test:e2e:routes` guarantees that every serialized route is exercised *by
 * something*. It cannot notice a whole suite disappearing, because the route it
 * covered is usually touched by another one too — which is exactly how a suite
 * can be deleted, or emptied into nothing, without a single build going red.
 *
 * So the count of suites is a ratchet of its own, on the pattern of the coverage
 * floor: it only ever moves up, and moving it up is a one-line change reviewed
 * like any other. It catches deletion, not erosion — emptying a suite that stays
 * on disk is still visible in review and nowhere else.
 *
 * 17 after `proxy-ip` — the better-auth side of proxy-aware IP tracking, which
 * no other suite was positioned to check.
 *
 * 18 after `openapi` — the document swagger mounts only outside a hardened
 * environment, which is where the frontend reads it; nothing else would notice
 * a schema the generator refuses.
 */
const MIN_E2E_SUITES = Number(process.env.MIN_E2E_SUITES ?? 18);

const suites = suitesIn(SRC).sort();
if (suites.length === 0) {
  console.error("No e2e suite found under src/ — the discovery glob is wrong.");
  process.exit(1);
}

if (suites.length < MIN_E2E_SUITES) {
  console.error(
    `✖ ${suites.length} e2e suite(s) found, floor is ${MIN_E2E_SUITES}.\n\n` +
      "Either suites were deleted, or the floor is stale. A suite that goes away\n" +
      "silently leaves its routes covered by whichever suite happened to share\n" +
      "them, which is the one failure mode `test:e2e:routes` cannot see.",
  );
  process.exit(1);
}

const taken = new Map<string, string>();
const failures: string[] = [];

for (const file of suites) {
  const name = suiteNameFor(file, taken);
  const relative = file.slice(ROOT.length + 1);

  process.stdout.write(`\n━━ ${name} (${relative})\n`);

  const suite = Bun.spawn(["bun", "test", "--timeout", TEST_TIMEOUT_MS, file], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, KINEO_E2E_SUITE: name },
  });

  // Every suite runs, even after one fails: the first failure is rarely the
  // only one, and a report of two broken suites is worth more than the time
  // saved by stopping at the first.
  if ((await suite.exited) !== 0) {
    failures.push(relative);
  }
}

console.log(
  `\n${suites.length - failures.length}/${suites.length} e2e suites passed`,
);
if (failures.length > 0) {
  console.error(
    `\n✖ Failed suites:\n${failures.map((f) => `  ${f}`).join("\n")}`,
  );
  process.exit(1);
}
