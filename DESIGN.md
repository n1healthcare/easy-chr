# Design Document: Personal Realm Generator

## 1. Executive Summary
The goal is to build a "Personal Realm Generator" web application. Instead of a traditional chat interface, users upload documents (e.g., medical records, financial statements) and provide a prompt. The system uses the `gemini-cli` core logic to generate a fully interactive, self-contained HTML website ("The Realm") based on the input data. This generated realm is saved permanently and can be accessed via a unique URL.

## 2. Architecture Overview

We adopt a **Monorepo Architecture** with **Pragmatic Hexagonal Architecture** standards.

### 2.1 High-Level Components
*   **The Core (Vendor):** The existing `google-gemini/gemini-cli` packages (source code), treated as a library in `server/src/adapters/gemini`.
*   **The Backend (Server):** A Node.js/Fastify server.
    *   **Domain:** Entities (`Realm`, `Document`).
    *   **Application:** Use Cases (`GenerateRealmUseCase`).
    *   **Adapters:** HTTP (Fastify), LLM (Gemini), Storage (Local File System).
*   **The Frontend (Client):** A React-based Single Page Application (SPA).

### 2.2 Diagram
```mermaid
[User Browser] --(Upload File + Prompt)--> [Node.js Server]
      |                                         |
      |                                         +----(Phase 0: Librarian)----> [Source Docs (Markdown)]
      |                                         |
      |                                         +----(Phase 1: Specialists)--> [Facts/Analysis/Relationships]
      |                                         |
      |                                         +----(Phase 2: Synthesizer)--> [Master Report]
      |                                         |
      |                                         +----(Phase 3: Builder)------> [HTML Realm]
      |                                                                             |
   (React UI) <--(URL to Realm)---------- [File Storage] <--------------------------|
```

## 3. Technical Implementation

### 3.1 Backend (The Engine)
*   **Language:** TypeScript (Node.js)
*   **Framework:** Fastify.
*   **Architecture:** Hexagonal (Ports & Adapters).
*   **Storage:**
    *   **Documents:** Uploaded files are stored in `server/storage/uploads/`.
    *   **Realms:** Generated HTML files and intermediate artifacts are stored in `server/storage/realms/<id>/`.
*   **API Endpoints:**
    *   `POST /api/realm`:
        *   Input: `multipart/form-data` (File + Prompt).
        *   Process (The Multi-Agent Pipeline):
            1.  **Librarian Agent:** Extracts raw files to `source_documents/*.md` using `MARKDOWN_MODEL`.
            2.  **Specialist Agents:** Analyzes extracted docs using `INTERMEDIATE_MODEL`.
                *   Facts Agent -> `facts.md`
                *   Analysis Agent -> `analysis.md`
                *   Relationships Agent -> `relationships.md`
            3.  **Synthesizer Agent:** Compiles findings into `report.md` using `INTERMEDIATE_MODEL`.
            4.  **Builder Agent:** Generates `index.html` from the report using `HTML_MODEL`.
        *   Output: JSON `{ realmUrl: "/realms/<id>/index.html" }`.
    *   `GET /realms/*`: Static file serving for the generated realms.

### 3.2 Frontend (The Generator UI)
*   **Framework:** React + Vite.
*   **User Flow:**
    1.  **Input Stage:**
        *   **File Dropzone:** Mandatory. User must drag & drop a file (PDF, TXT, etc.).
        *   **Prompt Input:** Text field (e.g., "What does my medical record say? Visualize it.").
        *   **Generate Button:** Disabled until file is present.
    2.  **Processing Stage:** Loading spinner/progress bar.
    3.  **Result Stage:**
        *   Display a large button: **"Enter Realm"**.
        *   Clicking it opens the generated HTML page in a new browser tab.

### 3.3 Gemini Adapter Enhancements
*   **File Handling:** The adapter must support reading the uploaded file buffer and passing it to the `GoogleGenAI` SDK (using `inlineData` or `fileData`).
*   **Output Enforcement:** We will wrap the prompt to strictly enforce `<!DOCTYPE html>` output and suppress Markdown code blocks if possible, or strip them post-generation.

## 4. Development Phases

1.  **Refactor:** Pivot existing Chat UI code to the new Realm Generator architecture.
2.  **File Upload (Backend):** Implement `multipart` support in Fastify and storage logic.
3.  **File Upload (Frontend):** Implement Drag & Drop UI.
4.  **Gemini Integration Update:** Modify `GeminiAdapter` to accept file buffers and context.
5.  **Realm Generation (Multi-Agent Pipeline):**
    *   **Phase 0 (Librarian):** Implement `ExtractDocumentUseCase` (PDF -> Markdown).
    *   **Phase 1 (Specialists):** Implement `AnalyzeDocumentsUseCase` (Markdown -> Insights).
    *   **Phase 2 (Synthesizer):** Implement `SynthesizeReportUseCase` (Insights -> Master Report).
    *   **Phase 3 (Builder):** Implement HTML generation from Report.
6.  **Validation:** Verify end-to-end flow with a real PDF upload.
