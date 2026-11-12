# Audit Prisma — kineo-nest-backend

_Date : 2026-11-12 · Prisma ORM 7.9 (`prisma-client` generator, `@prisma/adapter-pg`) · PostgreSQL_

Périmètre : `prisma/schema.prisma`, `prisma.config.ts`, `prisma/migrations`, `prisma/seed.ts`,
`src/lib/prisma.ts`, `src/prisma.service.ts`, les services qui interrogent la base, le `Dockerfile`.

Références (doc officielle v7) :

- Prisma Client API reference — https://www.prisma.io/docs/orm/reference/prisma-client-reference
- Transactions (v7) — https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions
- CRUD (v7) — https://www.prisma.io/docs/orm/v7/prisma-client/queries/crud
- Pagination — https://www.prisma.io/docs/orm/prisma-client/queries/pagination
- TypedSQL — https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql
- Déploiement des migrations — https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate
- Extensions PostgreSQL — https://www.prisma.io/docs/orm/prisma-schema/postgresql-extensions

> Les URL sans version de la doc servent désormais le contenu de Prisma ORM 8 (`db.orm`,
> `db.transaction` sans `timeout`/`isolationLevel`). Pour ce projet, il faut lire les pages `/orm/v7/`.

## Synthèse

La couche Prisma est déjà de bonne qualité : un seul client partagé (Nest + better-auth),
un pool dimensionné explicitement, des transactions `Serializable` avec reprise sur `P2034`
(le motif que recommande la doc), des écritures conditionnelles contre les courses, des
`select` ciblés sur les lectures chaudes, des index composites alignés sur les `orderBy`,
un `db:check` qui détecte l'écart entre le schéma et les migrations, et du SQL brut toujours
paramétré via `Prisma.sql`.

Les axes d'amélioration, du plus urgent au moins urgent :

| # | Priorité | Sujet | Fichier |
|---|----------|-------|---------|
| 1 | **Haute** (bug) | Les étapes du sweep « isolées » partagent une transaction : la première erreur fait échouer toutes les suivantes | `src/data-lifecycle/data-lifecycle.service.ts` |
| 2 | **Haute** (bug) | `purged.deletionRequests` n'est jamais initialisé : le total vaut `NaN` et le log du sweep ne part plus | `src/data-lifecycle/data-lifecycle.service.ts:176` |
| 3 | Moyenne | Le sweep tient une transaction jusqu'à 10 min, contre la consigne de la doc | `src/data-lifecycle/data-lifecycle.service.ts:297` |
| 4 | Moyenne | `updateMany` + `findUnique` au lieu d'un `update` avec un `where` non unique | `src/applications/applications.service.ts`, `practices`, `profile` |
| 5 | Moyenne | Les jokers `%`/`_` ne sont pas échappés dans les recherches des annonces | `src/replacementlistings/replacementlistings.service.ts:497` |
| 6 | Moyenne | Pagination par offset sur les flux publics | services `findAll` / `findMine` |
| 7 | Moyenne | `migrate deploy` lancé au démarrage du conteneur | `Dockerfile:38` |
| 8 | Basse | Image runtime : elle embarque toutes les devDependencies, contrairement à ce que dit son commentaire | `Dockerfile:18-31` |
| 9 | Basse | SQL géographique écrit à la main : TypedSQL ou PostGIS à envisager | `src/practices/geo-query.ts` |
| 10 | Basse | Index manquants pour la branche non géographique des cabinets | `prisma/schema.prisma` (Practice) |
| 11 | Basse | Agrégation des facettes par semaine faite en JS | `replacementlistings.service.ts:635` |
| 12 | Basse | Seed : des `create` séquentiels là où `createManyAndReturn` suffirait | `prisma/seed.ts` |
| 13 | Basse | `getOwnedProfile` lit la ligne entière alors que la plupart des appels n'utilisent que l'`id` | `src/common/profile-lookup.ts` |
| 14 | Info | Adaptateur créé dès l'import de `lib/prisma` même quand `PrismaService` le remplace | `src/lib/prisma.ts:80` |

### Suivi

| # | Statut | Commit |
|---|--------|--------|
| 1, 3 | ✅ Corrigé : une transaction courte par lot, chacune prend le verrou consultatif ; test e2e avec un trigger qui fait échouer `session` | `7c6f403` |
| 2 | ✅ Corrigé : compteurs initialisés à 0 ; test unitaire sur le log | `3c60928` |
| 4 | ✅ Fait : `update` + P2025 (`src/common/prisma-errors.ts`) | `6a52699` |
| 5 | ✅ Corrigé : `escapeLike` sur `q` et `city` ; test e2e | `2b7292b` |
| 6 | ✅ Fait, sans casser l'API : `cursor` optionnel et `meta.nextCursor` sur `/replacement-listings` et `/mine` ; `page` fonctionne toujours | `13df6ff` |
| 7, 8 | ✅ Fait : cible Docker `migrate` séparée, image serveur limitée aux dépendances de production (719 Mo → 352 Mo) | `bf60bf2` |
| 9 → 14 | À faire | — |

---

## 1. Le sweep de rétention : des étapes pas vraiment isolées (bug)

`purgeExpired` exécute `runSweep(tx)` **dans une seule transaction interactive**
(`withAdvisoryLock`). Chaque étape est enveloppée dans `step()`, qui attrape l'erreur pour que
les suivantes s'exécutent malgré tout, comme l'explique le commentaire.

Sous PostgreSQL, ça ne marche pas : la première requête qui échoue fait passer la transaction à
l'état *aborted*. Toutes les requêtes suivantes reçoivent alors
`25P02 current transaction is aborted, commands ignored until end of transaction block`.
Par exemple, une erreur transitoire sur `session` fait échouer `verification`, la purge des
comptes, les deux purges du registre RGPD et la collecte des annonces fantômes, puis le commit
devient un rollback. On retombe exactement dans le cas que le commentaire de `sweepRetention`
dit avoir corrigé. Et comme `step()` avale chaque erreur, le cron a l'air de réussir.

**Recommandation** : donner **une transaction courte à chaque étape** (ou même à chaque lot),
qui prend le verrou consultatif au début :

```ts
private async lockedStep(label: string, work: (tx: Prisma.TransactionClient) => Promise<void>) {
  await this.step(label, () =>
    this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ACCOUNT_SWEEP_LOCK}) AS locked`;
      if (locked) await work(tx);
    }, { timeout: 30_000 }),
  );
}
```

Sinon, sortir le sweep de la transaction et garder un verrou de session sur une connexion
dédiée (un `pg.Client` à part). On ne peut pas le faire à travers le pool de Prisma, pour la
raison que le commentaire décrit déjà.

Un test d'intégration qui fait échouer la première étape (par exemple avec un trigger) et
vérifie que les suivantes passent quand même évitera la régression.

## 2. `purged.deletionRequests` vaut `NaN` (bug)

```ts
const purged: Record<string, number> = {};
// ...
purged.deletionRequests += await this.deleteInBatches(...); // undefined + n → NaN
```

Résultat : `total` vaut `NaN`, la condition `total > 0` est fausse, et l'événement
`data_lifecycle.sweep` n'est **jamais** journalisé, même quand des sessions ont été purgées.
C'est pourtant la trace qui sert à prouver la minimisation des données (RGPD, art. 5(1)(e)).

**Correction** : `const purged = { sessions: 0, verifications: 0, anonymizedAccounts: 0, deletionRequests: 0 };`

## 3. Une transaction de 10 minutes

`withAdvisoryLock` passe `timeout: 600_000`. La doc (Transactions, v7) dit :
« *Keep transactions short. Long-running transactions hurt performance and can cause deadlocks.* »

Les lots de 500 (`PURGE_BATCH_SIZE`) devaient « borner la fenêtre de verrouillage ». Mais ils
s'exécutent tous dans la même transaction, donc les verrous de ligne restent posés **jusqu'au
commit final** : le découpage borne la taille de chaque requête, pas la durée des verrous. En
plus, la transaction garde une connexion du pool partagé pendant tout ce temps. Le point 1
(une transaction par étape ou par lot) règle aussi ce problème.

## 4. `update` avec un `where` non unique au lieu de `updateMany` + `findUnique`

Le motif est répété plusieurs fois (`applications.update`, `shortlist`, `practices.update`,
`profile.update`) :

```ts
const edited = await this.prisma.application.updateMany({ where: { id, status: "PENDING" }, data });
if (edited.count === 0) throw refusal(...);
const updated = await this.prisma.application.findUnique({ where: { id } }); // 2e requête
```

Depuis Prisma 5, `WhereUniqueInput` accepte des champs non uniques en plus du champ unique
(référence de l'API : *Filter on non-unique fields with UserWhereUniqueInput*). La condition
reste évaluée au moment de l'écriture, et une absence de correspondance lève **P2025** :

```ts
try {
  const updated = await this.prisma.application.update({
    where: { id, status: "PENDING" },
    data: { message: dto.message },
  });
  return toApplicationDto(updated);
} catch (e) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw refusal(...);
  throw e;
}
```

On fait un aller-retour de moins et on ne garde plus la garde « impossible » `if (!updated)`.
On garde la même protection contre la course, puisque la condition fait partie de l'`UPDATE`.

## 5. Jokers LIKE non échappés dans les annonces

`practices.service.ts` échappe `%` et `_` (`escapeLike`) sur ses deux branches, et documente
pourquoi. `buildListingsWhere` ne le fait pas :

```ts
city: { contains: filters.city, mode: "insensitive" }          // l. ~497
title: { contains: filters.q, mode: "insensitive" }             // l. ~515
description: { contains: filters.q, mode: "insensitive" }
```

`?q=%` ou `?city=_` renvoient donc tout, de façon incohérente avec `/practices`. La doc précise
que `contains` produit un `LIKE '%…%'` sans échapper le terme. **Correction** : passer par
`escapeLike(...)`, que `geo-query.ts` exporte déjà.

## 6. Pagination par offset

Tous les flux paginent avec `skip`/`take`. La doc (*Reading data / pagination*) dit :
« *Offset gets slower on deep pages, so for stable pagination over a large table, follow
orderBy(...) with cursor(...)* ». Les index `rl_*_id_desc_idx` sont déjà construits pour un
parcours par curseur (clé de tri + `id` comme départage). Le passage au curseur ne demande donc
aucune migration, seulement une évolution du contrat de l'API (`cursor` / `nextCursor`).

À réserver au flux public (`findAll`), le seul où un lecteur peut aller loin dans les pages.
`findPageOf` (qui calcule un numéro de page) dépend de l'offset : il faudra le remplacer par un
curseur qui pointe sur l'annonce visée.

## 7. `prisma migrate deploy` au démarrage du conteneur

`CMD ["sh", "-c", "bunx --bun prisma migrate deploy && bun dist/main.js"]`

La doc recommande de lancer `migrate deploy` « *as part of your CI/CD pipeline* ».
Le faire au démarrage pose trois problèmes :

- avec N réplicas, N processus lancent la commande en même temps. Prisma pose bien un verrou
  consultatif, mais chaque démarrage attend sur le précédent ;
- une migration longue ou qui échoue retarde ou bloque **toutes** les instances, y compris un
  simple redémarrage ;
- il faut garder la CLI `prisma` et ses moteurs dans l'image de production (voir le point 8).

**Recommandation** : une étape dédiée (job de release, init-container Kubernetes, ou étape CI
avant le déploiement) qui lance `prisma migrate deploy` une seule fois. Le serveur ne fait plus
que `bun dist/main.js`.

## 8. Image runtime : les devDependencies sont incluses

Le commentaire de l'étape finale dit « *no devDependencies* », mais
`COPY --from=build /usr/src/app/node_modules ./node_modules` copie le `node_modules` complet
de l'étape de build (typescript, biome, prisma CLI, @types…). Une fois le point 7 fait, on peut
ajouter une étape `bun install --production --frozen-lockfile` et copier `src/generated` (le
client généré se trouve dans le code compilé `dist`, à vérifier selon `tsconfig.build`). Sinon,
au minimum, corriger le commentaire.

## 9. SQL géographique écrit à la main

`geo-query.ts` est soigné (paramétré, gère l'antiméridien, bounding box puis haversine), mais :

- **les lignes ne sont pas typées** : `$queryRaw<PracticeGeoRow[]>` est une affirmation de
  type, pas une vérification, et `PRACTICE_GEO_COLUMNS` doit suivre le schéma à la main ;
- **TypedSQL** (`previewFeatures = ["typedSql"]`, fichiers `prisma/sql/*.sql`,
  `$queryRawTyped`) génère les types d'entrée et de sortie à partir de la base. La doc confirme
  qu'il fonctionne avec `@prisma/adapter-pg`. Il demande en revanche une connexion à la base au
  moment de `prisma generate --sql`, donc le placeholder du `Dockerfile` ne suffira plus : il
  faudra générer en CI contre une base migrée. Le gain est réel mais la fonctionnalité est encore
  en preview, donc c'est optionnel ;
- à plus long terme, **PostGIS** (`geography(Point)`, `ST_DWithin`, index GiST) remplacerait la
  bounding box et le haversine par un prédicat indexé. La doc recommande d'installer l'extension
  par une migration écrite à la main et de déclarer la colonne en `Unsupported("geography")`.
  C'est déjà ainsi que `pg_trgm` est installé. À envisager seulement si le volume de cabinets
  augmente nettement.

## 10. Index des cabinets

- La branche non géographique de `practices.findAll` filtre `isPublic = true` et trie par
  `createdAt DESC, id DESC`, sans index adapté. Proposition :
  `@@index([isPublic, createdAt(sort: Desc), id(sort: Desc)])`.
- `practice.name` est cherché en `ILIKE '%…%'` mais n'a pas d'index trigramme (seul `city` en
  a un, `practice_city_trgm_idx`). À ajouter avec le même motif si la recherche par nom est
  fréquente.
- `@@index([latitude, longitude])` ne sert qu'au filtre sur la latitude (première colonne) : le
  filtre sur la longitude est une seconde plage, que le B-tree ne peut pas exploiter. C'est
  acceptable, mais c'est un argument de plus pour PostGIS/GiST (point 9).

Comme pour les annonces, il faut mesurer avec `bun run profile` / `EXPLAIN ANALYZE` avant
d'ajouter un index.

## 11. Facettes par semaine

`findFacets` charge **toutes** les `startDate` de la fenêtre (`findMany({ select: { startDate } })`)
puis les répartit par semaine en JavaScript. Le volume transféré croît avec le corpus. Un
`GROUP BY date_bin('7 days', "startDate", $windowStart)` en SQL (TypedSQL ou `$queryRaw`)
renverrait au plus `FACET_WEEKS` lignes. Le compromis est le même que celui décrit dans
`findPlaces` : il faut réécrire les filtres en SQL. C'est à faire seulement si le profilage
montre un coût.

## 12. Seed

`prisma/seed.ts` crée utilisateurs, cabinets et annonces un par un dans des boucles
(`await prisma.x.create(...)`). `createManyAndReturn` (pris en charge par PostgreSQL d'après la
doc CRUD v7) insère un lot et renvoie les lignes avec leurs `id`, ce qui réduit fortement le
temps de seed. Les candidatures utilisent déjà `createMany` par lots.

## 13. Lectures plus étroites

- `getOwnedProfile` / `getOwnedProfileIdSafe` font un `findUnique` sans `select`, alors que
  `getOwnedProfileId` et `getOwnedProfileIdSafe` n'utilisent que l'`id`. Ajouter
  `select: { id: true }` à ces deux chemins (ou `profileType` quand il le faut).
- `applications.create` / `findForListing` lisent l'annonce entière (y compris `description`)
  alors qu'ils n'utilisent que `id`, `status`, `createdById`, `maxApplications`.
- Pour les modèles d'authentification, l'option `omit` (par requête, documentée dans la
  référence de l'API) permet de ne jamais renvoyer `Account.password` / les jetons
  par accident si un `findMany` sans `select` apparaît un jour.

## 14. Détails de configuration

- `src/lib/prisma.ts:80` crée `adapter` à l'import, même quand `PrismaService` le remplace par
  celui qu'il construit depuis `ConfigService`. `PrismaPg` est une fabrique (le `pg.Pool` n'est
  créé qu'à la connexion), donc l'effet est négligeable. Rendre `prismaClientOptions` paresseux
  (une fonction) supprimerait quand même l'ambiguïté sur « quel pool sert vraiment ».
- `previewFeatures = ["partialIndexes"]` est utilisé pour un **invariant métier**
  (`data_deletion_request_userIdHash_pending_key`). Pensez à relire les notes de version à chaque
  montée de Prisma : une preview peut changer de syntaxe. `bun run db:check` en CI détectera
  toute divergence.
- `db:push` est exposé dans `package.json` alors que le projet est piloté par les migrations :
  un `db push` sur une base partagée la fait diverger de l'historique. À renommer
  (`db:push:prototype`) ou à retirer.
- `onModuleInit → $connect()` : avec un adaptateur, la connexion est de toute façon paresseuse.
  Le garder a l'avantage de faire échouer le démarrage tout de suite si la base est injoignable,
  ce qui est un choix défendable. C'est à garder, mais en connaissance de cause.

## Ce qui est déjà conforme à la doc (à conserver)

- Un seul `PrismaClient` par processus, partagé avec better-auth : la doc met en garde contre
  la multiplication des instances.
- `runSerializableTransaction` : isolation `Serializable` et reprise bornée sur `P2034`,
  comme dans l'exemple de la doc Transactions v7.
- `maxWait` / `timeout` explicites sur les transactions métier (5 s / 10 s), au-dessus des
  valeurs par défaut (2 s / 5 s).
- Erreurs `P2002` / `P2025` traduites en 409 / 404 au lieu de remonter en 500.
- `log` qui garde toujours `warn` et `error`.
- `countApplicationsPerListing` à la place de `_count` sur les pages : bonne lecture du SQL généré.
- `@@index` avec `sort` et `id` en départage, cohérents avec les `orderBy`.
- Extension `pg_trgm` installée par une migration écrite à la main (méthode documentée), et
  `CHECK` constraints posées en SQL de migration.
- Client généré hors du dépôt (`src/generated` ignoré) et régénéré au build.
