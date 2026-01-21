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
COPY --from=builder /app/.gemini ./.gemini

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
#
# REQUIRED:
# - USER_ID: User identifier for PDF fetching
# - REPORT_ID: Unique identifier for this report
# - N1_API_BASE_URL: N1 API backend URL
# - N1_API_KEY: N1 API authentication key
# - BUCKET_NAME: GCS bucket name
# - PROJECT_ID: GCP project ID
# - GCS_SERVICE_ACCOUNT_JSON: GCS credentials (JSON string)
# - GEMINI_API_KEY: Google Gemini API key (required for LLM operations)
#
# OPTIONAL:
# - PROMPT: Analysis prompt (defaults to generic health analysis)
# - MARKDOWN_MODEL: Model for PDF extraction (default: gemini-2.0-flash-exp)
# - INTERMEDIATE_MODEL: Model for analysis phases (default: gemini-2.0-pro-exp)
# - HTML_MODEL: Model for HTML generation (default: gemini-2.0-pro-exp)
# - DOCTOR_MODEL: Model for medical analysis (default: gemini-2.5-pro)
# - MAX_AGENTIC_ITERATIONS: Max iterations for agentic loop (default: 10)
# - ENABLE_WEB_SEARCH: Enable web search for research (default: true)
#
# Progress updates are sent via N1 API (POST /reports/status)

# Run in job mode using tsx (TypeScript runtime, no build needed)
CMD ["npx", "tsx", "src/job-runner.ts"]
