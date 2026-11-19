# Q-Pulse: one container runs the indexer, delivery worker, Telegram bot, API and dashboard.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @qpulse/web build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/qpulse.db WEB_DIST=/app/apps/web/dist
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile --prod --filter @qpulse/server
COPY apps/server/src ./apps/server/src
COPY apps/server/bin ./apps/server/bin
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]
