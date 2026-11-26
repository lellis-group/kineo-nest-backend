# Domain flows

[Documentation index](../README.md) - [Data model](data-model.md)

This page collects the four flows that define the product. All writes that touch shared counters are serializable transactions; see [Security and reliability](../operations/security.md).

## Registration and profile creation

```mermaid
sequenceDiagram
    actor U as User
    participant A as better-auth
    participant API as NestJS API
    participant DB as PostgreSQL
    participant Mail as SMTP

    U->>A: Sign up (email, password)
    A->>DB: Create User and Account
    A->>Mail: Send verification email
    A-->>U: Session token
    U->>API: POST /profile (specialty, profileType, city)
    Note over API: EmailVerifiedGuard blocks unverified accounts
    API->>DB: Create Profile linked to User
    API-->>U: Profile created
```

### Email links

Links in better-auth emails, for verification and password reset, are rewritten to the frontend pages `/verify-email` and `/reset-password` with the `FRONTEND_URL` variable. Those pages complete the flow through `authClient`, which proxies `/api/auth/*` to this API. The API remains the single authentication server and its endpoints are unchanged.

The API also exposes a custom better-auth endpoint, `GET /api/auth/check-email-verification?token=...`. Given a verification token, including an expired or already used one, it reports whether the account is already verified. The `/verify-email` page uses it to display the success screen when a user clicks an old link again, and the signup page shows a "check your inbox" confirmation with a resend action.

## Listing publication and application

```mermaid
sequenceDiagram
    actor I as Established doctor
    actor R as Locum doctor
    participant API as NestJS API
    participant DB as PostgreSQL

    I->>API: POST /replacement-listings (practiceId, dates, specialty)
    API->>DB: Create ReplacementListing (status = DRAFT)
    I->>API: PATCH /replacement-listings/:id/publish
    API->>DB: status = OPEN

    R->>API: GET /replacement-listings?specialty=...&city=...
    API->>DB: Search applicable listings (OPEN and IN_DISCUSSION)
    API-->>R: Paginated listings with active application count

    R->>API: POST /applications (listingId, message)
    Note over API: Serializable transaction: limits, ownership, listing status
    API->>DB: Create Application (status = PENDING)
    API->>DB: Recalculate listing status (OPEN / IN_DISCUSSION / FULL)

    I->>API: PATCH /applications/:id/accept
    Note over API: Serializable transaction: accept, reject competitors, fill listing
    API->>DB: Application ACCEPTED, others REJECTED, listing FILLED
```

> **Note** - The browse feed answers the applicable set: `OPEN` and `IN_DISCUSSION`. A `FULL` posting is excluded by construction. `RECRUITING_LISTING_STATUSES` is a wider set used by the owner console; the gap is a product decision, not an accident. See [Conventions](../reference/conventions.md).

## Listing lifecycle

```mermaid
stateDiagram-v2
    [*] --> DRAFT : creation
    DRAFT --> OPEN : publish
    OPEN --> IN_DISCUSSION : first active application
    IN_DISCUSSION --> FULL : maxApplications reached
    FULL --> IN_DISCUSSION : an application is withdrawn or rejected, below cap again
    IN_DISCUSSION --> FILLED : application accepted
    FULL --> FILLED : application accepted
    OPEN --> FILLED : application accepted
    OPEN --> CLOSED : closed by owner
    FILLED --> CLOSED : replacement completed
    DRAFT --> CANCELLED : cancelled by owner
    OPEN --> CANCELLED : cancelled by owner
    IN_DISCUSSION --> CANCELLED : cancelled by owner, active applications auto-rejected
    FULL --> CANCELLED : cancelled by owner, active applications auto-rejected
```

## Application lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING : applicant applies
    PENDING --> SHORTLISTED : owner shortlists
    PENDING --> ACCEPTED : owner accepts
    SHORTLISTED --> ACCEPTED : owner accepts
    PENDING --> REJECTED : owner rejects, or listing cancelled
    SHORTLISTED --> REJECTED : owner rejects, or listing cancelled
    PENDING --> WITHDRAWN : applicant withdraws
    SHORTLISTED --> WITHDRAWN : applicant withdraws
```

> **Note** - Shortlist and message edits go through optimistic compare-and-set instead of a serializable transaction: the write carries the expected status in its `where` clause, and zero affected rows means the decision changed in between. The shortlist-versus-accept race is pinned over HTTP in `applications-transitions.e2e.test.ts`.
