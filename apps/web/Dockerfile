FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --dir apps/web build \
    && mkdir -p apps/web/.next/standalone/apps/web \
    && for store in county-store forecast-store history-store population-store; do \
         if [ -d "apps/web/$store" ]; then cp -r "apps/web/$store" apps/web/.next/standalone/apps/web/; fi; \
       done

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN groupadd --gid 10002 app && useradd --uid 10002 --gid app --no-create-home app
COPY --from=builder --chown=app:app /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=app:app /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=app:app /workspace/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
