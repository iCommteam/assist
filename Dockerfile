# iCommAssist on Railway: one container runs `next start` and the eve server
# that Next spawns beside it. README.md, "Deployment on Railway", lists the
# service settings this image expects.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    EVE_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable \
 && corepack prepare pnpm@11.24.0 --activate \
 && chown -R node:node "$COREPACK_HOME" \
 && mkdir /app \
 && chown node:node /app

WORKDIR /app
USER node

# The manifests alone, so a source-only change reuses the installed layer. The
# store is removed in the same layer; node_modules keeps its own copy. Every
# dependency stays: the pre-deploy migration runs drizzle-kit, and eve runs
# from .output together with the source and node_modules.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node patches ./patches
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store \
 && rm -rf /tmp/pnpm-store

COPY --chown=node:node . .

# Public, not a secret: app/layout.tsx reads it at build time. Railway passes
# the service variable of the same name. Secrets are never build arguments.
ARG BETTER_AUTH_URL=https://assist.icommteam.com
ENV NODE_ENV=production
# DATABASE_URL and KERNEL_API_KEY are format-checked placeholders for the
# build only; the service provides the real values at runtime.
RUN export DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
      KERNEL_API_KEY=build-placeholder \
 && pnpm exec eve build \
 && pnpm exec next build

# The container starts as root only to hand the volume, which Railway mounts
# owned by root, to the unprivileged node user. Everything else, including
# scripts/start.ts and both servers, runs as node. Each session's sandbox
# files (uploads, screenshots) live on the volume too: the just-bash sessions
# directory becomes a link into it, while the templates the build prepared stay
# in the image. The service sets PORT=8080, the port of Teemiq's private
# address; EXPOSE only documents it.
USER root
EXPOSE 8080
CMD ["sh", "-c", "mkdir -p .eve/.workflow-data/sandbox-sessions .eve/sandbox-cache/just-bash && find .eve/.workflow-data ! -user node -exec chown node:node {} + && rm -rf .eve/sandbox-cache/just-bash/sessions && ln -sfn ../../.workflow-data/sandbox-sessions .eve/sandbox-cache/just-bash/sessions && exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node node --experimental-strip-types scripts/start.ts"]
