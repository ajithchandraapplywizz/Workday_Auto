# Official Microsoft Playwright image matching installed playwright 1.64.1
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

# Install tini for proper PID 1 zombie process reaping and procps for process management
RUN apt-get update && apt-get install -y --no-install-recommends tini procps && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_CHROMIUM_CHANNEL=chromium

# Copy workspace package manifests first for optimal layer caching
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install dependencies cleanly without host node_modules collision
RUN npm install --legacy-peer-deps

# Copy application code (.dockerignore excludes host node_modules, logs, and screenshots)
COPY . .

# Compatibility symlinks/copies so both `node scripts/queue_daemon.mjs` and `node backend/scripts/queue_daemon.mjs` succeed
RUN cp -rf /app/backend/scripts/* /app/scripts/ && ln -sfn /app/backend/lib /app/lib

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512 --expose-gc"
ENV PORT=8080
EXPOSE 8080

# Use tini as PID 1 init process to reap zombie Chromium child processes
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start autonomous queue daemon
CMD ["node", "index.js"]
