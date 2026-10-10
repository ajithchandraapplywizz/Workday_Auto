# Official Microsoft Playwright image with all Linux system dependencies (libglib-2.0, libnss3, etc.) pre-installed
FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy project files
COPY . .

# Install dependencies
RUN npm install

# Expose default port
ENV PORT=8080
EXPOSE 8080

# Start autonomous queue daemon
CMD ["node", "index.js"]
