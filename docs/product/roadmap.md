# Roadmap

[Documentation index](../README.md) - [Product overview](overview.md)

Checkboxes reflect the state of the repository, not a schedule. Items marked "deferred" are kept deliberately: they record a decision not to spend effort yet, so the reason is not lost.

## Shipped

- [x] Authentication: better-auth and Prisma, optional JWT, email verification, password reset.
- [x] Profile module: CRUD, public and private visibility, pagination, RPPS format validation.
- [x] Practice module: CRUD, geo search with a bounding-box pre-filter.
- [x] Replacement listing module: full lifecycle, capacity threshold, geo/date/specialty search.
- [x] Application module: apply, shortlist, accept/reject cascade, withdraw, view tracking.
- [x] Security hardening: throttling, Helmet, CORS, indexes, input validation, concurrency safety.
- [x] Account erasure under GDPR article 17: anonymization instead of deletion, keyed audit trail, third-party applications parked on ghost listings, purge after a grace period.
- [x] Automated test suite, unit and e2e, enforced in CI.

## Next

- [ ] Email notifications wired into the application lifecycle, through a dedicated `NotificationsModule`. The templates and the mailer exist; `ApplicationsService` does not call them yet.

## Deferred, not MVP-critical

- [ ] Messaging module: a conversation attached to an application.
- [ ] Frontend work beyond the early TanStack Router scaffolding.

<details>
<summary>Why auth decoupling is deferred</summary>

Introduce an `AuthPort` (`IAuthProvider`) behind a NestJS wrapper so better-auth becomes swappable. Until then, better-auth stays visible in controllers through `Session`, `UserSession`, and `AllowAnonymous` from `@thallesp/nestjs-better-auth`, in `lib/auth/index.ts` (`betterAuth`, `prismaAdapter`, plugins), in `email-verified.guard.ts`, and in the `hashPassword` call in `prisma/seed.ts`. This is technical debt to take on deliberately, not a blocker.

</details>

<details>
<summary>Why the email provider is not being swapped</summary>

Move email behind a `NotificationsModule` with an `EmailPort`. Nodemailer is already isolated in `lib/email/mailer.ts`, so the remaining work is functional decoupling: queue and retry, wiring into `ApplicationsService`, and provider-agnostic templates under `lib/email/templates/*`. Swapping Nodemailer itself is not the point.

</details>

## Version 2

- [ ] RPPS verification through the official API.
- [ ] PDF generation of the standard locum contract.
- [ ] Bilateral rating.
- [ ] Geolocated emergency alerts.

## Dependency watch

- [ ] `nestjs-zod` peer range. The project runs `nestjs-zod@5.5.0` on Nest 12. It works and is tested, but the package declares `@nestjs/common ^10 || ^11` and `@nestjs/swagger ^7.4.2 || ^8 || ^11`, so the combination is officially untested. When a release declares `^12`, upgrade and pin it with `bun test` plus the e2e suites in CI.

> **Note** - There is no scheduled check for that release. A network dependency in CI would only detect a change whose response is a manual upgrade. This entry is the reminder.
