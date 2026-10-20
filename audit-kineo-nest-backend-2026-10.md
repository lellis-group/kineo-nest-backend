# Audit technique — kineo-nest-backend (NestJS 12 + Prisma 7, octobre 2026)

## A. Résumé exécutif

**État général : excellent.** Il s'agit d'une base exceptionnellement bien travaillée : transactions sérialisables systématiques avec retry sur `P2034`, DTO Zod stricts avec sérialisation de sortie bornée, validation d'environnement fail-fast aux deux extrémités (Zod + plafonds de timers), redaction de secrets dans les logs, flows GDPR (art. 5(2), 16, 17) complets et testés, index partiels/trigram/GIN justifiés par des benchmarks consignés dans les commentaires, quinze suites e2e sérialisées sur app réelle, plus un ratchet de couverture.

Un grand nombre de problèmes classiques (N+1, offset pagination sans tiebreaker, mass-assignment, IDOR, contrôleurs qui contiennent la logique, `console.log` décoratif) sont déjà réglés. Je n'ai trouvé **aucune vulnérabilité critique confirmée (P0)**.

**Principaux risques identifiés (P1)** :
1. **better-auth perd l'IP client derrière un proxy** : `advanced.ipAddress` n'est pas configuré ; avec une chaîne `x-forwarded-for` de 2+ entrées (CDN + LB — cas standard), better-auth ne résout **aucune IP** → bucket de rate-limit unique partagé par tous les clients sur `/sign-in`, sessions stockées avec `ipAddress=""`. (AUD-001)
2. **Course « lost update » sur les transitions d'application** : `shortlist` peut re-abaisser une application `ACCEPTED` (concurrente) vers `SHORTLISTED` — `update` sans précondition de statut. (AUD-002)
3. **Rate-limiting better-auth en mémoire par process** : le ThrottlerModule a reçu une découpe Redis pour exactement ce problème ; better-auth, non. Replicas N = budget N× sur le brute-force. (AUD-003)

**Points forts à préserver** : le pattern `refusal(code)` + filtre hardened, `runSerializableTransaction`, `rejection-buckets` (règle unique TS + SQL), le scaffolding système idempotent, la validation `latLongsPaired`, la découpe anti-BREACH de compression, l'anti-enumeration (404 uniformes).

**Faiblesses principales** : résiduels de configuration better-auth/trust-proxy, une dépendance peer-incompatible (`nestjs-zod` 5.5 vs Nest 12), deux bugs latents basés sur des différences de contrat entre couches, et une dette mineure de maintenance (`nextCookies`, dépendance morte, duplication `cancel`, double construction du client auth).

**Répartition** : P0 : 0 — P1 : 3 — P2 : 7 — P3 : 9. Aucune correction urgente de sécurité critique, mais AUD-001/AUD-002 méritent une intervention rapide.

**Limites** : audit statique ; aucune mesure d'exécution (couverture, connexions, latence) n'a été relevée ; comportements vérifiés par lecture de `node_modules` et docs en ligne, pas par exécution (mode Plan).

---

## B. Cartographie de l'application

| Zone | Contenu |
|---|---|
| Bootstrap | `main.ts` (shutdown propre, log du trust proxy implicite), `app.ts` (`createApp` : helmet+CSP, compression filtrée, CORS, trust proxy à 1 hop, Swagger hors hardened) |
| Modules métier | `replacementlistings` (feed, browse map, facets, page-of, mutations de statut), `applications` (cycle PENDING→…→ACCEPTED/REJECTED/WITHDRAWN), `profile`, `practices` (recherche géo en `$queryRaw`), `account-deletion` (érase via token e-mail, ghost listings), `data-lifecycle` (sweeps cron + lock avis), `health` |
| Communs | `listing-status` (machine à états pure), `application-guard` (anti-cascade tierce), `pagination`, `refusal` (codes stables), guards (auth e-mail vérifiée, throttler token-aware), filtre d'exception hardened, `serializable-transaction` |
| Auth | `lib/auth` (better-auth 1.7.3 + adapter Prisma, hook de validation d'entrée, plugin de statut de vérification, plugin JWT optionnel), `@thallesp/nestjs-better-auth` (guard global, mounting `/api/auth`) |
| Données | Prisma 7.9.1, generator `prisma-client` (ESM, output `src/generated/prisma`), driver adapter `@prisma/adapter-pg`, 23 migrations dont index composites/partiels audités |
| Email | nodemailer + transporter injectable, templates HTML échappés, `safeUrl` anti-`javascript:` |
| Tests | 58 fichiers spec (unitaires, mocks Prisma à la main), 17 suites e2e sérialisées (DB jetable par suite), gate de couverture + ratchet de suites |

**Chemin d'exécution critique** : requête → AuthGuard (better-auth) → EmailVerifiedGuard (contrôle DB du flag) → ThrottlerGuard (4 tiers) → pipe Zod global → contrôleur → service → $transaction sérialisable → ZodSerializerInterceptor → HttpExceptionFilter.

**Zones de forte complexité/couplage** : `replacement-listings` ↔ `applications` (machine à états croisée via `recalcListingStatus`), `account-deletion` ↔ `system-scaffold` ↔ `ghost-listing` (le couple le plus délicat, mais solide et testé).

---

## C. Tableau de couverture de l'audit

| Composant | Responsabilité | Aspects examinés | Statut |
|---|---|---|---|
| `replacementlistings.service.ts` (1 149 l.) | CRUD + cycle de vie, feed/map/facets | transactions, quotas, guards, ordering, N+1, payloads, suivi décisions | **Analysé** |
| `applications.service.ts` (621 l.) | cycle de vie candidature | transactions, races (→ AUD-002/010), buckets, quotas, P2002 | **Analysé** |
| `profile.service.ts` | CRUD profil | propriété, P2002, guard tierce, spread DTO | **Analysé** |
| `practices.service.ts` + `geo-query.ts` | CRUD + recherche géo SQL | injection (paramètres liés), haversine, escape LIKE, races | **Analysé** |
| `account-deletion.service.ts`, `anonymize.ts`, `ghost-listing.ts`, `deletion-token.ts` | érase art. 17 | atomicité, trail, idempotence, P2002 (AUD-009) | **Analysé** |
| `data-lifecycle.service.ts` | sweeps + locks | batching, lock xact, horizons, orphelins | **Analysé** |
| `lib/auth/index.ts` (484 l.) + hooks + plugin + token | config better-auth | trustedProxies (AUD-001), cookieCache, plugins, IP (AUD-001), durée JWT (AUD-005) | **Analysé** |
| `lib/email` (mailer, templates, escape, links) | envoi e-mails | secrets, échappement, transporter injectable | **Analysé** (templates : survol) |
| `lib/prisma.ts`, `prisma.service.ts`, `lib/log.ts`, `lib/hash.ts`, `lib/nest-logger.ts` | infra | pools (AUD-020), logs redaction, HMAC-pepper | **Analysé** |
| Guards, filtre, throttle, pagination, listing-status, application-guard, refusal, system-scaffold | communs | logique, races, sérialisation, injection | **Analysé** |
| `config/configuration.ts` + `env.ts` | validation env | schéma Zod, fail-fast, hardened default | **Analysé** |
| Controllers (5) + DTO (15) + entities/mappers | contrat API | validation, strictness, sérialisation sortie, cache headers | **Analysé** |
| Schéma Prisma + 23 migrations | modèle de données | index/contraintes/CHECK/onDelete | **Analysé** |
| 58 specs unitaires + harnais e2e + scripts (coverage-gate, e2e-all, routes) | fiabilité | stratégie, mocks, isolation DB | **Partiellement analysé** (corps des 17 suites e2e survolé, harnais lu en entier) |
| `seed.ts`, Dockerfile, compose, README, biome | écosystème | reproductibilité, env, lint | **Analysé** (survol) |

Tous les services significatifs ont été passés en revue ; l'audit ne s'est pas limité à un échantillon.

---

## D. Registre détaillé des constats

### AUD-001 — better-auth ne résout plus d'IP client derrière un proxy
- **Catégorie** : sécurité / exploitation · **Statut** : confirmé (code + `node_modules`) · **Priorité** : P1 · **Effort** : faible
- **Localisation** : `src/lib/auth/index.ts` (bloc `advanced:` l. 400-402) ; `node_modules/@better-auth/core/dist/utils/ip.mjs` (`getIP`/`getIPFromHeader`) ; `dist/api/rate-limiter/index.mjs` l. 218-226.
- **Observation** : l'application est conçue derrière un proxy (`TRUST_PROXY` → `app.set("trust proxy", 1)`) et la config better-auth ne règle pas `advanced.ipAddress.trustedProxies`. Dans better-auth 1.7, `getIPFromHeader` ne résout une IP depuis `x-forwarded-for` que si la chaîne a **une seule** entrée sans `trustedProxies` ; dès 2+ entrées (CDN+LB, ou un client qui envoie son propre `X-Forwarded-For` que le proxy concatène), il renvoie `null` → le rate-limiter **avertit** puis place tous ces clients dans un bucket unique par chemin (`NO_TRUSTED_IP_KEY`), et `session.ipAddress` est enregistrée comme `""` (`internal-adapter.mjs` l. 263).
- **Impact** : le brute-force sur `/sign-in/email` n'est plus limité par IP (bucket partagé → verrouillage collectif ou passe-droits), impossible de rattacher un audit de session à une adresse ; le modèle `Session.ipAddress` devient vide en production. Le ThrottlerModule Nest, lui, est correct (il utilise Express `req.ips[0]` après `trust proxy`), d'où une incohérence de protection entre les deux couches.
- **Recommandation** : dériver `advanced.ipAddress.trustedProxies` de la même source que `trustProxy` (plage proxy config), ou forcer `ipAddressHeaders` sur un header posé par la plateforme. Vérifier qu'aucune session n'est créée sans IP après déploiement.
- **Documentation** : better-auth `rate-limit.md` (~1.7), lecture directe `@better-auth/core/dist/utils/ip.mjs` (vérifiée).
- **Validation** : test e2e simulant `x-forwarded-for: X, Y` derrière le proxy → sessions avec IP réelle ; 429 par IP distincte sur `/sign-in`.

### AUD-002 — `shortlist`/`update`/`markAsViewed` peuvent écraser une décision concurrente (`ACCEPTED` → `SHORTLISTED`)
- **Catégorie** : intégrité des données / concurrence · **Statut** : confirmé par le code (race plausible en production) · **Priorité** : P1 · **Effort** : faible
- **Localisation** : `src/applications/applications.service.ts` — `shortlist()` l. 412-432, `update()` l. 390-410 (check PENDING puis `update` non préconditionné ; pas de transaction) vs `accept()` (transaction sérialisée) l. 483-547.
- **Observation** : `shortlist` lit le statut hors transaction puis écrit `status: SHORTLISTED` via `prisma.application.update` sans condition de statut. `accept` rejette au passage toutes les candidatures actives voisines en `REJECTED PRACTICE_REJECTED` et passe la listing en `FILLED`. Si le propriétaire a deux onglets (ou un double-clic) et accepte pendant que l'autre onglet shortliste, l'écriture `SHORTLISTED` est **acceptée après le commit d'`ACCEPTED`** : candidature rejoint `ACCEPTED` puis se voit `SHORTLISTED`, sans que `withdrawReason`/`decisionSource` soit recalculé, tandis que la listing dit `FILLED` — invariant cassé.
- **Preuve** : chemin d'exécution : `loadForDecision` n'est utilisé que dans les 4 méthodes transactionnalisées ; `shortlist` ne l'utilise pas et n'a ni `runSerializableTransaction` ni `updateMany({ where: { id, status: "PENDING" }})` avec vérification `count`.
- **Recommandation** : écrire via `updateMany` avec la précondition de statut et lever `refusal(applicationNotShortlistable)` quand `count === 0` (pattern CAS documenté par Prisma : « updateMany avec la condition attendue et vérification count === 0 »). `markAsViewed` (idempotent par nature) et `update` (message d'une PENDING) peuvent garder la lecture + CAS léger.
- **Documentation** : prisma.io/docs (transactions / optimistic concurrency), postgresql.org `transaction-iso`.
- **Validation** : test unitaire où le faked update reçoit une précondition de statut ; test e2e de concurrence shortlist/accept.

### AUD-003 — Le rate-limiting better-auth reste en mémoire, par process
- **Catégorie** : sécurité / scalabilité · **Statut** : confirmé (défaut de better-auth, config absente) · **Priorité** : P2 (P1 si multi-replicas utilisés) · **Effort** : faible
- **Localisation** : `src/lib/auth/index.ts` l. 366-389 ; `dist/api/rate-limiter/index.mjs` (storage `memory` par défaut) ; `REDIS_URL` n'est consommé que par `src/common/throttle.ts`.
- **Impact** : avec N réplicas, les budgets better-auth (`RATE_LIMIT_MAX`, credential 3/10 s, changeEmail 10/15 min) deviennent N× ; même cas que celui que le ThrottlerModule a déjà résolu via `ThrottlerStorageRedisService`.
- **Recommandation** : `rateLimit: { storage: "redis", Redis(redisUrl) }` (better-auth 1.7 le supporte ; exigence « must be atomic » des storages personnalisés est remplie par l'implémentation officielle), conditionné comme pour le throttler.
- **Validation** : deux instances longue durée contre le même Redis → bucket partagé (script de charge court).

### AUD-004 — `nestjs-zod` 5.5.0 : peer-deps incompatibles avec Nest 12 / Swagger 12
- **Catégorie** : dépendances / fiabilité · **Statut** : confirmé (`node_modules/nestjs-zod/package.json`) · **Priorité** : P2 · **Effort** : faible
- **Observation** : peers déclarés `@nestjs/common ^10||^11`, `@nestjs/swagger ^7.4.2||^8||^11` ; le projet tourne sur 12.0.1. Le combo fonctionne aujourd'hui (vérifié dans les tests) mais est **officiellement untesté**.
- **Recommandation** : surveiller/monter vers une version nestjs-zod déclarant `^12`, et épingler le résultat dans un CI sur `bun test` + e2e. Aucune refonte nécessaire.

### AUD-005 — `JWT_EXPIRATION_TIME` en secondes nues plante le plugin JWT au runtime
- **Catégorie** : logique métier / contrat de dépendance · **Statut** : confirmé (latent) · **Priorité** : P2 · **Effort** : faible
- **Localisation** : `src/config/configuration.ts` (`jwt.expirationTime`, l. 323 ; `DurationString` accepte `"3600"`) vs `better-auth/dist/plugins/jwt/sign.mjs` l. 81 → `sec()` (`REGEX` exige une unité : `3600` → `TypeError: Invalid time string format`).
- **Impact** : `JWT_ENABLED=true` + `JWT_EXPIRATION_TIME=3600` passe la validation d'environnement et crash chaque émission de token en production.
- **Recommandation** : convertir en secondes numériques avant d'alimenter better-auth (`durationSeconds()` déjà disponible) — better-auth accepte un nombre. Idem pour `jwtRotationIntervalSeconds` (déjà correct).
- **Validation** : test unitaire sur `createAuth` avec env en secondes nues → expiration numérique cohérente.

### AUD-006 — `export const auth = createAuth()` construit un second better-auth + client Prisma au chargement, inutilement
- **Catégorie** : architecture / exploitation · **Statut** : confirmé · **Priorité** : P2 · **Effort** : faible
- **Localisation** : `src/lib/auth/index.ts` l. 484 ; `src/app.module.ts` (le chemin DI re-crée `createAuth` via ConfigService).
- **Impact** : chaque import du module (app, e2e, test) évalue `createAuth()` sur `process.env` : validation d'env à l'import (le secret doit exister avant même la config validée), un `PrismaClient` de plus (piégé à l'épargne de pool — voir AUD-020), et une seconde copie d'objet auth jamais utilisée dans le chemin Nest.
- **Recommandation** : exporter un lazy factory (`createStandaloneAuth()`) ou déplacer l'instance autonome dans le seul module chargé par scripts/seed. Faible risque de régression — le chemin DI ne change pas.

### AUD-007 — Plugin `nextCookies()` présent dans une application Express
- **Catégorie** : maintenabilité / léger runtime overhead · **Statut** : confirmé · **Priorité** : P3 · **Effort** : trivial
- **Localisation** : `src/lib/auth/index.ts` l. 3 et 225 ; `better-auth/dist/integrations/next-js.mjs`.
- **Observation** : plugin documenté exclusivement pour Next.js (page `integrations/next.md` — confirmé par subagent doc). Le before-hook tente `import("next/headers.js")` — le paquet n'est pas installé → échec attrapé, **et** la promesse mise en échec est réinitialisée donc re-résolue à chaque appel de `/get-session`. Les after-hooks ne font rien (pas de `Headers` cible). Le mounting se fait par le Node handler de `@thallesp` (`toNodeHandler`), qui écrit lui-même les cookies : le retirer est safe.
- **Recommandation** : supprimer l'import et l'usage. Vérifier les tests session-cookies après (le harnais e2e en a un : `session-cookie.e2e.test.ts`).

### AUD-008 — Dépendance morte `@better-auth/prisma-adapter`
- **Catégorie** : dépendances · **Statut** : confirmé · **Priorité** : P3 · **Effort** : trivial
- **Observation** : aucun import du paquet dans tout le dépôt (l'adapter est `better-auth/adapters/prisma`). Il reste installé et compilé inutilement.
- **Recommandation** : retirer de `package.json` (ou, à l'inverse, migrer l'import vers l'export canonique `@better-auth/prisma-adapter` si better-auth 2.0 déprécie l'ancien chemin — la doc 1.7 accepte les deux). Une seule décision, appliquée.

### AUD-009 — Double requête d'érase concurrente → `P2002` non contextualisé
- **Catégorie** : gestion d'erreurs · **Statut** : confirmé par le code · **Priorité** : P3 · **Effort** : faible
- **Localisation** : `src/lib/auth/index.ts` l. 323-346 (`$transaction` standard, pas de piège `P2002` sur le `create`).
- **Observation** : deux double-clics quasi simultanés sur « supprimer mon compte » : le second `$transaction` — après `updateMany SUPERSEDED` vu vide sous READ COMMITTED — insère un 2ᵉ `PENDING` et viole l'index unique partiel → `PrismaClientKnownRequestError` brute remontée dans better-auth (500 générique).
- **Impact** : faible (fail-fail-safe : aucun lien émis, l'utilisateur peut réessayer) ; mais la réponse perd le code de refus attendu.
- **Recommandation** : `catch` P2002 → lever `APIError("CONFLICT"…)` avec le message de l'utilisateur. Une isolation SERIALIZABLE locale (comme ailleurs) règle aussi le fond — la constante `runSerializableTransaction` existe.

### AUD-010 — Erreurs Prisma brutes atteignent le filtre par défaut de Nest
- **Catégorie** : gestion d'erreurs / cohérence contrat · **Statut** : confirmé structurellement (probable rarement à l'exécution) · **Priorité** : P3 · **Effort** : moyen
- **Localisation** : `src/common/filters/http-exception` (@Catch(HttpException) uniquement) ; ex. `profile.service.update` / `practices.service.update` : row supprimée entre la lecture de propriété et l'`update` → `P2025` → 500 par le filtre par défaut (le corps hardened « code/path/timestamp » n'est pas appliqué, la forme de réponse diffère).
- **Recommandation** : soit transformer localement les `update` de mutation en `updateMany` + `NotFoundException` (cohérent avec le style CAS d'AUD-002), soit ajouter un `PrismaExceptionFilter` qui mappe P2025 → 404, P2002 → 409 etc. Éviter la deuxième option si la première couvre les cas réels (moins de couches).

### AUD-011 — `cancel()` redécrit la lecture + la propriété déjà factorisées dans `assertOwnershipWith`
- **Catégorie** : duplication · **Statut** : confirmé · **Priorité** : P3 · **Effort** : trivial
- **Localisation** : `replacementlistings.service.ts` l. 1100-1115 vs `assertOwnershipWith` l. 894.
- **Recommandation** : réutiliser `assertOwnershipWith(tx, id, userId)` ; la sémantique est identique (les deux diffèrent seulement par l'ordre Listing/Profile lookup).

### AUD-012 — Divergence LIKE connue (géo vs Prisma `contains`)
- **Catégorie** : cohérence Produit/API · **Statut** : confirmé (documenté dans le code) · **Priorité** : P3 · **Effort** : faible
- **Localisation** : `src/practices/geo-query.ts` l. 120-139 vs `practices.service.findAll` l. 106-107.
- **Observation** : le chemin géo neutralise `%` et `_` ; le chemin non-géo non (`?name=%` a un comportement différent selon la présence de `lat/lng`). Le commentaire le reconnaît (« Neither path has a caller yet »).
- **Recommandation** : quand un premier appelant apparaît, neutraliser un des deux côtés (préférez le côté Prisma en échappant les wildcards, ou un `.refine` sur les filtres). En attendant, le risque reste documenté.

### AUD-013 — `/places` lit sans borne les listings des pratiques retenues
- **Catégorie** : performance · **Statut** : probable (nécessite mesure) · **Priorité** : P3 · **Effort** : moyen
- **Localisation** : `replacementlistings.service.ts` `findPlaces()` l. 674-677.
- **Observation** : ≤ 200 places (cap) mais **tous** les OPEN listings de ces pratiques sont lus ; l'assemblage coupe à 4 par place. À 6 listings/practice en seed (620 pratiques), c'est borné en pratique ; le risque apparaît avec des pratiques à centaines d'annonces.
- **Recommandation** : mesurer (EXPLAIN + taille de payload). Si la croissance l'exige, une `JOIN LATERAL` à `LIMIT 4` par place répondrait — mais le commentaire du service refuse à juste titre la redondance des prédicats SQL ; la décision doit venir de la mesure, pas de la théorie.
- **Prérequis** : benchmark sur corpus proche production.

### AUD-014 — Recherche libre `q` (`contains` sur title/description) sans index
- **Catégorie** : performance · **Statut** : probable (mesure requise) · **Priorité** : P3 · **Effort** : moyen
- **Localisation** : `replacementlistings.service.ts` `buildListingsWhere` l. 483-495.
- **Observation** : `ILIKE '%…%'` sur 2 colonnes → seq scan des OPEN. La table practice a déjà un index trigram pour `city`, pas les listings ; à l'échelle seed (≈ quelques milliers de lignes, filtrées OPEN) le scan est acceptable.
- **Recommandation** : si le corpus grandit, index GIN trigram sur `(title || ' ' || coalesce(description,''))` — à créer **avec** la mesure avant/après ; sinon ne rien faire (coûts d'écriture non amortis aujourd'hui).

### AUD-015 — Pools de connexions : 2 clients Prisma actifs + 1 fantôme, tailles implicites
- **Catégorie** : exploitation / scalabilité · **Statut** : confirmé · **Priorité** : P2 · **Effort** : faible-moyen
- **Localisation** : `src/lib/prisma.ts` (`new PrismaPg({ connectionString })` sans options de Pool), `prisma.service.ts` (2ᵉ adapter), `lib/auth` (3ᵉ client, AUD-006).
- **Observation** : `PrismaPg` sans `Pool` fournie crée un `pg.Pool` par défaut (max 10). La passée de client unique serait simple : `createAuth` accepte déjà un client injecté (`prismaClient?`), utiliser `PrismaService`.
- **Impact** : 20-30 connexions par replica au max, × N réplicas contre `max_connections` Postgres. Pas un bug aujourd'hui ; biais de croissance.
- **Recommandation** : injecter le client unique (PrismaService) dans `createAuth` dans la factory du module, et dimensionner explicitement le pool si multi-réplicas.
- **Dépendances** : AUD-006.

### AUD-017 — `trust proxy` codé à un seul hop
- **Catégorie** : configuration · **Statut** : confirmé · **Priorité** : P3 · **Effort** : trivial
- **Localisation** : `app.ts` l. 42-44.
- **Observation** : `app.set("trust proxy", 1)` suppose un unique reverse proxy. Derrière CDN + LB, `req.ips[0]` redevient une adresse spoofable. Un seul knob fait toute l'échelle.
- **Recommandation** : décision explicite (hop count ou liste de CIDR proxy) comme valeur dérivée de `TRUST_PROXY` — au minimum documenté dans l'exigence de déploiement. Interagit avec AUD-001 (mesures à prendre cohérentes d'une couche à l'autre).

### AUD-019 — `readAuthEnvFromConfig` bascule silencieusement vers `process.env`
- **Catégorie** : config / maintenabilité · **Statut** : confirmé · **Priorité** : P3 · **Effort** : faible
- **Localisation** : `lib/auth/index.ts` l. 150-156.
- **Observation** : face à un ConfigService « à la main » (doubles de tests) sans `auth.secret`, la fonction retombe sur `readAuthEnv(process.env)` — deux sources de vérité, une lecture temps d'import d'une variable que la factory a déjà validée.
- **Recommandation** : lever une erreur claire (« tester avec un ConfigService réel ou fournir authEnv explicite ») au lieu de la redirection silencieuse ; les tests concernés sont identifiables par le commentaire « hand-rolled doubles ».

---

## E. Analyse transversale

**1. Sécurité — le point faible est la couche better-auth, pas les contrôleurs.** Les contrôleurs appliquent proprement la propriété (404 uniformes anti-énumération, CAS, `createdById`/`userId` systématique) et la sérialisation Zod borne la sortie (vérifié : le parse strip les clés inconnues, donc les rows SQL/Prisma qui dribblent n'exposent rien). Les deux véritables impasses résiduelles (AUD-001/003) vivent dans la configuration better-auth — la couche où les problématiques « guard présent = contrôle appliqué » sont les plus sournoises. Une partie variable par environnement (trust proxies) reste du travail d'infra.

**2. Connaissance métier centralisée — un point d'exemplarité.** `listing-status.ts` + `rejection-buckets.ts` (règle TS ↔ SQL dérivée d'une seule spec) + `application-guard.ts` éliminent la duplication qui, historiquement, créait les incohérences signalées dans les commentaires. C'est le pattern à conserver et à imiter aux futures évolutions de statut.

**3. Gestion d'erreurs — deux fronts asymétriques.** Le chemin HTTP est remarquablement instrumenté (codes stables, redaction, 404 anti-enumeration) ; seul le chemin Prisma-brut (AUD-010) échappe au contrat. À régler au goutte-à-goutte, pas par un try/catch systématique.

**4. Prisma — usage de référence.** Transactions sérialisables là où nécessaire (mutateurs d'état), index audités par plan individuel et documentés dans les commentaires, opposition explicite entre vérification applicative et contrainte base (index unique partiel = la garantie, le CAS applicatif = l'expérience heureuse). Aucune recommandation Prisma de fond, hors consolidation du pool et vigilante évolution v8 (à cahier des charges plus tard).

**5. Tests.** Unitaires sur logique pure + e2e sérialisés sur app réelle = la bonne structure. Le harnais garantit déjà l'anti-bypass d'erase et les transitions ; les scénarios de concurrence réels (AUD-002) n'y figurent pas — c'est le seul trou de couverture démontrable.

---

## F. Plan d'action priorisé

### Phase 1 — Sécurisation (2 actions, ≈ 1-2 jours)
| Action | Fichiers | Problème | Solution | Tests validation | Risque régression |
|---|---|---|---|---|---|
| A1 (+A2) | `lib/auth/index.ts`, `config` | AUD-001 | configurer `advanced.ipAddress.trustedProxies` selon `TRUST_PROXY` (+ option audit) | e2e : x-forwarded-for multiple → session.ipAddress renseignée ; 429 par IP | test de dépôt prod : vérifier aussi l'IP correcte |
| A3 | `lib/auth` | AUD-003 (rate limit redis) | ajouter rateLimit.storage redis conditionné | script multi-instances | faible |

### Phase 2 — Intégrité (1 action, ≈ 1 jour)
| Action | Fichiers | Problème | Solution | Validation |
|---|---|---|---|---|
| B1 | `applications.service.ts` | AUD-002 : CAS sur `shortlist` / `update` (utiliser `updateMany + count`) ; `markAsViewed` peut rester | préconditions de status, refus cohérents | unit + e2e concurrence (2 onglets simulés) |

Les modifications B1/A1 sont indépendantes — peuvent partir ensemble vers production.

### Phase 3 — Performance & données (une décision basée sur mesure, 1 bloc)
- Injection du client unique pour better-auth (AUD-015/006) : sans frais à l'exécution, simplifie la mémoire et la config de logging.
- AUD-013/AUD-014 : ne rien écrire avant une mesure (payload + EXPLAIN sur corpus réaliste). Créer un script de profiling reproductible à partir de `seed.ts`.

### Phase 4 — Tests & fiabilité (0,5 j, en parallèle)
- Scénario e2e « accept en parallèle shortlist » (valide A1/B1) ; un test par utilisation d'un double CLI pour better-auth rate limiter ; garder le reste.

### Phase 5 — Dette & maintenance (1 j)
- Retirer `nextCookies` (AUD-007) ; retirer `@better-auth/prisma-adapter` (AUD-008) ; autoriser la config `JWT_EXPIRATION_TIME` en secondes (AUD-005) ; séchage `cancel` (AUD-011), `readAuthEnvFromConfig` (AUD-019), P2002 erasure (AUD-009), mapping P2025 (AUD-010, optionnel).
- Adapter le PEP par suivi nestjs-zod / TS7 / Prisma 8 (pas urgent).

---

## G. Quick wins
1. Supprimer `nextCookies` (2 lignes, zéro comportement, moins de travail à l'import).
2. Supprimer la dépendance morte `@better-auth/prisma-adapter`.
3. Remplacer `jwtExpirationTime` string → nombre via `durationSeconds` (résout un futur crash).
4. `cancel()` → `assertOwnershipWith` (3 lignes).
5. Mapper P2002 sur double requête d'erase (10 lignes, un message utile au client).

## H. Recommandations architecturales
- **Consolidation du client Prisma (AUD-015)** : c'est le seul ajustement structurel avec des bénéfices mesurables aujourd'hui (pool unique à auditer, une seule source de config de logging, contiguïté des « unit »). Faible coût, zéro changement de contrat.
- **Pas de refonte** : la séparation responsabilité service/contrôleur est bonne, le pattern « helpers purs + fonctions transactionnelles » fonctionne ; les préférents (jwt, redis, réplication) sont déjà pilotés par config. La doc Prisma 8 (retrait `$transaction`) est le prochain vrai point pivot de la roadmap technologique — pas aujourd'hui.

## I. Documentation consultée
- NestJS : `raw.githubusercontent.com/nestjs/docs.nestjs.com` (configuration.md, throttling/rate-limiting.md) — le site via webfetch échoue (SPA).
- @nestjs/throttler v6 : README GitHub (millisecondes, named throttlers, redis via @nest-lab).
- Prisma 7 : docs supply (transactions, index partiels `/orm/v7/prisma-schema/data-model/indexes`, pagination + tiebreakers). Attention : l'accueil docs sert maintenant Prisma **8** — à la migration, utiliser les chemins `/orm/v7/`.
- better-auth 1.7 : `better-auth.com/llms.txt` + pages (users-accounts, rate-limit, session-management, plugins/jwt, cookies, integrations/next.md). Page connexe non-consultée : référence `deleteTokenExpiresIn` (présent dans le code du projet et le dist, OK).
- npm registries : @thallesp/nestjs-better-auth, nestjs-zod, @better-auth/core, typescript 7.0.2, @nestjs/common 12.2.0, prisma 7.10.1 (versions confirmées).
- OWASP API Security Top 10 (2023) + Authentication Cheat Sheet. La cheat-sheet « Rate_Limiting_Bypass » **n'existe pas** (404) — le constat sur le rate limit s'appuie sur les deux premières sources et le code better-auth.
- PostgreSQL 18 : `transaction-iso` (retry sérialisation SQLSTATE 40001 ; sous SERIALIZABLE, un `unique` peut toujours lever après un check préalable) et `indexes-partial` (garantit le pattern one-active-row-per-key du projet).
- Vérifications directes `node_modules` (lecture seule) : `utils/ip.mjs` (AUD-001), `utils/time.mjs` (AUD-005), `nestjs-zod/package.json` (AUD-004), `adapter-pg/dist/index.js` (pool via pg.Pool, AUD-015), `integrations/next-js.mjs` (AUD-007), `dist/index.mjs` de nestjs-zod (sérialisation sortie : parse = strip des clés inconnues).

## J. Limites et vérifications restantes
- **Aucune exécution** en mode Plan : la couverture n'a pas été mesurée (le gate existe, sa valeur courante inconnue), l'effet réel `pool max` d'adapter-pg avec Bun non mesuré, aucun EXPLAIN réel.
- Les 17 corps de suite e2e et le `seed.ts` complets n'ont pas été lus ligne à ligne (le harnais et les points critiques, oui) — statut « partiellement analysé ».
- `advanced.ipAddress.trustedProxies` : valeur exacte à obtenir en fonction de l'infra réelle (combien de hops ? qui pose le header ?) — décision de déploiement à confirmer.
- AUD-013/AUD-014 (perf) : nécessitent un benchmark avant toute écriture.
- `nestjs-zod` : corriger quand une version peer-compatible 12 sort ; le mainteneur n'est pas suivi ici — à surveiller.
- Le timing exact de l'échelle prod (nombre de réplicas, présence Redis) n'est pas visible du dépôt : AUD-003 passe en P2 sans multiplication confirmée.

---

*Conformité au contrat de mode Plan : aucun fichier du projet n'a été créé ni modifié pendant l'audit ; toutes les vérifications exécutées ont été des lectures (code, `node_modules`, migrations, registres npm en ligne via fetch). Toute implémentation des phases ci-dessus requerra une validation explicite.*

---

## Journal d'implémentation

### Phase 1 — Sécurisation (implémentée le 20/10/2026)

**AUD-001 — Résolu.** Nouvelle variable `TRUST_PROXY_IPS` (adresses ou CIDR des reverse proxies, séparés par des virgules) :
- validée par le schéma d'environnement Zod (`src/config/configuration.ts`) : chaque entrée doit être une IPv4/IPv6 ou un CIDR — une coquille devient un échec de démarrage au lieu d'un avertissement silencieux à l'heure de la requête ;
- exposée dans `configuration().trustProxyIps` et plombée dans `AuthEnv` à travers les deux chemins de lecture (`readAuthEnv`, `readAuthEnvFromConfig`) ;
- branchée sur `advanced.ipAddress.trustedProxies` dans `createAuth` (`src/lib/auth/index.ts`), uniquement quand la liste est non vide — sinon le comportement défaut better-auth est préservé.

**AUD-003 — Résolu.** Nouveau `src/lib/auth/rate-limit-redis.ts` : implémentation du contrat officiel `rateLimit.customStorage` de better-auth 1.7 (pas de backend Redis natif en 1.7.3) — `consume` atomique (`INCR` + `EXPIRE NX` + `TTL` en un pipeline ordonné, la fenêtre ne peut pas être prolongée par un hit concurrent), clés préfixées `kineo:auth:rate-limit:`, fail-open sur panne Redis avec `logError`, `close()` exposé. Branché dans `createAuth` via `AuthEnv.redisUrl` (connexion paresseuse : un script ne se connecte jamais), sur le pattern exact du `ThrottlerStorageRedisService` du throttler.

**Documentation** : `.env.example` (TRUST_PROXY_IPS + REDIS_URL mis à jour), `README.md` §6.

**Validation** : typecheck ✔ · lint ✔ (156 fichiers) · 518 tests unitaires ✔ (dont 15 nouveaux : plombage des deux chemins d'env, branchement des options better-auth, sémantique du compte atomique — budget partagé entre deux clients sur le même serveur, fenêtre non prolongée, fail-open sur connexion refusée et sur tuple d'erreur ioredis, close) · gate de couverture ✔ (96,01 % lignes / 73,26 % fonctions, planchers 95/72 préservés) · **17/17 suites e2e ✔**, dont la nouvelle suite `proxy-ip` (4 cas : résolution sur chaîne à deux sauts, arrêt à un saut non approuvé, saut approuvé jamais enregistré comme IP, fallback sans en-tête) · ratchet `MIN_E2E_SUITES` relevé 16 → 17.

**Reste en déploiement** (non vérifiable depuis le dépôt) : renseigner `TRUST_PROXY_IPS` avec les adresses réelles des proxies de l'infrastructure (AUD-001 citation : une liste qu'on ne fournit pas est un déploiement qui rate la correction) et `REDIS_URL` en production pour que le budget better-auth soit partagé entre réplicas.

### Phase 2 — CAS sur les transitions d'application (implémentée le 20/10/2026)

**AUD-002 — Résolu.** `shortlist` et `update` (édition du message) n'écrivent plus via un `update` non préconditionné (`src/applications/applications.service.ts`) :
- l'écriture passe par `updateMany({ where: { id, status: "PENDING" }, … })` : la condition de statut est évaluée par le stockage à l'heure du commit, pas par la lecture qui a servi l'autorisation ;
- `count === 0` lève le refusal attendu (`applicationNotShortlistable` pour `shortlist`, `applicationNotPending` pour `update`) — c'est le cas d'une décision arrivée entre la lecture et l'écriture, exactement la course décrite ici (un shortlist committé après un accept reprenait une ligne ACCEPTED, `respondedAt` re-daté, `decisionSource` perdu, voisines REJECTED et listing FILLED laissés en place) ;
- réponse enrichie d'une relecture après écriture, forme plate inchangée ; `markAsViewed` reste comme prévu (idempotent par nature).

**Validation** : typecheck ✔ · lint ✔ (156 fichiers) · 524 tests unitaires ✔ (dont 6 nouveaux : la fake Prisma porte la précondition — vue « lecture » et vue « commit » séparées pour simuler la décision qui s'invite entre les deux — plus le pin de la `where` transmise au stockage et la course rejouée en unitaire pour les deux méthodes) · gate de couverture ✔ (96,01 % lignes / 73,26 % fonctions) · **17/17 suites e2e ✔**, dont le nouveau test de concurrence `applications-transitions` (shortlist et accept du même propriétaire tirés ensemble en HTTP, invariant vérifié quel que soit l'entrelacement : statut final ACCEPTED, `decisionSource` PRACTICE_ACCEPTED, listing FILLED — un shortlist qui arrive après le commit de l'accept est refusé plutôt que de reprendre la ligne).
