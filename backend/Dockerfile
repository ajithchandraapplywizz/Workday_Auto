# Official Microsoft Playwright image with all Linux system dependencies (libglib-2.0, libnss3, etc.) pre-installed
FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY . .

RUN npm install

ENV PORT=8080
EXPOSE 8080

CMD ["node", "scripts/queue_daemon.mjs"]
