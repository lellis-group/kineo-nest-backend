/**
 * A coverage floor, so coverage can only go up.
 *
 * The number was never enforced: `bun run test` reported nothing, so a change
 * that deleted the last test for a file lowered the figure silently, and the
 * only way anyone found out was a bug report months later. A ratchet does not
 * need a target to chase — it needs a number below the present one, checked on
 * every run, so a drop is a failed build with the diff in front of it.
 *
 * Both floors sit a little under the figure on the day they were written, and
 * both are read from the environment when set, so raising one is a one-line
 * change reviewed like any other — and so a service that legitimately dips can
 * be pinned without editing this file.
 *
 * The floors so far: 93/70 when the gate was written, at 93.81% of lines; then
 * 95/72 after the mapper, the erasure-email disclosure and the browse filters
 * were covered, at 95.97%. Each raise came with the work that paid for it.
 *
 * The unit suite is what is measured, and the e2e suites are excluded on
 * purpose: they exercise the same services over HTTP, but `bun test --coverage`
 * counts a file only if some test *in that run* imported it, and each e2e
 * suite boots its own application in its own process. Counting them here would
 * report the wiring as uncovered.
 *
 * Run: `bun run test:coverage`
 */

const MIN_LINES = Number(process.env.COVERAGE_MIN_LINES ?? 95);
const MIN_FUNCS = Number(process.env.COVERAGE_MIN_FUNCS ?? 72);

interface TableRow {
  file: string;
  funcs: number;
  lines: number;
  uncovered?: string;
}

/** The rows of `bun test --coverage`'s table, and its `All files` line. */
function parse(report: string) {
  const rows: TableRow[] = [];
  let totals: TableRow | undefined;

  for (const line of report.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 3 || !cells[0]) {
      continue;
    }
    const funcs = Number.parseFloat(cells[1] ?? "");
    const lines = Number.parseFloat(cells[2] ?? "");
    if (Number.isNaN(funcs) || Number.isNaN(lines)) {
      continue;
    }

    const row: TableRow = { file: cells[0], funcs, lines };
    if (cells[0] === "All files") {
      totals = row;
    } else if (cells[0].startsWith("src/")) {
      row.uncovered = cells[3];
      rows.push(row);
    }
  }

  return { totals, rows };
}

const suite = Bun.spawn(
  ["bun", "test", "src", "--path-ignore-patterns", "**/e2e/**", "--coverage"],
  { stdout: "inherit", stderr: "pipe" },
);

/**
 * The report is read off stderr, because that is where Bun writes it: the
 * suite's own results go to stdout and the coverage table is printed beside
 * them, on the other stream. Piping the wrong one silently finds no table.
 */
const decoder = new TextDecoder();
let report = "";
for await (const chunk of suite.stderr) {
  const text = decoder.decode(chunk);
  report += text;
  process.stderr.write(text);
}

const exitCode = await suite.exited;
if (exitCode !== 0) {
  // A failing suite is the test suite's own gate, not this one's: the floors
  // are not even reached.
  process.exit(exitCode);
}

const { totals, rows } = parse(report);

if (!totals) {
  console.error(
    "\n✖ No coverage table in the report — the gate cannot tell where it stands.",
  );
  process.exit(1);
}

const report2 = (label: string, measured: number, floor: number) =>
  `${measured >= floor ? "✔" : "✖"} ${label}: ${measured.toFixed(2)}% (floor ${floor}%)`;

console.log("");
const outcome = [
  report2("lines", totals.lines, MIN_LINES),
  report2("functions", totals.funcs, MIN_FUNCS),
];

// The ten files furthest from being covered, so a floor that is about to be hit
// says where the work is instead of only that it is needed.
const worst = rows
  .filter((row) => row.lines < 100)
  .sort((a, b) => a.lines - b.lines)
  .slice(0, 10);

if (worst.length > 0) {
  console.log("\nLeast covered files:");
  for (const row of worst) {
    const where = row.uncovered ? ` lines ${row.uncovered}` : "";
    console.log(`  ${row.lines.toFixed(2)}%  ${row.file}${where}`);
  }
}

console.log("");
for (const line of outcome) {
  console.log(line);
}

if (outcome.some((line) => line.startsWith("✖"))) {
  console.error(
    "\n✖ Coverage fell below the floor. Raise the floor when the work is done —\n" +
      "a floor that can only go up is what stops this number from mattering.",
  );
  process.exit(1);
}
