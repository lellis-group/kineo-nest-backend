# AI takeover notes

[Documentation index](../README.md) - [Conventions](conventions.md)

Constraints that must hold when an automated agent changes this codebase. They are collected here because each one is easy to violate with a locally plausible edit.

## Checklist

- The `User`, `Session`, `Account`, `Verification`, and `Jwks` models are managed by better-auth. Do not modify them by hand. If `User` needs more fields, use the better-auth CLI and regenerate.
- All business data - specialty, status, location - lives on `Profile`, never on `User`.
- Apply `email-verified.guard.ts` on **controllers**, not services. Nest guards have no effect on plain service methods.
- Ownership checks use the shared helpers in `common/profile-lookup.ts`; do not duplicate `findUnique` logic in another service.
- Any write that reads and then updates a shared counter, such as an application count or listing capacity, must go through `runSerializableTransaction` in `common/serializable-transaction.ts`.
- Zod entity schemas expose dates to Swagger with `z.iso.datetime()`. Plain `z.date()` breaks OpenAPI generation with `nestjs-zod` and Zod v4; do not reintroduce it.
- No payment or legal contract logic exists yet. Version 2 must handle it with particular care for GDPR and the health data indirectly linked through RPPS.

## Before declaring a change done

1. Run `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run test:e2e`.
2. Run `bun run db:check` if any migration or schema file changed.
3. Confirm the change respects the read-route authentication rules in [Conventions](conventions.md).
4. Confirm no new wall of untested branching logic was added to a lifecycle transition; see [Domain flows](../architecture/flows.md).

## Context map

| Question | Document |
|---|---|
| What is the product trying to do? | [Product overview](../product/overview.md) |
| Where does a field belong? | [Data model](../architecture/data-model.md) |
| What transitions are legal? | [Domain flows](../architecture/flows.md) |
| Which guard or transaction fits? | [Architecture overview](../architecture/overview.md), [Security and reliability](../operations/security.md) |
| What must CI pass? | [Testing and CI](../operations/testing.md) |
