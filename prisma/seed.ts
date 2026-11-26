import { hashPassword } from "better-auth/crypto";
import { SYSTEM_SCAFFOLD } from "../src/common/system-scaffold";
import { isHardenedEnv } from "../src/config/env";
import { Prisma } from "../src/generated/prisma/client";
import {
  ApplicationStatus,
  DecisionSource,
  ListingStatus,
  ProfileType,
  Specialty,
} from "../src/generated/prisma/enums";
import { deletionHash, deletionPepper } from "../src/lib/hash";
import { errorMessage } from "../src/lib/log";
import { createPrismaClient } from "../src/lib/prisma";

const prisma = createPrismaClient();

const PASSWORD = "Password123!";
/**
 * How much the seed builds, overridable per machine.
 *
 * The defaults are set past the interesting thresholds rather than merely
 * "bigger". The browse map caps at `browse.mapPlaces` practices and a popup
 * previews four postings per practice: a corpus under both has never drawn the
 * ceiling, never drawn the "+N others" line, and never drawn a place it could
 * not place.
 */
const USER_COUNT = Number(process.env.SEED_USERS ?? 800);
const PRACTICE_COUNT = Number(process.env.SEED_PRACTICES ?? 2000);
const MAX_APPLICATIONS_PER_LISTING = 8;

/** How many real communes the seed spreads its corpus over. */
const SEED_CITY_COUNT = Number(process.env.SEED_CITIES ?? 600);

/**
 * How many postings a practice publishes: one to six.
 *
 * Six, because four of them are all a popup shows. A corpus where no practice
 * exceeds that has never once drawn the line saying there are more.
 */
const LISTINGS_PER_PRACTICE = { min: 1, max: 8 };

/** One practice in `N` is left without coordinates. */
const UNMAPPED_EVERY = 24;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface SeedCity {
  codeInsee: string;
  nom: string;
  postalCode: string;
  departmentCode: string;
  codeRegion: string;
  latitude: number;
  longitude: number;
}

/** Minimal CSV reader: a quoted field may itself contain a comma. */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

/**
 * The COG 2026 reference, published as a gzip CSV by data.gouv.fr: one request
 * instead of paging the commune API, whose deep offsets answer 504. Still no
 * data kept in this file — the seed reads the same authoritative source the
 * frontend resolves places from.
 */
const COMMUNE_REFERENCE_URL =
  "https://www.data.gouv.fr/api/1/datasets/r/262afe2d-1c35-40da-ace0-a2eb595eaced";

async function loadSeedCities(): Promise<SeedCity[]> {
  const response = await fetch(COMMUNE_REFERENCE_URL, {
    signal: AbortSignal.timeout(60_000),
    headers: { Accept: "application/gzip" },
  });
  if (!response.ok) {
    throw new Error(
      `Unable to load the commune reference: HTTP ${response.status}`,
    );
  }

  const compressed = new Uint8Array(await response.arrayBuffer());
  const csv = new TextDecoder().decode(Bun.gunzipSync(compressed));
  const lines = csv.split("\n").filter((line) => line.trim().length > 0);
  const header = parseCsvLine((lines.shift() ?? "").replace(/\r$/, ""));
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`Missing ${name} in the commune reference`);
    }
    return index;
  };
  const fields = {
    code: column("code_insee"),
    nom: column("nom_standard"),
    departement: column("dep_code"),
    region: column("reg_code"),
    postal: column("code_postal"),
    population: column("population"),
    latitude: column("latitude_centre"),
    longitude: column("longitude_centre"),
  };

  const cities = lines
    .map((line) => parseCsvLine(line.replace(/\r$/, "")))
    .filter((row) => {
      const latitude = Number(row[fields.latitude]);
      const longitude = Number(row[fields.longitude]);
      return (
        Boolean(row[fields.code]) &&
        Boolean(row[fields.nom]) &&
        Boolean(row[fields.departement]) &&
        Number.isFinite(latitude) &&
        Number.isFinite(longitude)
      );
    })
    .sort(
      (left, right) =>
        Number(right[fields.population] ?? 0) -
        Number(left[fields.population] ?? 0),
    )
    .slice(0, SEED_CITY_COUNT)
    .map((row) => ({
      codeInsee: row[fields.code] as string,
      nom: row[fields.nom] as string,
      postalCode: row[fields.postal] ?? "",
      departmentCode: row[fields.departement] as string,
      codeRegion: row[fields.region] ?? "",
      latitude: Number(row[fields.latitude]),
      longitude: Number(row[fields.longitude]),
    }));

  if (cities.length === 0) {
    throw new Error("The commune reference returned no usable city");
  }
  return cities;
}

const specialtyLabels: Record<Specialty, string> = {
  GENERALIST: "general practitioner",
  DENTIST: "dentist",
  DERMATOLOGIST: "dermatologist",
  PSYCHIATRIST: "psychiatrist",
  OTHER: "practitioner",
};

const urgentTitleTemplates: Array<
  (label: string, city: string, practice: string) => string
> = [
  (label, city) => `Urgent: ${label} cover needed — ${city}`,
  (label, city) => `Immediate ${label} cover in ${city}`,
  (label, city, practice) => `${practice} urgently seeks a ${label}`,
  (label, city) => `Last minute: ${label} wanted — ${city}`,
];

const plannedTitleTemplates: Array<
  (
    label: string,
    city: string,
    practice: string,
    duration: string,
    month: string,
  ) => string
> = [
  (label, city, _practice, duration) => `${label} cover, ${duration} — ${city}`,
  (label, city, _practice, _duration, month) =>
    `Looking for a ${label} for ${month}`,
  (label, city, practice, _duration, month) =>
    `${practice}: ${label} cover from ${month}`,
  (label, city, _practice, _duration, month) =>
    `${label} cover in ${city} (starting ${month})`,
  (label, city, practice) => `${practice} is recruiting a ${label}`,
  (label, city, _practice, duration) =>
    `${label} cover, ${duration}, in ${city}`,
];

const absenceReasons = [
  "summer holidays",
  "maternity leave",
  "continued training",
  "a period of sick leave",
  "school holidays",
  "a sabbatical",
  "winter holidays",
];

const listingDescriptionTemplates = [
  (practice: string, city: string, reason: string) =>
    `${practice} (${city}) is looking for cover for ${reason}. Loyal patient base, a welcoming team and the equipment already on site.`,
  (practice: string, city: string, reason: string) =>
    `Cover needed for ${reason}. Fully equipped practice, reception handled, and quick contact preferred.`,
  (practice: string, city: string, reason: string) =>
    `We are looking for cover for ${reason}. ${practice} is in the heart of ${city}, with easy parking.`,
  (practice: string, city: string, reason: string) =>
    `Cover needed for ${reason}. Administrative support included, varied patient base.`,
];

function getDurationLabel(days: number): string {
  if (days <= 5) return "short notice";
  if (days <= 12) return "one week";
  if (days <= 21) return "two weeks";
  if (days <= 35) return "one month";
  return "a longer period";
}

function buildListingTitle(
  params: {
    urgent: boolean;
    specialty: Specialty;
    city: string;
    practiceName: string;
    startDate: Date;
    durationDays: number;
  },
  variant: number,
): string {
  const label = specialtyLabels[params.specialty];
  if (params.urgent) {
    const template =
      urgentTitleTemplates[variant % urgentTitleTemplates.length];
    return template(label, params.city, params.practiceName);
  }
  const template =
    plannedTitleTemplates[variant % plannedTitleTemplates.length];
  return template(
    label,
    params.city,
    params.practiceName,
    getDurationLabel(params.durationDays),
    MONTHS[params.startDate.getMonth()],
  );
}

/**
 * A deterministic random, so two seeds of the same corpus agree.
 *
 * `Math.random()` made every run differ: the count of open listings moved, a
 * geo assertion on a distance could pass and then fail after a re-seed of
 * nothing, and the map was never the same map twice. A fixed seed means
 * "re-seed" means something.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(0x5eed);

function getRandomItem<T>(array: T[]): T {
  return array[Math.floor(random() * array.length)];
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getFutureDate(daysToAdd: number): Date {
  return addDays(new Date(), daysToAdd);
}

function getPastDate(daysAgo: number): Date {
  return addDays(new Date(), -daysAgo);
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Mirrors what the service writes when it settles an application: the practice
 * decides an acceptance or a rejection, the candidate decides a withdrawal, and
 * PENDING and SHORTLISTED are not decisions yet.
 */
function decisionSourceFor(
  status: ApplicationStatus,
): DecisionSource | undefined {
  switch (status) {
    case ApplicationStatus.ACCEPTED:
      return DecisionSource.PRACTICE_ACCEPTED;
    case ApplicationStatus.REJECTED:
      return DecisionSource.PRACTICE_REJECTED;
    case ApplicationStatus.WITHDRAWN:
      return DecisionSource.CANDIDATE_WITHDREW;
    default:
      return undefined;
  }
}

/**
 * Recomputes the fingerprints on an erasure trail written before this column
 * existed.
 *
 * The two migrations around it are deliberately split: the first adds the
 * columns, the second makes them NOT NULL and drops the plaintext ones. A
 * database that still holds trail rows fails the second one rather than losing
 * them — art. 5(2) is an accountability record and is not ours to rewrite — and
 * this step is the repair in between.
 *
 * A no-op once the plaintext columns are gone, which is the normal state.
 */
async function backfillErasureFingerprints() {
  let pepper: string;
  try {
    pepper = deletionPepper();
  } catch {
    console.log(
      "--- Skipping the erasure trail backfill: DELETION_PEPPER is not set ---",
    );
    return 0;
  }

  const rows = await prisma.$queryRaw<
    { id: string; userId: string; email: string }[]
  >`SELECT "id", "userId", "email" FROM "data_deletion_request"
    WHERE "userIdHash" IS NULL OR "emailHash" IS NULL`;

  for (const row of rows) {
    await prisma.$executeRaw`
      UPDATE "data_deletion_request"
      SET "userIdHash" = ${deletionHash(row.userId, pepper)},
          "emailHash" = ${deletionHash(row.email, pepper)},
          "updatedAt" = NOW()
      WHERE "id" = ${row.id}`;
  }

  return rows.length;
}

/**
 * The rows an account erasure parks other candidates' applications on.
 *
 * Fixed ids, one per installation, created here rather than in a migration
 * because this is data and not schema. Idempotent, so it survives a reseed.
 *
 * The user row is not an account: `deletedAt` stays NULL, because the purge
 * sweep matches on that column and this row must never be a candidate for it.
 */
async function ensureSystemScaffold() {
  const now = new Date();

  await prisma.user.upsert({
    where: { id: SYSTEM_SCAFFOLD.userId },
    create: {
      id: SYSTEM_SCAFFOLD.userId,
      email: SYSTEM_SCAFFOLD.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    update: {},
  });

  await prisma.profile.upsert({
    where: { id: SYSTEM_SCAFFOLD.profileId },
    create: {
      id: SYSTEM_SCAFFOLD.profileId,
      userId: SYSTEM_SCAFFOLD.userId,
      specialty: Specialty.GENERALIST,
      profileType: ProfileType.INSTALLED,
      verified: true,
      isPublic: false,
      createdAt: now,
      updatedAt: now,
    },
    update: {},
  });

  await prisma.practice.upsert({
    where: { id: SYSTEM_SCAFFOLD.practiceId },
    create: {
      id: SYSTEM_SCAFFOLD.practiceId,
      ownerId: SYSTEM_SCAFFOLD.profileId,
      name: "System (withdrawn listings)",
      address: "-",
      city: "-",
      isPublic: false,
      createdAt: now,
    },
    update: {},
  });
}

async function main() {
  if (
    isHardenedEnv(process.env.NODE_ENV) &&
    process.env.ALLOW_DESTRUCTIVE_SEED !== "true"
  ) {
    // Every table is wiped below, and the accounts it recreates all share one
    // password that is in this repository. Run against a hardened database that
    // is total data loss plus 40 accounts anyone with the source can sign in to,
    // which is why the override has to be spelled out rather than implied.
    throw new Error(
      "db:seed wipes every table and refuses to run outside development/test: " +
        "set ALLOW_DESTRUCTIVE_SEED=true to override",
    );
  }

  // Before the wipe, and never fatal: a trail row that cannot be repaired must
  // not stop the rest of the seed.
  try {
    const repaired = await backfillErasureFingerprints();
    if (repaired > 0) {
      console.log(`--- Repaired ${repaired} erasure trail rows ---`);
    }
  } catch (error) {
    console.log(
      `--- Erasure trail backfill skipped: ${errorMessage(error)} ---`,
    );
  }

  console.log("--- Cleaning the database ---");

  await prisma.application.deleteMany();
  await prisma.replacementListing.deleteMany();
  await prisma.practice.deleteMany({});
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  // The scaffold user is not a person: its `deletedAt` stays NULL, because the
  // purge sweep matches on that column.
  await prisma.user.deleteMany();

  await ensureSystemScaffold();

  console.log("--- Creating users, Better Auth accounts, and profiles ---");

  const firstNames = [
    "Alice",
    "Bob",
    "Charlie",
    "David",
    "Eve",
    "Frank",
    "Grace",
    "Heidi",
    "Ivan",
    "Judy",
    "Kevin",
    "Lara",
    "Mallory",
    "Nancy",
    "Oscar",
    "Peggy",
    "Quentin",
    "Sarah",
    "Trent",
    "Victor",
  ];
  const lastNames = [
    "Martin",
    "Durand",
    "Dubois",
    "Thomas",
    "Robert",
    "Richard",
    "Petit",
    "Leroy",
    "Moreau",
    "Simon",
    "Laurent",
    "Lefebvre",
    "Michel",
    "Garcia",
    "David",
    "Bertrand",
    "Roux",
    "Vincent",
    "Fournier",
    "Faure",
  ];
  const seedCities = await loadSeedCities();
  const cityByCode = new Map(seedCities.map((city) => [city.codeInsee, city]));
  const specialties = Object.values(Specialty);
  const profileTypes = Object.values(ProfileType);

  const createdProfiles = [];

  const defaultHashedPassword = await hashPassword(PASSWORD);

  for (let i = 0; i < USER_COUNT; i++) {
    const row = Math.floor(i / firstNames.length);
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[(i + row * 7) % lastNames.length];
    // The 20×20 name grid repeats after 400 rows; suffix later cycles so a
    // larger corpus keeps every email unique.
    const cycle = Math.floor(i / (firstNames.length * lastNames.length));
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${cycle > 0 ? cycle : ""}@medecin.fr`;
    const seedCity = seedCities[i % seedCities.length];
    const coordinates = seedCity;
    const specialty = specialties[i % specialties.length];
    const profileType = profileTypes[i % profileTypes.length];

    const userId = crypto.randomUUID();

    const user = await prisma.user.create({
      data: {
        id: userId,
        email: email,
        name: `${firstName} ${lastName}`,
        emailVerified: true,
        accounts: {
          create: {
            id: crypto.randomUUID(),
            accountId: userId, // CRUCIAL: accountId must equal userId for the credential provider
            providerId: "credential",
            password: defaultHashedPassword,
          },
        },
        profile: {
          create: {
            specialty: specialty,
            profileType: profileType,
            city: seedCity.nom,
            cityCodeInsee: seedCity.codeInsee,
            postalCode: seedCity.postalCode,
            departmentCode: seedCity.departmentCode,
            verified: i % 3 !== 0,
            isPublic: true,
            latitude: coordinates.latitude + (random() - 0.5) * 0.2,
            longitude: coordinates.longitude + (random() - 0.5) * 0.2,
          },
        },
      },
      include: { profile: true },
    });

    if (user.profile) {
      createdProfiles.push(user.profile);
    }
  }

  console.log("--- Creating medical practices ---");

  const practiceOwners = createdProfiles.filter(
    (p) =>
      p.profileType === ProfileType.INSTALLED ||
      p.profileType === ProfileType.BOTH,
  );

  const practicePrefixes = [
    "Dental Practice",
    "Medical Practice",
    "Centre Dentaire",
    "Medical Centre",
    "Practice",
    "SCM Dentaire",
    "Health Centre",
    "Polyclinique",
  ];
  const practiceQualifiers = [
    "des Lilas",
    "Victor Hugo",
    "de la Gare",
    "du Parc",
    "de la République",
    "Jean Jaurès",
    "des Oliviers",
    "Pasteur",
    "Molière",
    "Saint-Michel",
    "des Fleurs",
    "de la Paix",
  ];
  const streetTypes = [
    "rue",
    "avenue",
    "boulevard",
    "place",
    "allée",
    "chemin",
  ];
  const streetNames = [
    "de la République",
    "Victor Hugo",
    "Jean Jaurès",
    "de la Gare",
    "des Lilas",
    "Molière",
    "Pasteur",
    "de la Paix",
    "du Parc",
    "des Écoles",
    "Gambetta",
    "de la Liberté",
  ];

  const createdPractices = [];

  /**
   * More practices than there are owners to run them.
   *
   * Every other one runs a second practice, which is how a corpus crosses the
   * map's ceiling without inventing owners that do nothing but own.
   */
  const totalPractices = Math.max(
    PRACTICE_COUNT,
    Math.ceil(practiceOwners.length * 1.5),
  );

  for (let i = 0; i < totalPractices; i++) {
    // Owners cycle, so a practice is never orphaned and no owner carries
    // an unbounded number of them.
    const owner = practiceOwners[i % practiceOwners.length];
    const seedCity = owner.cityCodeInsee
      ? cityByCode.get(owner.cityCodeInsee)
      : undefined;
    const cityValue = seedCity?.nom ?? owner.city ?? "Paris";
    const coordinates = seedCity ?? {
      latitude: owner.latitude as number,
      longitude: owner.longitude as number,
    };

    {
      // One in `UNMAPPED_EVERY` is never geocoded. Not an error the seed is
      // papering over — a state the map has to render honestly: the posting is
      // in the list, the pin cannot be drawn, and `unlocated` reports how many.
      const unmapped = i % UNMAPPED_EVERY === UNMAPPED_EVERY - 1;

      const practice = await prisma.practice.create({
        data: {
          ownerId: owner.id,
          name: `${practicePrefixes[i % practicePrefixes.length]} ${
            practiceQualifiers[(i * 5) % practiceQualifiers.length]
          }`,
          address: `${3 + ((i * 7) % 70)} ${
            streetTypes[i % streetTypes.length]
          } ${streetNames[(i * 3) % streetNames.length]}`,
          city: cityValue,
          cityCodeInsee: owner.cityCodeInsee,
          postalCode: owner.postalCode,
          departmentCode: owner.departmentCode,
          latitude: unmapped
            ? null
            : coordinates.latitude + (random() - 0.5) * 0.08,
          longitude: unmapped
            ? null
            : coordinates.longitude + (random() - 0.5) * 0.08,
          isPublic: true,
        },
      });
      createdPractices.push({ practice, owner });
    }
  }

  console.log("--- Creating replacement listings ---");

  const createdListings = [];
  // Weighted so the feed mostly shows open listings while every lifecycle
  // state stays represented in the data
  const listingStatusPool = [
    ListingStatus.OPEN,
    ListingStatus.OPEN,
    ListingStatus.OPEN,
    ListingStatus.OPEN,
    ListingStatus.IN_DISCUSSION,
    ListingStatus.IN_DISCUSSION,
    ListingStatus.FULL,
    ListingStatus.FILLED,
    ListingStatus.DRAFT,
    ListingStatus.CLOSED,
    ListingStatus.CLOSED_NO_CANDIDATE,
  ];

  let listingVariant = 0;

  for (let i = 0; i < createdPractices.length; i++) {
    const { practice, owner } = createdPractices[i];
    const cityValue = practice.city;

    const listingCount = getRandomInt(
      LISTINGS_PER_PRACTICE.min,
      LISTINGS_PER_PRACTICE.max,
    );

    for (let j = 0; j < listingCount; j++) {
      const startDays = 3 + ((i * 3 + j) % 30) * 2;
      const durationDays = 4 + ((i + j * 2) % 6) * 3;
      const isUrgent = (i + j) % 4 === 0;
      const startDate = getFutureDate(startDays);

      const listing = await prisma.replacementListing.create({
        data: {
          practiceId: practice.id,
          createdById: owner.id,
          title: buildListingTitle(
            {
              urgent: isUrgent,
              specialty: owner.specialty,
              city: cityValue,
              practiceName: practice.name,
              startDate,
              durationDays,
            },
            listingVariant++,
          ),
          startDate,
          endDate: getFutureDate(startDays + durationDays),
          specialty: owner.specialty,
          status: getRandomItem(listingStatusPool),
          urgent: isUrgent,
          description: getRandomItem(listingDescriptionTemplates)(
            practice.name,
            cityValue,
            getRandomItem(absenceReasons),
          ),
          maxApplications: 3 + ((i + j) % 4),
        },
      });
      createdListings.push(listing);
    }
  }

  console.log("--- Creating applications ---");

  const applicants = createdProfiles.filter(
    (p) =>
      p.profileType === ProfileType.REPLACEMENT ||
      p.profileType === ProfileType.BOTH,
  );
  // Weighted so pending/shortlisted dominate, like a real inbox
  const applicationStatusPool = [
    ApplicationStatus.PENDING,
    ApplicationStatus.PENDING,
    ApplicationStatus.PENDING,
    ApplicationStatus.SHORTLISTED,
    ApplicationStatus.SHORTLISTED,
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.REJECTED,
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
  ];

  const rejectionReasons = [
    "Another candidate selected",
    "Availability does not match",
    "Position already filled",
    "Specialty does not match",
  ];
  const withdrawnReasons = [
    "I eventually found another cover",
    "I am no longer available over that period",
    "The distance is too far to commute",
  ];

  const applicationMessageTemplates = [
    (title: string, from: string, to: string) =>
      `Hello, your listing "${title}" fits my availability from ${from} to ${to} exactly. I would be glad to talk it through.`,
    (title: string, from: string, to: string) =>
      `Hello, I am interested in the "${title}" listing. I am available for the whole period (${from} - ${to}) and can come by for an informal meeting first.`,
    (title: string) =>
      `Hello, I am replying to your "${title}" listing. I cover regularly and can send my references and my diary.`,
    (title: string) =>
      `Hello, I am very interested in your "${title}" listing. Feel free to get in touch to discuss the practicalities.`,
  ];

  const applicationRows: Prisma.ApplicationCreateManyInput[] = [];

  for (const listing of createdListings) {
    // A draft is not visible to candidates, so nobody could have applied
    if (listing.status === ListingStatus.DRAFT) {
      continue;
    }

    const eligibleApplicants = applicants.filter(
      (applicant) => applicant.id !== listing.createdById,
    );
    const applicantCount = Math.min(
      getRandomInt(1, MAX_APPLICATIONS_PER_LISTING),
      eligibleApplicants.length,
    );

    for (const applicant of shuffle(eligibleApplicants).slice(
      0,
      applicantCount,
    )) {
      const status = getRandomItem(applicationStatusPool);
      // Applications were submitted between 4 and 40 days ago
      const createdAt = getPastDate(getRandomInt(4, 40));
      const isResponded =
        status === ApplicationStatus.ACCEPTED ||
        status === ApplicationStatus.REJECTED;

      applicationRows.push({
        listingId: listing.id,
        applicantId: applicant.id,
        status,
        // Without this every settled row reads as "nobody has decided yet", so
        // the decision filters on a candidate's screen return nothing while the
        // status totals count the same rows. The seed is where a freshly created
        // database gets the value the service writes.
        decisionSource: decisionSourceFor(status),
        message: getRandomItem(applicationMessageTemplates)(
          listing.title,
          listing.startDate.toLocaleDateString("fr-FR"),
          listing.endDate.toLocaleDateString("fr-FR"),
        ),
        rejectionReason:
          status === ApplicationStatus.REJECTED && random() < 0.7
            ? getRandomItem(rejectionReasons)
            : null,
        withdrawnReason:
          status === ApplicationStatus.WITHDRAWN
            ? getRandomItem(withdrawnReasons)
            : null,
        viewedAt:
          status !== ApplicationStatus.PENDING || random() < 0.4
            ? addDays(createdAt, 1)
            : null,
        respondedAt: isResponded ? addDays(createdAt, 3) : null,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  // Batched, and awaited one batch at a time.
  //
  // `createMany` splits a large `data` array into several INSERTs, and past a
  // few thousand rows the adapter overlaps them on one connection — which `pg`
  // reports as "Calling client.query() when the client is already executing a
  // query", deprecated now and an error in pg 9. Slicing the array ourselves
  // hands each statement its own turn, and 5 986 rows stop being a warning.
  const APPLICATION_BATCH = 500;
  for (let i = 0; i < applicationRows.length; i += APPLICATION_BATCH) {
    await prisma.application.createMany({
      data: applicationRows.slice(i, i + APPLICATION_BATCH),
    });
  }
  const applicationsCreated = applicationRows.length;

  console.log("--- Seed completed successfully ---");
  console.log(`- ${createdProfiles.length} users and profiles created.`);
  console.log(`- ${createdPractices.length} practices created.`);
  console.log(`- ${createdListings.length} listings created.`);
  console.log(`- ${applicationsCreated} applications created.`);
  console.log(
    "You can log in with any generated email (e.g., alice.martin@medecin.fr) and the password: Password123!",
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
