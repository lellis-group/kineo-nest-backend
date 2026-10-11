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
const USER_COUNT = Number(process.env.SEED_USERS ?? 260);
const PRACTICE_COUNT = Number(process.env.SEED_PRACTICES ?? 620);
const MAX_APPLICATIONS_PER_LISTING = 5;

/**
 * How many postings a practice publishes: one to six.
 *
 * Six, because four of them are all a popup shows. A corpus where no practice
 * exceeds that has never once drawn the line saying there are more.
 */
const LISTINGS_PER_PRACTICE = { min: 1, max: 6 };

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

/**
 * Rough city centres, so a geo search spreads across France instead of
 * clustering around Paris.
 *
 * Fifty-one of them, and the spread is the point: the browse map clusters by
 * viewport, so a corpus held to a dozen cities shows one cluster and proves
 * nothing about a count spread over a country.
 */
const cityCoordinates: Record<string, { latitude: number; longitude: number }> =
  {
    Paris: { latitude: 48.8566, longitude: 2.3522 },
    Lyon: { latitude: 45.764, longitude: 4.8357 },
    Marseille: { latitude: 43.2965, longitude: 5.3698 },
    Toulouse: { latitude: 43.6047, longitude: 1.4442 },
    Nice: { latitude: 43.7102, longitude: 7.262 },
    Nantes: { latitude: 47.2184, longitude: -1.5536 },
    Strasbourg: { latitude: 48.5734, longitude: 7.7521 },
    Montpellier: { latitude: 43.6108, longitude: 3.8767 },
    Bordeaux: { latitude: 44.8378, longitude: -0.5792 },
    Lille: { latitude: 50.6292, longitude: 3.0573 },
    Rennes: { latitude: 48.1173, longitude: -1.6778 },
    Grenoble: { latitude: 45.1885, longitude: 5.7245 },
    Rouen: { latitude: 49.4432, longitude: 1.0999 },
    Toulon: { latitude: 43.1242, longitude: 5.928 },
    "Saint-Étienne": { latitude: 45.4397, longitude: 4.3872 },
    "Le Havre": { latitude: 49.4944, longitude: 0.1079 },
    Reims: { latitude: 49.2583, longitude: 4.0317 },
    Dijon: { latitude: 47.322, longitude: 5.0415 },
    Angers: { latitude: 47.4784, longitude: -0.5632 },
    Brest: { latitude: 48.3904, longitude: -4.4861 },
    Nîmes: { latitude: 43.8367, longitude: 4.3601 },
    "Clermont-Ferrand": { latitude: 45.7772, longitude: 3.087 },
    "Le Mans": { latitude: 48.0061, longitude: 0.1996 },
    "Aix-en-Provence": { latitude: 43.5297, longitude: 5.4474 },
    Amiens: { latitude: 49.8941, longitude: 2.2958 },
    Tours: { latitude: 47.3941, longitude: 0.6848 },
    Limoges: { latitude: 45.8336, longitude: 1.2611 },
    Villeurbanne: { latitude: 45.7719, longitude: 4.8905 },
    Besançon: { latitude: 47.2378, longitude: 6.0241 },
    Orléans: { latitude: 47.9029, longitude: 1.9093 },
    Mulhouse: { latitude: 47.7508, longitude: 7.3359 },
    Metz: { latitude: 49.1193, longitude: 6.1757 },
    Caen: { latitude: 49.1829, longitude: -0.3707 },
    "Boulogne-Billancourt": { latitude: 48.8352, longitude: 2.2409 },
    Roubaix: { latitude: 50.6942, longitude: 3.1746 },
    Perpignan: { latitude: 42.6887, longitude: 2.8948 },
    Nancy: { latitude: 48.6921, longitude: 6.1844 },
    Argenteuil: { latitude: 48.9472, longitude: 2.2467 },
    Tourcoing: { latitude: 50.7239, longitude: 3.1612 },
    Valence: { latitude: 44.9334, longitude: 4.8924 },
    Pau: { latitude: 43.2951, longitude: -0.3708 },
    Calais: { latitude: 50.9513, longitude: 1.8585 },
    Avignon: { latitude: 43.9493, longitude: 4.8055 },
    "La Rochelle": { latitude: 46.1603, longitude: -1.1511 },
    Annecy: { latitude: 45.8992, longitude: 6.1294 },
    Antibes: { latitude: 43.5804, longitude: 7.1239 },
    Cannes: { latitude: 43.5528, longitude: 7.0174 },
    Colmar: { latitude: 48.0793, longitude: 7.3585 },
    Cherbourg: { latitude: 49.6337, longitude: -1.6222 },
    "Saint-Nazaire": { latitude: 47.2734, longitude: -2.2138 },
    Bourges: { latitude: 47.081, longitude: 2.3988 },
    Quimper: { latitude: 47.996, longitude: -4.1024 },
    Vannes: { latitude: 47.6582, longitude: -2.7608 },
    Bayonne: { latitude: 43.4929, longitude: -1.4748 },
  };

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
  const cities = Object.keys(cityCoordinates);
  const specialties = Object.values(Specialty);
  const profileTypes = Object.values(ProfileType);

  const createdProfiles = [];

  const defaultHashedPassword = await hashPassword(PASSWORD);

  for (let i = 0; i < USER_COUNT; i++) {
    const row = Math.floor(i / firstNames.length);
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[(i + row * 7) % lastNames.length];
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@medecin.fr`;
    const city = cities[i % cities.length];
    const coordinates = cityCoordinates[city];
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
            city: city,
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
    const cityValue = owner.city ?? "Paris";
    const coordinates = cityCoordinates[cityValue] ?? {
      latitude: owner.latitude,
      longitude: owner.longitude,
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
