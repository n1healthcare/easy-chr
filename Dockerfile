# N1 Interface - Job-Based Deployment (Ephemeral K8s Jobs)
#
# This Dockerfile builds N1-Interface for execution as Kubernetes Jobs
# spawned by forge-sentinel, matching the workflow-claude-code architecture.
#
# Build: docker build -t n1-interface:latest .
# Run:   docker run -e USER_ID=... -e REPORT_ID=... -e N1_API_KEY=... n1-interface

FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (tree-sitter-bash)
RUN apk add --no-cache python3 make g++

# Copy package files from server directory
COPY server/package*.json ./

# Install ALL dependencies (including tsx for runtime)
RUN npm ci

# Copy source code from server directory
COPY server/ .

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy dependencies, source, and vendor from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/vendor ./vendor
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Create storage directories for temporary file processing
RUN mkdir -p storage/input storage/realms

# Use existing node user (UID 1000 in node:20-alpine) and set ownership
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Expose port (not used in job mode, but kept for health checks if needed)
EXPOSE 3000

# Health check - verify node is working
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)"

# Environment variables expected from forge-sentinel:
# - USER_ID: User identifier for PDF fetching
# - REPORT_ID: Unique identifier for this report
# - PROMPT: Analysis prompt (optional)
# - N1_API_BASE_URL: N1 API backend URL
# - N1_API_KEY: N1 API authentication key
# - OPENAI_API_KEY: LiteLLM API key
# - OPENAI_BASE_URL: LiteLLM proxy URL
# - BUCKET_NAME: GCS bucket name
# - PROJECT_ID: GCP project ID
# - GCS_SERVICE_ACCOUNT_JSON: GCS credentials (JSON string)
# - MODEL: Gemini model to use
# Progress updates are sent via N1 API (POST /reports/status)

# Run in job mode using tsx (TypeScript runtime, no build needed)
CMD ["npx", "tsx", "src/job-runner.ts"]
