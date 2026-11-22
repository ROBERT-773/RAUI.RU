FROM scratch AS context-proof
COPY . /context

# Node 24.19.0 / Debian trixie: Python >=3.12 is required by the trust scorer.
FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm install --global pnpm@10.0.0 ${HTTPS_PROXY:+--proxy="$HTTPS_PROXY"}
COPY . .
ARG SITE_URL
ARG DEPLOYMENT_ENV=staging
ARG SOURCE_REVISION
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    node -e 'if (!/^[a-f0-9]{40}$/.test(process.env.SOURCE_REVISION || "")) throw Error("Full source revision required"); const u = new URL(process.env.SITE_URL); if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw Error("Clean SITE_URL origin required"); if (!["staging", "production"].includes(process.env.DEPLOYMENT_ENV)) throw Error("Deployment environment required")' && \
    pnpm install --frozen-lockfile && \
    NEXT_TELEMETRY_DISABLED=1 pnpm --filter @raui/api build && \
    NEXT_TELEMETRY_DISABLED=1 pnpm --filter @raui/web build && \
    find apps/api/migrations -type f -name '*.sql' -exec sha256sum {} + > /app/migration-sha256.txt
# Reinstall only production dependencies, retaining workspace symlinks and natives.
FROM base AS dependencies
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm install --global pnpm@10.0.0 ${HTTPS_PROXY:+--proxy="$HTTPS_PROXY"}
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/packages ./packages
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --prod --frozen-lockfile

# Bind mounts do not add the development closure to runtime image layers.
FROM dependencies AS assembled
ARG SITE_URL
ARG DEPLOYMENT_ENV=staging
RUN --mount=type=bind,from=build,source=/app,target=/build \
    cp -a /build/apps/api/dist /build/apps/api/migrations apps/api/ && \
    cp -a /build/apps/web/.next /build/apps/web/next.config.ts apps/web/ && \
    if [ -d /build/apps/web/public ]; then cp -a /build/apps/web/public apps/web/; fi && \
    mkdir -p apps/ai scripts infra/runtime && \
    cp -a /build/apps/ai/raui_ai apps/ai/ && \
    cp /build/migration-sha256.txt . && \
    cp /build/scripts/runtime-image-check.mjs /build/scripts/runtime-image-verification.mjs scripts/ && \
    cp /build/infra/runtime/entrypoint.sh infra/runtime/ && \
    printf '%s\n' "$SITE_URL" > /app/site-origin && \
    printf '%s\n' "$DEPLOYMENT_ENV" > /app/deployment-env && \
    chown -R node:node /app

FROM base AS runtime
ARG SOURCE_REVISION
ARG SOURCE_STATE=candidate
ARG SITE_URL
ARG DEPLOYMENT_ENV=staging
LABEL org.opencontainers.image.source="https://github.com/ROBERT-773/RAUI.RU" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      raui.source-state=$SOURCE_STATE \
      raui.site-url=$SITE_URL \
      raui.deployment-env=$DEPLOYMENT_ENV
ENV NODE_ENV=production SITE_URL=$SITE_URL DEPLOYMENT_ENV=$DEPLOYMENT_ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=assembled /app /app
USER node
ENTRYPOINT ["sh", "/app/infra/runtime/entrypoint.sh"]
CMD ["api"]
