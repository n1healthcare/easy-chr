# N1 Personal Realm Generator

A web application that transforms documents into interactive, self-contained HTML websites ("Realms") using AI-powered multi-agent analysis.

> **Quick Start**: Want to get started immediately? See [QUICKSTART.md](QUICKSTART.md) for a 5-minute setup guide.

## Overview

Instead of a traditional chat interface, users upload documents (medical records, financial statements, research papers, etc.) and provide a prompt. The system uses a multi-agent AI pipeline powered by Google Gemini to:

1. Extract and process document content
2. Analyze the data through specialized agents (Facts, Analysis, Relationships)
3. Synthesize findings into a comprehensive report
4. Generate a fully interactive, self-contained HTML website

Each generated "Realm" is saved permanently and accessible via a unique URL.

## Architecture

This is a monorepo with a hexagonal (ports & adapters) architecture:

```
┌─────────────────┐
│  React Client   │  (Upload UI, Stream Viewer)
└────────┬────────┘
         │
         v
┌─────────────────────────────────────────────────┐
│         Fastify Server (Node.js)                │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  Multi-Agent Processing Pipeline:        │  │
│  │  1. Librarian → Extract to Markdown      │  │
│  │  2. Specialists → Facts/Analysis/Links   │  │
│  │  3. Synthesizer → Master Report          │  │
│  │  4. Builder → Interactive HTML           │  │
│  └──────────────────────────────────────────┘  │
│                                                 │
│  Adapters:                                      │
│  - Gemini AI (Google GenAI SDK)                │
│  - File Storage (Local FS)                     │
│  - HTTP (Fastify + SSE Streaming)              │
└─────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js (v18 or higher recommended)
- npm or yarn
- A Gemini API key or LiteLLM proxy endpoint

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd N1_Interface
```

### 2. Install server dependencies

```bash
cd server
npm install
```

### 3. Install client dependencies

```bash
cd ../client
npm install
```

### 4. Configure environment variables

Create a `.env` file in the `server/` directory:

```bash
cd ../server
cp .env.example .env  # If .env.example exists, otherwise create .env manually
```

Required environment variables (edit `server/.env`):

```env
# Gemini API Configuration
GEMINI_API_KEY=your_api_key_here
GOOGLE_GEMINI_BASE_URL=https://generativelanguage.googleapis.com  # Or your LiteLLM proxy URL
GOOGLE_GEMINI_MODEL=gemini-2.5-pro

# Model Selection for Different Stages
MARKDOWN_MODEL=gemini-2.5-flash
INTERMEDIATE_MODEL=gemini-2.5-pro
HTML_MODEL=gemini-2.5-flash
IMAGE_MODEL=imagen-3.0-generate-001

# Optional: Claude Configuration (if using Anthropic models)
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=your_anthropic_key_here
CLAUDE_MODEL=claude-4.5-haiku

# Optional: Data Directory
DATA_DIRECTORY=data

# Optional: N1 API Configuration
N1_API_HEADER=N1-Api-Key
N1_API_KEY=your_n1_api_key
N1_API_BASE_URL=https://api.n1.care/

# Optional: Observability (Langfuse)
LANGFUSE_SECRET_KEY=your_secret_key
LANGFUSE_PUBLIC_KEY=your_public_key
LANGFUSE_HOST=https://cloud.langfuse.com
OBSERVABILITY_ENABLED=false

# Server Configuration
PORT=3000
```

## Running the Application

### Development Mode

You'll need two terminal windows:

#### Terminal 1: Start the backend server

```bash
cd server
npm run dev
```

The server will start on `http://localhost:3000` with auto-reload on file changes

#### Terminal 2: Start the frontend development server

```bash
cd client
npm run dev
```

The client will start on `http://localhost:5173` (Vite's default port)

### Access the application

Open your browser and navigate to `http://localhost:5173`

## Project Structure

```
N1_Interface/
├── client/                      # React frontend (Vite)
│   ├── src/
│   │   ├── App.tsx             # Main UI component (file upload, stream viewer)
│   │   ├── App.css
│   │   ├── main.tsx
│   │   └── assets/
│   ├── package.json
│   └── vite.config.ts          # Proxy configuration for /api and /realms
│
├── server/                      # Node.js backend (Fastify)
│   ├── src/
│   │   ├── adapters/           # External integrations
│   │   │   ├── gemini/        # Gemini AI adapter
│   │   │   └── http/          # Fastify HTTP server
│   │   ├── application/        # Business logic
│   │   │   └── use-cases/     # Core use cases (GenerateRealm, etc.)
│   │   ├── domain/             # Domain types and entities
│   │   ├── config.ts           # Configuration loader
│   │   └── index.ts            # Application entry point
│   ├── storage/                # Generated content storage
│   │   ├── uploads/           # Uploaded files
│   │   └── realms/            # Generated HTML realms
│   ├── vendor/                 # Embedded gemini-cli source code
│   ├── .env                    # Environment variables (DO NOT COMMIT)
│   ├── package.json
│   └── tsconfig.json
│
├── DESIGN.md                   # Architecture & design decisions
├── ENGINEERING_101.md          # Development journey & technical details
└── README.md                   # This file
```

## API Endpoints

### `POST /api/realm`

Generate a new Realm from uploaded documents.

**Request:**
- Content-Type: `multipart/form-data`
- Fields:
  - `files`: One or more document files (PDF, TXT, etc.)
  - `prompt`: Text prompt describing what to generate

**Response:**
- Server-Sent Events (SSE) stream with:
  - `{ type: 'thought', content: '...' }` - AI reasoning process
  - `{ type: 'result', realmUrl: '/realms/<uuid>/index.html' }` - Final URL

**Example (using curl):**

```bash
curl -X POST http://localhost:3000/api/realm \
  -F "files=@/path/to/document.pdf" \
  -F "prompt=Analyze this medical record and create an interactive health dashboard"
```

### `GET /realms/:id/index.html`

Access a generated Realm by its unique ID.

## How It Works

1. **Upload Phase**: User selects files and enters a prompt
2. **Processing Phase**: Server streams AI "thinking" process in real-time
3. **Generation Phase**: Multi-agent pipeline processes the documents:
   - **Librarian Agent**: Extracts raw text → Markdown
   - **Specialist Agents**: Analyze data → Facts, Analysis, Relationships
   - **Synthesizer Agent**: Combines insights → Master Report
   - **Builder Agent**: Generates interactive HTML from report
4. **Result Phase**: User receives URL to access the generated Realm

## Development Notes

### Key Technologies

- **Frontend**: React 19, Vite, TypeScript
- **Backend**: Node.js, Fastify, TypeScript (ESM modules)
- **AI**: Google Gemini API (@google/genai SDK)
- **Storage**: Local filesystem (production should use cloud storage)
- **Streaming**: Server-Sent Events (SSE)

### Important Considerations

- The project uses ESM modules (`"type": "module"`)
- The `vendor/` directory contains the embedded `gemini-cli` source code
- File uploads are limited to 300MB by default (configurable in server.ts)
- Generated Realms are stored permanently in `server/storage/realms/`

## Production Deployment

Before deploying to production:

1. Set up proper environment variables (remove example/development keys)
2. Configure a production-grade database instead of file storage
3. Implement authentication and authorization
4. Add file upload validation and sanitization
5. Configure CORS properly for your domain
6. Use a reverse proxy (nginx, Caddy) in front of the application
7. Set up SSL/TLS certificates
8. Consider using cloud storage (S3, GCS) for uploads and generated realms

## Troubleshooting

### "API key not valid" error
- Check that `GEMINI_API_KEY` is set correctly in `server/.env`
- Verify the API key is valid and has access to the specified models
- If using a proxy (LiteLLM), ensure the model names match your proxy configuration

### "Payload Too Large" error
- Increase the `fileSize` limit in `server/src/adapters/http/server.ts`
- Default is 300MB, adjust as needed

### Port already in use
- Change the `PORT` variable in `server/.env`
- Or kill the process using the port: `lsof -ti:3000 | xargs kill`

## Contributing

See `ENGINEERING_101.md` for detailed development history and technical decisions.

## License

[Specify your license here]
