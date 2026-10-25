FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=512

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @knowledge-rag/api --include-workspace-root

COPY apps/api apps/api
RUN npm run build -w @knowledge-rag/api

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/apps/api/migrations

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @knowledge-rag/api --include-workspace-root \
    && npm cache clean --force

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations

RUN mkdir -p /data/uploads && chown -R node:node /data /app
WORKDIR /app/apps/api
USER node
EXPOSE 3300
CMD ["node", "dist/main.js"]
