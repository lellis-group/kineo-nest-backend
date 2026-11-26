# Product overview

[Documentation index](../README.md) - [Roadmap](roadmap.md)

Kineo is a two-sided marketplace for medical replacements in France. Established practitioners publish a cover opening; locum doctors find it and apply. The product is deliberately narrower than a generic job board: it tries to remove the administrative work around a replacement.

## Market context

The market already has established players.

| Player | Positioning |
|---|---|
| MonRempla / Rempla | Regional network backed by the Medical Council; verification through the Council. Leader. |
| RemplaMed, MesRemplas, Remplaclinic, RemplaJob | Private actors offering classical matchmaking. |

> **Decision** - Kineo does not try to duplicate matchmaking. Its differentiation is the reduction of administrative friction around a replacement.

## Differentiation

| Axis | Description |
|---|---|
| Verification | RPPS or Medical Council status checked at registration. Declarative in the MVP; official API in V2. |
| Contract | Automatic generation of a pre-filled standard locum contract. Planned, not shipped. |
| Emergency | "Last-minute replacement" mode with alerts to nearby available locums. Planned, not shipped. |
| Reputation | Bilateral rating after a replacement, Airbnb style. Planned, not shipped. |
| Niche | Initial targeting of one specialty or a restricted geographical area rather than national coverage. |
| Communication | Applicants are never left in the dark: viewed and responded timestamps, shortlist status, and explicit rejection or withdrawal reasons. Shipped. |

The last axis is the one implemented in the MVP. It is what the application lifecycle and its status tracking are built around.

## MVP perimeter

The minimal functional scope is:

1. Registration and authentication, as an established doctor or a locum.
2. A doctor profile with specialty, status, and geographical area.
3. Publishing a replacement listing: practice, dates, specialty.
4. Searching and applying to a listing.
5. Application lifecycle with transparent status tracking. There is no messaging or conversation module yet.
6. Listing lifecycle: draft, open, in discussion, full, filled, closed, cancelled.

### Out of scope

- Contract generation
- Payment
- Real-time RPPS verification through an official API
- Ratings
- Messaging and conversation
- Payments and legal contract logic in general

> **Warning** - Compliance needs particular care in V2. RPPS numbers link indirectly to health data, and account erasure is already subject to GDPR article 17. See [Account erasure](../operations/account-erasure.md).

## Where the code stands

The MVP features are implemented and covered by automated tests. The remaining work is notifications wired into the application lifecycle, messaging, the frontend, and the V2 items above. See the [Roadmap](roadmap.md).
