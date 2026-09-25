# Backend API image for Railway (or any container host).
# Node 24 for the built-in node:sqlite module; Chromium + git for reviews.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci --no-audit --no-fund -w @qa-agent/shared -w @qa-agent/backend --include-workspace-root \
  && npx playwright install --with-deps chromium

COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN npm run build -w @qa-agent/shared && npm run build -w @qa-agent/backend

ENV NODE_ENV=production
CMD ["node", "packages/backend/dist/index.js"]
