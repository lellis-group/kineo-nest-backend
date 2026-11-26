# Documentation

[Back to README](../README.md)

This directory is a self-contained documentation set for the Kineo backend. It covers the product intent, the architecture, day-to-day development, operations, and the conventions that keep the codebase consistent. It does not require the frontend repository.

## Start here

| Goal | Read |
|---|---|
| Understand what the product does and why | [Product overview](product/overview.md) |
| Run the API locally | [Getting started](guides/getting-started.md) |
| Understand the code layout | [Architecture overview](architecture/overview.md), [Project conventions](reference/conventions.md) |
| Change the schema or write a migration | [Data model](architecture/data-model.md), [Conventions](reference/conventions.md) |
| Change application or listing transitions | [Domain flows](architecture/flows.md) |
| Deploy or harden an instance | [Configuration](guides/configuration.md), [Security and reliability](operations/security.md) |
| Handle a GDPR erasure request | [Account erasure](operations/account-erasure.md) |
| Prepare a pull request | [Testing and CI](operations/testing.md) |
| Work with an AI coding assistant | [AI takeover notes](reference/ai-takeover.md) |

## Product

- [Overview](product/overview.md) - market context, differentiation, MVP perimeter, and what is explicitly out of scope.
- [Roadmap](product/roadmap.md) - shipped features, planned work, and deferred technical debt with the reasoning behind each decision.

## Architecture

- [Overview](architecture/overview.md) - technology choices, module responsibilities, and the system diagram.
- [Data model](architecture/data-model.md) - better-auth tables, business entities, relationships, and constraints.
- [Domain flows](architecture/flows.md) - registration and email verification, listing publication, applying, and the two lifecycle state machines.

## Guides

- [Getting started](guides/getting-started.md) - prerequisites, local services, setup, and the command reference.
- [Configuration](guides/configuration.md) - environment variables, rate-limit tiers, resource caps, mail, and file storage.
- [API](guides/api.md) - Swagger, bearer authentication, route groups, and pagination rules.

## Operations

- [Security and reliability](operations/security.md) - access control, concurrency, rate limiting, transport security, email handling, indexes, and accepted risks.
- [Testing and CI](operations/testing.md) - unit suites, e2e suites, CI gates, migration drift, and query profiling.
- [Account erasure](operations/account-erasure.md) - the anonymization procedure, the keyed audit trail, and recovery from a partially applied migration.

## Reference

- [Conventions](reference/conventions.md) - rules that are not obvious from the code: migrations, test isolation, ordering, preview flags, and the browse feed.
- [AI takeover notes](reference/ai-takeover.md) - constraints that must hold when an automated agent changes this codebase.
