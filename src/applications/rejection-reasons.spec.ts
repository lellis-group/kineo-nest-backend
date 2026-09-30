import { describe, expect, it } from "bun:test";
import * as reasons from "./rejection-reasons";
import {
  ALL_PLATFORM_REJECTION_REASONS,
  ALL_REJECTION_REASON_STRINGS,
  AUTO_REJECTION_PLATFORM_REASONS,
  LEGACY_PLATFORM_REJECTION_REASONS,
  PLATFORM_REJECTION_REASONS,
  REASON_ANOTHER_CANDIDATE_SELECTED,
  REASON_CANDIDATE_UNAVAILABLE,
  REASON_LISTING_CANCELLED,
  REASON_LISTING_CLOSED,
  REASON_LISTING_CLOSED_NO_CANDIDATE,
  REASON_LISTING_ERASED,
} from "./rejection-reasons";

/**
 * Reasons that can be written, but can never be sitting on a row the erasure
 * preserves, with the mechanism that rules each out.
 *
 * Kept in the test rather than only in the module's comment because the module
 * comment is prose nobody re-reads when a code path changes, while this fails.
 */
const UNREACHABLE_REASONS: ReadonlySet<string> = new Set([
  // `close` and `cancel` call `terminateActiveApplications` BEFORE the status
  // flips, and a listing already out of circulation takes no new application,
  // so nothing they wrote survives to be read by the scrub.
  REASON_LISTING_CLOSED,
  REASON_LISTING_CLOSED_NO_CANDIDATE,
  REASON_LISTING_CANCELLED,
  // `releaseAcceptedPlacements` writes it on the erased person's OWN
  // applications, which become `WITHDRAWN` and are not preserved.
  REASON_CANDIDATE_UNAVAILABLE,
]);

/**
 * These lists are matched by value, so a reason that is written but not listed
 * is silently erased as if a practice had typed it, and a reason that is listed
 * but never written gives a false sense of coverage. Both failures are quiet:
 * no exception, just a candidate who loses the account of what happened to
 * their application.
 *
 * Every constant in this module therefore has to appear in one of the lists,
 * and the ones that are deliberately absent have to be named below with the
 * reason they cannot be reached. A new reason added to the file without a
 * decision here fails the test rather than being discovered in production.
 */
describe("rejection reason lists", () => {
  it("accounts for every reason the module can write", () => {
    const covered = new Set([
      ...ALL_PLATFORM_REJECTION_REASONS,
      ...AUTO_REJECTION_PLATFORM_REASONS,
    ]);

    // Discovered from the module's own exports rather than from a hand-kept
    // list: a list of the constants would move with them, so rewording one
    // would leave the lists stale and this test comparing a value against
    // itself. Naming them by export is what makes a forgotten reason visible.
    const declared = Object.entries(reasons)
      .filter(([name]) => name.startsWith("REASON_"))
      .map(([, value]) => value as string);

    const unaccounted = declared.filter(
      (reason) => !covered.has(reason) && !UNREACHABLE_REASONS.has(reason),
    );

    expect(unaccounted).toEqual([]);
  });

  it("is not mirrored by hand anywhere else in the source", async () => {
    // The duplication this suite cannot otherwise see. Two lists, same
    // question — is this string ours? — and the second one written out in a
    // consumer: it would keep compiling and simply stop matching the day a
    // reason is reworded, with the scrub then erasing a reason that is ours as
    // if a practice had typed it. The two lists this module exports are matched
    // by value, so no amount of asserting on them catches a copy elsewhere.
    //
    // Reads the sources rather than importing them: an import would evaluate
    // the very constants whose duplication is being checked.
    const glob = new Bun.Glob("{src,prisma}/**/*.ts");
    const offenders: string[] = [];
    // Scanned from the repository root, two levels up from `src/applications`.
    // One level too few matched nothing and the loop passed vacuously over an
    // empty file list — a test that can never fail. Verified by asserting the
    // scan is not empty.
    const root = new URL("../../", import.meta.url).pathname;
    const files: string[] = [];
    for await (const path of glob.scan({ cwd: root })) {
      files.push(path);
    }
    expect(files.length).toBeGreaterThan(0);

    for (const path of files) {
      // Specs legitimately spell a reason out — to seed a row, to assert the
      // literal, to check a historical spelling. The duplication worth failing
      // on is in code that runs.
      if (
        path.endsWith(".spec.ts") ||
        path.endsWith(".test.ts") ||
        path.endsWith("rejection-reasons.ts")
      ) {
        continue;
      }
      const source = await Bun.file(`${root}${path}`).text();
      for (const reason of ALL_REJECTION_REASON_STRINGS) {
        // A single-quoted literal, i.e. a hand-written copy. The French
        // constants are the ones that get copied: they are readable, which is
        // exactly what makes a paste look reasonable.
        if (source.includes(`'${reason}'`) || source.includes(`"${reason}"`)) {
          offenders.push(`${path}: ${reason}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps ALL_REJECTION_REASON_STRINGS in step with the exports", () => {
    // That constant exists for callers that want the whole vocabulary, and it
    // is the one place a new reason could be added without the reachability
    // test above noticing. This is the cross-check.
    const declared = Object.entries(reasons)
      .filter(([name]) => name.startsWith("REASON_"))
      .map(([, value]) => value as string);

    expect([...ALL_REJECTION_REASON_STRINGS].sort()).toEqual(
      [...declared, ...LEGACY_PLATFORM_REJECTION_REASONS].sort(),
    );
  });

  it("still excludes exactly the reasons documented as unreachable", () => {
    // If one of these ever became reachable — a new code path settling a listing
    // without touching its applications, say — the test above would keep
    // passing while the scrub kept erasing it. Asserting the set both ways stops
    // the exclusion from outliving its justification.
    for (const reason of UNREACHABLE_REASONS) {
      expect(ALL_PLATFORM_REJECTION_REASONS).not.toContain(reason);
      expect(AUTO_REJECTION_PLATFORM_REASONS).not.toContain(reason);
    }
  });

  it("keeps the legacy English spelling reachable from both lists", () => {
    // Rows written before the reasons were translated carry it. If the scrub
    // forgot it, a pre-translation row would be erased as a practice's free
    // text; if `releaseAcceptedPlacements` forgot it, that candidate would stay
    // rejected on a premise the erasure has just invalidated.
    const legacy = "Another candidate was selected for this listing";

    expect(ALL_PLATFORM_REJECTION_REASONS).toContain(legacy);
    expect(AUTO_REJECTION_PLATFORM_REASONS).toContain(legacy);
  });

  it("restores a narrower set than it protects, on purpose", () => {
    // `releaseAcceptedPlacements` puts candidates back in the pipeline for a
    // posting that still exists. `REASON_LISTING_ERASED` must not be in there:
    // restoring a row over a reason that means the listing is gone would put a
    // candidate back in front of a practice that no longer exists.
    expect(AUTO_REJECTION_PLATFORM_REASONS).toContain(
      REASON_ANOTHER_CANDIDATE_SELECTED,
    );
    expect(AUTO_REJECTION_PLATFORM_REASONS).not.toContain(
      REASON_LISTING_ERASED,
    );
    // A subset of the protected set, never a superset.
    for (const reason of AUTO_REJECTION_PLATFORM_REASONS) {
      expect(ALL_PLATFORM_REJECTION_REASONS).toContain(reason);
    }
  });

  it("excludes only reasons that cannot survive on a preserved row", () => {
    // The excluded three, each with the mechanism that makes it unreachable.
    // `close` and `cancel` settle the applications before the status flips, so
    // nothing they wrote is still sitting on the row when an account is erased.
    expect(PLATFORM_REJECTION_REASONS).not.toContain(REASON_LISTING_CLOSED);
    expect(PLATFORM_REJECTION_REASONS).not.toContain(REASON_LISTING_CANCELLED);
    // `releaseAcceptedPlacements` writes it on the erased person's OWN
    // applications, which become WITHDRAWN and are not preserved.
    expect(PLATFORM_REJECTION_REASONS).not.toContain(
      REASON_CANDIDATE_UNAVAILABLE,
    );

    // The two that can be found on a preserved row.
    expect(ALL_PLATFORM_REJECTION_REASONS).toContain(
      REASON_ANOTHER_CANDIDATE_SELECTED,
    );
    expect(ALL_PLATFORM_REJECTION_REASONS).toContain(REASON_LISTING_ERASED);
  });
});
