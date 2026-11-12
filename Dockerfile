# Pinned rather than `oven/bun:1`: a moving tag makes the image unreproducible,
# and the CI already pins Postgres by digest for the same reason.
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /usr/src/app

# Manifests first, so the install layer survives a change to the source.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# A placeholder, not a credential: `prisma generate` reads the datasource URL out
# of prisma.config.ts, which refuses to load without one, and nothing it generates
# depends on the value. The real one is injected at run time, where the adapter is
# built — an ARG, so it stays out of the image.
ARG DATABASE_URL=postgresql://generate:generate@localhost:5432/generate
RUN bunx --bun prisma generate && bun run build

# Production dependencies only, installed apart from the build: the build stage
# needs the prisma CLI, typescript and the rest of the devDependencies, and
# copying its node_modules is what used to ship all of them in the server image.
FROM oven/bun:1.4.2-alpine AS prod-deps
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=peer

# The migration job: `docker build --target migrate`. Run once per release,
# before the new server starts — not by every replica at boot. Prisma's
# deployment guide puts `migrate deploy` in the CI/CD pipeline: at startup, N
# replicas queue on the migration lock, a long or failing migration holds every
# instance back (a plain restart included), and the server image has to carry
# the CLI. This stage is the one that carries it.
FROM oven/bun:1.4.2-alpine AS migrate
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json
COPY --from=build /usr/src/app/prisma ./prisma
COPY --from=build /usr/src/app/prisma.config.ts ./prisma.config.ts
USER bun
CMD ["bunx", "--bun", "prisma", "migrate", "deploy"]

# The server, and the default target. Only what a running server needs: no
# devDependencies, no source, no build toolchain, no migration CLI. The process
# runs as `bun` rather than root, so a compromise of the application is not a
# compromise of the container.
FROM oven/bun:1.4.2-alpine
WORKDIR /usr/src/app

# Absent means production here, which is what closes Swagger, the Secure cookie
# and the raw error bodies; saying it out loud keeps that from depending on the
# orchestrator remembering.
ENV NODE_ENV=production

COPY --from=build /usr/src/app/dist ./dist
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json

USER bun
EXPOSE 3000

CMD ["bun", "dist/main.js"]
