# Official Microsoft Playwright image matching installed playwright 1.64.1
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy workspace package manifests first for optimal layer caching
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install dependencies cleanly without host node_modules collision
RUN npm install --legacy-peer-deps

# Copy application code (.dockerignore excludes host node_modules, logs, and screenshots)
COPY . .

# Compatibility symlinks so both `node scripts/queue_daemon.mjs` and `node backend/scripts/queue_daemon.mjs` succeed
RUN ln -sf /app/backend/scripts /app/scripts && ln -sf /app/backend/lib /app/lib

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Start autonomous queue daemon
CMD ["node", "index.js"]
