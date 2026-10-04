import { hashPassword } from "better-auth/crypto";
import { Prisma } from "../src/generated/prisma/client";
import {
  ApplicationStatus,
  DecisionSource,
  ListingStatus,
  ProfileType,
  Specialty,
} from "../src/generated/prisma/enums";
import { createPrismaClient } from "../src/lib/prisma";

const prisma = createPrismaClient();

const PASSWORD = "Password123!";
const USER_COUNT = 40;
const LISTINGS_PER_PRACTICE = 3;
const MAX_APPLICATIONS_PER_LISTING = 5;

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
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
  GENERALIST: "généraliste",
  DENTIST: "dentiste",
  DERMATOLOGIST: "dermatologue",
  PSYCHIATRIST: "psychiatre",
  OTHER: "praticien",
};

const urgentTitleTemplates: Array<
  (label: string, city: string, practice: string) => string
> = [
  (label, city) => `Urgent : remplacement ${label} — ${city}`,
  (label, city) => `Remplacement immédiat ${label} à ${city}`,
  (label, city, practice) => `${practice} cherche ${label} en urgence`,
  (label, city) => `Dernière minute : ${label} recherché(e) — ${city}`,
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
  (label, city, _practice, duration) =>
    `Remplacement ${label} ${duration} — ${city}`,
  (label, city, _practice, _duration, month) =>
    `Recherche remplaçant(e) ${label} pour ${month}`,
  (label, city, practice, _duration, month) =>
    `${practice} : remplacement ${label} dès ${month}`,
  (label, city, _practice, _duration, month) =>
    `Remplacement ${label} à ${city} (début ${month})`,
  (label, city, practice) => `${practice} recrute un(e) remplaçant(e) ${label}`,
  (label, city, _practice, duration) =>
    `Remplacement ${label} ${duration} à ${city}`,
];

const absenceReasons = [
  "des congés d'été",
  "un congé maternité",
  "une formation continue",
  "un arrêt maladie",
  "des vacances scolaires",
  "un congé sabbatique",
  "des congés d'hiver",
];

const listingDescriptionTemplates = [
  (practice: string, city: string, reason: string) =>
    `${practice} (${city}) recherche un(e) remplaçant(e) pour ${reason}. Patientèle fidèle, équipe accueillante et matériel complet sur place.`,
  (practice: string, city: string, reason: string) =>
    `Période de ${reason} à couvrir. Plateau technique complet, secrétariat assuré, contact rapide privilégié.`,
  (practice: string, city: string, reason: string) =>
    `Nous cherchons un(e) remplaçant(e) pour ${reason}. ${practice} est situé au cœur de ${city}, stationnement facile.`,
  (practice: string, city: string, reason: string) =>
    `Remplacement à assurer pour ${reason}. Assistance administrative incluse, patientèle variée.`,
];

function getDurationLabel(days: number): string {
  if (days <= 5) return "de courte durée";
  if (days <= 12) return "d'une semaine";
  if (days <= 21) return "de deux semaines";
  if (days <= 35) return "d'un mois";
  return "de longue durée";
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

async function main() {
  console.log("--- Cleaning the database ---");

  await prisma.application.deleteMany();
  await prisma.replacementListing.deleteMany();
  await prisma.practice.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();

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
    "Cabinet Dentaire",
    "Cabinet Médical",
    "Centre Dentaire",
    "Centre Médical",
    "Cabinet",
    "SCM Dentaire",
    "Pôle Santé",
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
    "Autre candidat retenu",
    "Disponibilités incompatibles",
    "Profil déjà pourvu",
    "Spécialité non correspondante",
  ];
  const withdrawnReasons = [
    "J'ai finalement trouvé un autre remplacement",
    "Je ne suis plus disponible sur cette période",
    "La distance de déplacement est trop importante",
  ];

  const applicationMessageTemplates = [
    (title: string, from: string, to: string) =>
      `Bonjour, votre annonce « ${title} » correspond parfaitement à mes disponibilités du ${from} au ${to}. Je serais ravi(e) d'échanger avec vous.`,
    (title: string, from: string, to: string) =>
      `Bonjour, je suis intéressé(e) par le remplacement « ${title} ». Je suis disponible sur toute la période (${from} - ${to}) et peux passer au cabinet pour une rencontre préalable.`,
    (title: string) =>
      `Bonjour, je réponds à votre annonce « ${title} ». Habitué(e) aux remplacements, je peux vous transmettre mes références et mon planning.`,
    (title: string) =>
      `Bonjour, votre annonce « ${title} » m'intéresse beaucoup. N'hésitez pas à me contacter pour discuter des modalités pratiques.`,
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
