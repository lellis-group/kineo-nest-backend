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

# Only what a running server needs: no devDependencies, no source, no build
# toolchain. The process runs as `bun` rather than root, so a compromise of the
# application is not a compromise of the container.
FROM oven/bun:1.4.2-alpine
WORKDIR /usr/src/app

# Absent means production here, which is what closes Swagger, the Secure cookie
# and the raw error bodies; saying it out loud keeps that from depending on the
# orchestrator remembering.
ENV NODE_ENV=production

COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/prisma ./prisma
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json
COPY --from=build /usr/src/app/prisma.config.ts ./prisma.config.ts

USER bun
EXPOSE 3000

CMD ["sh", "-c", "bunx --bun prisma migrate deploy && bun dist/main.js"]
