# Engineering 101: The Journey of the Personal Realm Generator

This document chronicles the development journey of this project, detailing the decisions, challenges, fixes, and current architecture. It serves as a guide for future developers (and myself) to understand *why* things are the way they are.

## 1. Project Inception: The "Gemini Wrapper"

**Initial Goal:** Build a custom web-based Chat UI that wraps the logic of the `google-gemini/gemini-cli` repository.
**Constraint:** Do not spawn a subprocess. Instead, import the `core` logic directly from the CLI's source code.

### Phase 1: Architecture & Setup
*   **Monorepo:** We chose a monorepo structure to keep `client`, `server`, and `vendor` (the CLI code) together.
    *   `client/`: React + Vite Frontend.
    *   `server/`: Node.js + Fastify Backend.
    *   `server/vendor/`: The cloned `gemini-cli` repository.
*   **Hexagonal Architecture:** We enforced a strict separation of concerns in the backend:
    *   **Domain:** Core types (`Message`, `ChatSession`).
    *   **Application:** Business logic (`Use Cases`, `Ports`).
    *   **Adapters:** External integrations (`GeminiAdapter`, `FastifyServer`).

### Phase 2: The "Bridge" (POC)
**Challenge:** How to import TypeScript code from a sibling folder (`vendor`) that has its own dependencies?
**Attempt 1 (Failed):** Symlinking `node_modules` between `server` and `vendor`. This caused resolution hell with `tsx` and ESM.
**The Solution:** We moved `vendor` *inside* `server/` (`server/vendor/`). This allowed Node.js resolution to naturally find `server/node_modules` when running vendor code, solving the dependency issues without complex symlinks or workspaces.

**Challenge:** ESM vs CommonJS.
**The Fix:** We converted the entire `server` project to ESM (`"type": "module"` in `package.json`) to match the `gemini-cli` source code.

**Result:** We successfully instantiated `GeminiChat` and sent a "Hello" message to Google's API, receiving a `400 Bad Request` (due to dummy key), which proved the integration worked.

## 2. The Pivot: "Personal Realm Generator"

**Feedback:** "I don't want a chat interface. I want to upload files and generate a 'Realm' (HTML website)."
**New Goal:** Build a system that takes multiple files + prompt -> Outputs a self-contained HTML dashboard.

### Phase 3: File Uploads & Generation
*   **Backend:** Added `@fastify/multipart` to handle file uploads.
*   **Storage:** Implemented local file storage for uploads (`storage/uploads`) and generated realms (`storage/realms`).
*   **Use Case:** Created `GenerateRealmUseCase` which:
    1.  Reads uploaded files.
    2.  Constructs a System Prompt enforcing `<!DOCTYPE html>` output.
    3.  Streams the response from Gemini.
    4.  Saves the HTML content to `index.html`.
    5.  Returns the URL to access it.

### Phase 4: Frontend Updates
*   Replaced Chat UI with a **File Dropzone** and **Generator Dashboard**.
*   Added support for multiple file selection.
*   Configured Vite proxy to forward `/api` and `/realms` requests to the backend.

## 3. Critical Engineering Challenges & Fixes

### 3.1 The "Payload Too Large" Error
*   **Symptom:** Uploading large PDFs caused a 413 error.
*   **Cause:** Fastify's default multipart limit is small.
*   **Fix:** Increased `fileSize` limit to 300MB in `server.ts`.

### 3.2 The "API Key Not Valid" / "Not Found" Saga
*   **Symptom:** Backend returned 500 errors with messages like "API key not valid" or `{"detail": "Not Found"}`.
*   **Root Cause 1:** The `.env` file had `GOOGLE_GEMINI_API_KEY`, but the library expected `GEMINI_API_KEY`.
    *   *Fix:* Updated `.env` variable name.
*   **Root Cause 2:** The user's environment might have been pointing to a proxy (LiteLLM) via `GEMINI_API_KEY` that mimics OpenAI format (`sk-...`), but the library uses Google's SDK.
    *   *Observation:* The error `{"detail": "Not Found"}` is characteristic of LiteLLM/FastAPI, proving the request *was* reaching the proxy but the model `gemini-2.5-pro` was not found/mapped correctly on the proxy side.
*   **Status:** The software is correctly wired. The error confirms end-to-end connectivity.

### 3.3 The "Streaming Thoughts" Feature
*   **Requirement:** Show the model's "thinking" process in real-time, but *exclude* it from the final HTML file.
*   **Challenge:** How to separate "thoughts" from "code" in a single stream?
*   **Solution:**
    1.  **Backend:** Implemented a parser in `GenerateRealmUseCase`. It streams everything *before* the `<!DOCTYPE html>` tag as "thought" events. Once the HTML tag is found, it switches to "buffering" mode and saves the rest to the file.
    2.  **Protocol:** Switched `/api/realm` to use **Server-Sent Events (SSE)** (or pseudo-SSE) to yield `{ type: 'thought' }` and `{ type: 'result' }` events.
    3.  **Frontend:** Implemented a stream reader that parses these events, updating a "Thinking Console" UI component in real-time.

## 4. Current Architecture

### Directory Structure
```
root/
├── client/                 # React Frontend
│   ├── src/App.tsx         # Generator UI & Stream Handler
│   └── vite.config.ts      # Proxy config (/api, /realms)
├── server/                 # Node.js Backend
│   ├── src/
│   │   ├── adapters/       # Gemini & Fastify implementations
│   │   ├── application/    # Use Cases (GenerateRealm)
│   │   └── domain/         # Types
│   ├── vendor/             # Embedded gemini-cli source code
│   └── storage/            # Persisted uploads and realms
└── ENGINEERING_101.md      # You are here
```

### Key Flows
1.  **Upload:** Client sends `POST /api/realm` (Multipart).
2.  **Processing:** Server saves files -> Calls `GenerateRealmUseCase`.
3.  **Streaming:**
    *   UseCase calls `GeminiAdapter`.
    *   Gemini streams chunks.
    *   UseCase detects "Thoughts" vs "HTML".
    *   Server flushes "Thinking" events to Client immediately.
    *   Client updates "Thinking Process" UI.
4.  **Completion:**
    *   UseCase saves HTML to `storage/realms/<uuid>/index.html`.
    *   Server sends "Result" event with URL.
    *   Client shows "Enter Realm" button.

## 5. Future Improvements (Roadmap)
1.  **Markdown Intermediate Step:** To improve data retention, instruct the model to generate a Markdown report *first* (captured in the "Thinking" stream), then generate the HTML.
2.  **Database:** Replace in-memory/file storage with a real DB for session tracking.
3.  **Security:** Add auth middleware and sanitize file uploads.
    *   **Image Generation:** Uses `GoogleGenAI` SDK to call the Imagen model (`imagen-3.0-generate-001`).
