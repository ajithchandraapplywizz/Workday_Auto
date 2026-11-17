# Official Microsoft Playwright image with all Linux system dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

# Install tini for proper PID 1 zombie process reaping and procps for process management
RUN apt-get update && apt-get install -y --no-install-recommends tini procps && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_CHROMIUM_CHANNEL=chromium

# 1. Copy dependency manifests first for layer caching
COPY package*.json ./

# 2. Clean production dependency installation (omits devDependencies like vitest to save memory)
RUN npm install --omit=dev --legacy-peer-deps

# 3. Copy application source (.dockerignore excludes host node_modules, runs, screenshots, and logs)
COPY . .

# 4. Compatibility symlinks so both `node scripts/queue_daemon.mjs` and `node backend/scripts/queue_daemon.mjs` succeed
RUN mkdir -p /app/backend && ln -sf /app/scripts /app/backend/scripts && ln -sf /app/lib /app/backend/lib

ENV PORT=8080
EXPOSE 8080

# Use tini as PID 1 init process to reap zombie Chromium child processes
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "scripts/queue_daemon.mjs"]

