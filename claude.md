# Claude Context: N1 Personal Realm Generator

> **Last Updated**: 2026-01-12
> **Purpose**: This file helps Claude Code (and new developers) quickly understand the project. Keep it updated as development progresses.

## What This Project Does

Transforms uploaded documents into interactive, self-contained HTML websites called "Realms" using a multi-agent AI pipeline.

**User Flow**: Upload files → Provide prompt → Watch AI processing → Get interactive HTML website

**Not a chat app** - This is a document-to-website generator, not a conversational interface.

## Architecture Quick Reference

### Monorepo Structure
```
client/          → React + Vite (Upload UI, Stream Viewer)
server/          → Fastify + TypeScript (Multi-agent pipeline)
  ├── src/
  │   ├── adapters/      → External integrations (Gemini, HTTP, Storage)
  │   ├── application/   → Business logic (Use Cases)
  │   └── domain/        → Core types and entities
  ├── storage/           → Uploads & Generated Realms (gitignored)
  └── vendor/            → Embedded gemini-cli source code
```

### Hexagonal Architecture (Ports & Adapters)
- **Domain**: Pure business logic, no external dependencies
- **Application**: Use Cases that orchestrate domain logic
- **Adapters**: Implementations for external systems (Gemini API, Fastify, File System)

## Multi-Agent Processing Pipeline

The core workflow uses 4 AI agents in sequence:

1. **Librarian Agent** (`MARKDOWN_MODEL`) - Extracts uploaded files → Markdown
2. **Specialist Agents** (`INTERMEDIATE_MODEL`) - Analyzes data → Facts, Analysis, Relationships
3. **Synthesizer Agent** (`INTERMEDIATE_MODEL`) - Combines insights → Master Report
4. **Builder Agent** (`HTML_MODEL`) - Generates Report → Interactive HTML

**Key Files**:
- `server/src/application/use-cases/extract-document.use-case.ts` - Phase 1
- `server/src/application/use-cases/analyze-documents.use-case.ts` - Phase 2
- `server/src/application/use-cases/synthesize-report.use-case.ts` - Phase 3
- `server/src/adapters/gemini/gemini.adapter.ts` - Gemini API integration

## Important Technical Decisions

### 1. ESM Modules
- **Both** client and server use `"type": "module"` in package.json
- Use `.js` extensions in imports, not `.ts`
- Example: `import { foo } from './bar.js'`

### 2. Vendor Code Integration
- `server/vendor/` contains the embedded `gemini-cli` source code
- **Why it's inside server/**: Allows Node.js to resolve `server/node_modules` for vendor dependencies
- Don't modify vendor code directly - use adapters

### 3. Server-Sent Events (SSE) for Streaming
- Endpoint: `POST /api/realm` returns SSE stream
- Events: `{ type: 'thought', content: '...' }` and `{ type: 'result', realmUrl: '...' }`
- Allows real-time "thinking" display before final result

### 4. File Storage
- **Development**: Local filesystem (`server/storage/`)
- **Production TODO**: Migrate to cloud storage (S3, GCS)
- Structure: `storage/uploads/<uuid>/` and `storage/realms/<uuid>/index.html`

## Environment Configuration

Required vars in `server/.env`:
```env
GEMINI_API_KEY=           # Google Gemini API key (or LiteLLM proxy key)
GOOGLE_GEMINI_BASE_URL=   # API endpoint (default: Google's, can be LiteLLM proxy)
MARKDOWN_MODEL=           # Model for extraction phase
INTERMEDIATE_MODEL=       # Model for analysis/synthesis
HTML_MODEL=               # Model for final HTML generation
```

See `server/.env.example` for full list.

## Development Workflow

### Running Locally
```bash
# Terminal 1: Server with auto-reload
cd server && npm run dev

# Terminal 2: Client with hot reload
cd client && npm run dev
```

### Making Changes

**Adding a new Use Case:**
1. Create in `server/src/application/use-cases/`
2. Define port interface (if needed) in `application/ports/`
3. Wire up in HTTP adapter (`server/src/adapters/http/server.ts`)

**Modifying AI prompts:**
- Look in the use case files (e.g., `analyze-documents.use-case.ts`)
- System prompts are defined inline or in config

**Changing frontend:**
- Main UI is in `client/src/App.tsx`
- Uses native fetch API with SSE stream reader
- Vite proxy forwards `/api` and `/realms` to server

## Common Pitfalls

### ❌ "API key not valid" Error
- Check `GEMINI_API_KEY` is set in `server/.env`
- If using LiteLLM proxy, ensure model names in `.env` match proxy config

### ❌ "Payload Too Large" Error
- Increase `fileSize` limit in `server/src/adapters/http/server.ts`
- Default: 300MB

### ❌ Import errors (ESM)
- Use `.js` extension in imports (TypeScript transpiles `.ts` → `.js`)
- Ensure `"type": "module"` is in package.json

### ❌ Vendor code not resolving dependencies
- `vendor/` must be inside `server/` to access `server/node_modules`
- Don't move it outside

## Current State & TODOs

### ✅ Working
- File upload (multipart/form-data)
- Multi-agent processing pipeline
- Real-time "thinking" stream
- HTML Realm generation and serving
- Basic error handling

### 🚧 In Progress (Check git branch)
- Enhanced analysis capabilities
- Better prompt engineering for agents

### 📋 Future Roadmap
- [ ] Database instead of file storage
- [ ] User authentication
- [ ] Cloud storage integration (S3/GCS)
- [ ] Realm versioning and history
- [ ] Support for more file types
- [ ] Improved error handling and retries
- [ ] Rate limiting and quota management

## Reference Documentation

- **README.md** - Full setup and API documentation
- **QUICKSTART.md** - 5-minute setup guide
- **DESIGN.md** - Original architecture and design decisions

## Key Conventions

1. **TypeScript strict mode** - All code should be properly typed
2. **No any types** - Use proper interfaces/types
3. **Adapter pattern** - All external dependencies go through adapters
4. **Use Cases for business logic** - Keep HTTP handlers thin
5. **Async/await** - Prefer over callbacks and raw Promises
6. **Error handling** - Use try/catch in Use Cases, propagate to HTTP layer
7. **Logging** - Use console.log in development (TODO: proper logger in production)

## Need Help?

1. Check this file first
2. Read relevant documentation (README, DESIGN)
3. Look at existing code patterns in similar files
4. Check git history for context on why things are the way they are

---

**💡 Pro Tip**: When you make significant changes, update this file! Future you (and Claude) will thank you.
