# Production Dockerfile for Frontend (Vite + React)
FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies using legacy-peer-deps to prevent React 19 peer resolution failure
RUN npm install --legacy-peer-deps

# Copy application source code
COPY . .

# Accept build arguments for environment variables needed during Vite build
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_BACKEND_URL

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

# Build the production bundle
RUN npm run build

# Expose Railway port
ENV PORT=8080
EXPOSE 8080

# Start Vite preview bound to 0.0.0.0 and dynamic Railway PORT
CMD ["sh", "-c", "npx vite preview --host 0.0.0.0 --port ${PORT:-8080}"]
