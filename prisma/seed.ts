import { hashPassword } from "better-auth/crypto";
import { SYSTEM_SCAFFOLD } from "../src/common/system-scaffold";
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
const USER_COUNT = 40;
const LISTINGS_PER_PRACTICE = 3;
const MAX_APPLICATIONS_PER_LISTING = 5;

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

// Rough city centers so geo searches spread across France instead of
// clustering around Paris
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

function getRandomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
    const j = Math.floor(Math.random() * (i + 1));
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
            latitude: coordinates.latitude + (Math.random() - 0.5) * 0.2,
            longitude: coordinates.longitude + (Math.random() - 0.5) * 0.2,
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

  for (let i = 0; i < practiceOwners.length; i++) {
    const owner = practiceOwners[i];
    const cityValue = owner.city ?? "Paris";
    const coordinates = cityCoordinates[cityValue] ?? {
      latitude: owner.latitude,
      longitude: owner.longitude,
    };

    // Most owners run a single practice, every fourth one runs a second one
    const practiceCount = i % 4 === 0 ? 2 : 1;

    for (let k = 0; k < practiceCount; k++) {
      const practice = await prisma.practice.create({
        data: {
          ownerId: owner.id,
          name: `${practicePrefixes[(i * 2 + k) % practicePrefixes.length]} ${
            practiceQualifiers[(i * 5 + k) % practiceQualifiers.length]
          }`,
          address: `${3 + ((i * 7 + k * 3) % 70)} ${
            streetTypes[(i + k) % streetTypes.length]
          } ${streetNames[(i * 3 + k) % streetNames.length]}`,
          city: cityValue,
          latitude: coordinates.latitude + (Math.random() - 0.5) * 0.08,
          longitude: coordinates.longitude + (Math.random() - 0.5) * 0.08,
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

    for (let j = 0; j < LISTINGS_PER_PRACTICE; j++) {
      const startDays = 3 + ((i * LISTINGS_PER_PRACTICE + j) % 30) * 2;
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
          status === ApplicationStatus.REJECTED && Math.random() < 0.7
            ? getRandomItem(rejectionReasons)
            : null,
        withdrawnReason:
          status === ApplicationStatus.WITHDRAWN
            ? getRandomItem(withdrawnReasons)
            : null,
        viewedAt:
          status !== ApplicationStatus.PENDING || Math.random() < 0.4
            ? addDays(createdAt, 1)
            : null,
        respondedAt: isResponded ? addDays(createdAt, 3) : null,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  await prisma.application.createMany({ data: applicationRows });
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
