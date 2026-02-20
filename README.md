# N1 Personal Realm Generator

A web application that transforms uploaded documents into interactive, self-contained HTML websites ("Realms") using an AI-powered multi-agent medical analysis pipeline.

> **Quick Start**: See [QUICKSTART.md](QUICKSTART.md) for a 5-minute setup guide.

## Overview

Users upload documents (medical records, lab reports, etc.) and provide a prompt. The system runs an 8-phase agentic pipeline powered by Google Gemini to extract, analyze, validate, and visualize the data as a fully interactive HTML website. Each generated "Realm" is saved permanently and accessible via a unique URL.

**This is not a chat app** -- it is a document-to-website generator.

## Processing Pipeline

The core workflow is an **8-phase medical analysis pipeline** orchestrated by `AgenticDoctorUseCase`:

```
Uploaded Files
     │
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 1: Document Extraction                                        │
│ Per-record: try pre-extracted markdown from N1 API first            │
│ Fallback: PDF → Gemini Vision OCR → Markdown (old records)          │
│ Other files → direct text extraction                                │
│ All sources combined into one file                                  │
│ Output: extracted.md                                                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 2: Agentic Medical Analysis                                   │
│ Iterative tool-based exploration (up to 35 cycles)                  │
│ Tools: list_documents, read_document, search_data, get_date_range,  │
│        extract_timeline_events, get_value_history, update_analysis  │
│ Agent forms hypotheses, seeks evidence, builds comprehensive report │
│ Includes cross-system relationship analysis                         │
│ Output: analysis.md                                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 3: Research                                                   │
│ Extracts medical claims from analysis                               │
│ Validates each claim via web search against external sources        │
│ Output: research.json                                               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 4: Agentic Data Structuring (SOURCE OF TRUTH)                 │
│ Builds chart-ready JSON with 25+ semantic fields section-by-section │
│ Primary inputs: analysis.md + research.json (in context)            │
│ Tool access to full extracted.md for cross-checking values          │
│ Tools: search_source, get_value_history, get_date_range,            │
│        update_json_section, complete_structuring                    │
│ Output: structured_data.json                                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 5: Agentic Validation (up to 3 correction cycles)             │
│ Tool-based validator compares source data against structured JSON    │
│ Tools: list_documents, search_data, get_date_range,                 │
│        compare_date_ranges, check_value_in_json                     │
│ Issues → JSON patch sent to data structurer for surgical correction  │
│ Output: validation.md + corrected structured_data.json              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 6: HTML Generation                                            │
│ Renders structured_data.json into interactive HTML                   │
│ Plotly.js visualizations (gauges, trends, radar charts)             │
│ Claymorphism design, responsive layout                              │
│ Output: index.html                                                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 7: Content Review                                             │
│ 4-dimensional QA comparing structured_data.json vs index.html       │
│ Checks: user question addressed, detail fidelity,                   │
│         content completeness, visual design                         │
│ Output: content_review.json                                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼ (only if Phase 7 fails)
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 8: HTML Regeneration                                          │
│ Regenerates HTML incorporating all reviewer feedback                │
│ Output: index.html (overwritten)                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Data flow summary**:
```
Files → extracted.md → analysis.md → research.json
                                         ↓
                              structured_data.json ←→ validation loop
                                         ↓
                                    index.html ←→ content review loop
```

## Architecture

Monorepo with hexagonal (ports & adapters) architecture:

```
client/                        React + Vite (Upload UI, SSE Stream Viewer)
server/
  ├── src/
  │   ├── adapters/
  │   │   ├── gemini/          Gemini AI adapter (@google/genai SDK)
  │   │   ├── http/            Fastify server + SSE streaming
  │   │   ├── n1-api/          N1 platform API integration
  │   │   └── storage/         Local filesystem & S3 adapters
  │   ├── application/
  │   │   ├── ports/           Port interfaces (LLMClient, Storage, PDFFetcher)
  │   │   └── use-cases/       Business logic (AgenticDoctor, SendChat, Research)
  │   ├── common/              Shared utilities (storage paths, retry logic)
  │   ├── domain/              Core types and entities
  │   ├── services/            Pipeline services:
  │   │   ├── agentic-medical-analyst    Phase 2 agent with tool executor
  │   │   ├── agentic-data-structurer    Phase 4 agent with tool executor (NEW)
  │   │   ├── agentic-validator          Phase 5 agent with tool executor
  │   │   ├── research-agent             Phase 3 claim extraction + web search
  │   │   ├── pdf-extraction             Phase 1 Vision OCR
  │   │   ├── chat-compression           History compression for all agentic loops
  │   │   └── web-search                 Search API integration
  │   ├── utils/               Billing, JSON patch merge, source excerpts
  │   └── config.ts            REALM_CONFIG (models, retry, throttle, compression)
  ├── storage/                 Local uploads & generated realms (gitignored)
  └── vendor/                  Embedded gemini-cli source code
```

## Prerequisites

- Node.js v18+
- A Gemini API key ([get one here](https://makersuite.google.com/app/apikey)) or a LiteLLM proxy endpoint

## Installation

```bash
# Clone and install
git clone <repository-url>
cd easy-chr

# Server
cd server && npm install

# Client
cd ../client && npm install

# Configure environment
cd ../server
cp .env.example .env
# Edit .env — at minimum set GEMINI_API_KEY
```

## Running

Two terminals:

```bash
# Terminal 1: Backend (http://localhost:3000)
cd server && npm run dev

# Terminal 2: Frontend (http://localhost:5173)
cd client && npm run dev
```

Open http://localhost:5173 in your browser.

## Environment Variables

Key variables in `server/.env` (see `.env.example` for the full list):

| Variable | Purpose | Default |
|----------|---------|---------|
| `GEMINI_API_KEY` | Google Gemini API key (required) | — |
| `GOOGLE_GEMINI_BASE_URL` | API endpoint (Google direct or LiteLLM proxy) | `https://generativelanguage.googleapis.com` |
| `MARKDOWN_MODEL` | Deprecated override (ignored; defaults-only policy) | `gemini-2.5-flash` |
| `INTERMEDIATE_MODEL` | Deprecated override (ignored; defaults-only policy) | `gemini-3-pro-preview` |
| `HTML_MODEL` | Deprecated override (ignored; defaults-only policy) | `gemini-3-flash-preview` |
| `DOCTOR_MODEL` | Deprecated override (ignored; defaults-only policy) | `gemini-3-pro-preview` |
| `STORAGE_PROVIDER` | `local`, `s3`, or `gcs` | `local` |

## API

### `POST /api/realm`

Generate a new Realm from uploaded documents.

**Request**: `multipart/form-data`
- `files` — one or more document files (PDF, TXT, CSV, JSON, XML, HTML, MD)
- `prompt` — text describing what to analyze (e.g., "What does my bloodwork mean?")

**Response**: Server-Sent Events stream with typed events:
- `step` — pipeline phase status (`running`, `completed`, `failed`)
- `log` — processing details and tool calls
- `result` — final realm URL (`{ url: '/realms/<id>/index.html' }`)
- `error` — pipeline failure

```bash
curl -X POST http://localhost:3000/api/realm \
  -F "files=@/path/to/labs.pdf" \
  -F "prompt=Analyze my lab results and create a health dashboard"
```

### `GET /realms/:id/index.html`

Serve a generated Realm by its unique ID.

## Key Technologies

- **Frontend**: React 19, Vite, TypeScript
- **Backend**: Node.js, Fastify, TypeScript (ESM modules)
- **AI**: Google Gemini API (@google/genai SDK)
- **Visualizations**: Plotly.js (gauges, trends, radar charts in generated HTML)
- **Storage**: Local filesystem (dev), S3 (prod), GCS (legacy)
- **Streaming**: Server-Sent Events (SSE)

## Running the Job Runner Locally

The job runner is the production entry point (ephemeral K8s job mode). To test the full pipeline locally without S3:

```bash
cd server
USER_ID=ad405f4e-8089-4e23-8b9c-03c8f2648d16 CHR_ID=test ENVIRONMENT=development npx tsx src/job-runner.ts
```

- `ENVIRONMENT=development` — skips S3 uploads and progress API calls
- `CHR_ID` — any string (report label for logs, not a record ID)
- `USER_ID` — a real user ID with records in the N1 API
- Requires `N1_API_BASE_URL` and `N1_API_KEY` in `server/.env`

The pipeline will fetch markdown for each record, fall back to PDF + Vision OCR for records without markdown, and output the generated realm to local `storage/`.

## Development Notes

- ESM modules throughout — use `.js` extensions in imports, not `.ts`
- `vendor/` must stay inside `server/` to resolve `server/node_modules`
- File uploads limited to 300MB (configurable in `server/src/adapters/http/server.ts`)
- Agent skill prompts live in `.gemini/skills/*/SKILL.md` and are loaded dynamically
- Config is centralized in `server/src/config.ts` as `REALM_CONFIG`
- `npx tsc --noEmit` shows type errors — filter with `grep "^src/"` to exclude vendor noise

## Troubleshooting

**"API key not valid"**
- Verify `GEMINI_API_KEY` in `server/.env`
- If using LiteLLM proxy, ensure model names match your proxy config

**"Payload Too Large"**
- Increase `fileSize` limit in `server/src/adapters/http/server.ts` (default 300MB)

**Port already in use**
- Change `PORT` in `server/.env`, or kill the process: `lsof -ti:3000 | xargs kill`

**Import errors**
- Use `.js` extensions in TypeScript imports
- Ensure `"type": "module"` is in package.json
