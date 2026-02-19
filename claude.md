# Claude Context: N1 Personal Realm Generator

> **Last Updated**: 2026-02-19
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

The core workflow uses a **9-phase agentic medical analysis pipeline** orchestrated by `AgenticDoctorUseCase`:

| Phase | Name | Output | Description |
|-------|------|--------|-------------|
| 1 | Document Extraction | `extracted.md` | Pre-extracted markdown from N1 API (fast path) or PDFs → Vision OCR (fallback), combined into one file |
| 2 | Agentic Medical Analysis | `analysis.md` | 35-cycle iterative exploration with tools (list_documents, search_data, get_date_range, extract_timeline_events, get_value_history, update_analysis) |
| 3 | Cross-System Analysis | `cross_systems.md` | Identifies bidirectional relationships between body systems |
| 4 | Research | `research.json` | Claim extraction + web search validation |
| 5 | Agentic Data Structuring | `structured_data.json` | **SOURCE OF TRUTH** - Agentic loop builds 25+ semantic fields section-by-section. analysis.md + research.json in context; full extracted.md accessible via tools (search_source, get_value_history, get_date_range) |
| 6 | Validation | `validation.md` | Completeness check with 1 correction cycle |
| 7 | HTML Generation | `index.html` | Data-driven rendering with Plotly visualizations |
| 8 | Content Review | `content_review.json` | 4-dimensional QA (question addressed, fidelity, completeness, design) |
| 9 | HTML Regeneration | `index.html` | Only runs if Phase 8 fails |

**Data Flow**:
```
Uploaded Files → extracted.md → analysis.md → cross_systems.md
                                    ↓
                            research.json
                                    ↓
                        structured_data.json (validated)
                                    ↓
                              index.html
```

**Key Files**:
- `server/src/application/use-cases/agentic-doctor.use-case.ts` - Main orchestrator (three entry points: `execute`, `executeWithExtractedContent`, `executeWithMixedSources`)
- `server/src/application/use-cases/fetch-and-process-pdfs.use-case.ts` - Job-runner orchestrator (markdown fetch → PDF fallback → pipeline)
- `server/src/adapters/n1-api/n1-api.adapter.ts` - N1 API integration (markdown + PDF fetching)
- `server/src/application/ports/markdown-fetcher.port.ts` - Port interface for markdown/PDF fetching
- `server/src/services/agentic-medical-analyst.service.ts` - Phase 2 agent with tool executor
- `server/src/services/agentic-data-structurer.service.ts` - Phase 5 agent with tool executor (StructurerToolExecutor + AgenticDataStructurer)
- `server/src/services/agentic-validator.service.ts` - Phase 6 agent with tool executor
- `server/src/services/research-agent.service.ts` - Phase 4 research
- `server/src/services/pdf-extraction.service.ts` - Phase 1 PDF OCR
- `.gemini/skills/*/SKILL.md` - All agent prompts (dynamically loaded)

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

### 4. Per-Record Markdown Fallback to PDF + Vision OCR
- Records uploaded after parser-router PR #94 have pre-extracted markdown available via `/records/{record_id}/markdown`
- Older records will 404 on that endpoint — these fall back to PDF download + Gemini Vision OCR
- `MarkdownFetcherPort.fetchMarkdownsForUser()` returns `{ markdowns, failedRecordIds }`
- `FetchAndProcessPDFsUseCase` routes to one of three paths:
  - **All markdown** → `executeWithExtractedContent()` (fast path, no OCR)
  - **Mixed** → `executeWithMixedSources()` (OCR only the fallback PDFs, combine with markdown)
  - **PDF fallback fails** → proceeds with whatever markdowns were fetched (degraded but not fatal)
- All paths produce a single combined `extracted.md` for Phases 2-9

### 5. File Storage
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

### Running the Job Runner Locally

The job runner is the production entry point (K8s job mode). To test locally:

```bash
cd server
USER_ID=ad405f4e-8089-4e23-8b9c-03c8f2648d16 CHR_ID=test ENVIRONMENT=development npx tsx src/job-runner.ts
```

- `ENVIRONMENT=development` skips S3 uploads and progress tracking
- `CHR_ID` can be any string (just a label for logs)
- `USER_ID` must be a real user ID with records in the N1 API
- Requires `N1_API_BASE_URL` and `N1_API_KEY` in `server/.env`

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

## Pipeline Assessment (2026-02-06)

### Strengths

**1. Agentic Exploration (Phase 2) - Exceptional**
- `AgenticMedicalAnalyst` with 25 iterative cycles mimics real physician reasoning
- Tools like `search_data()`, `update_analysis()` allow hypothesis-driven exploration
- Not a single-pass summary - it actually *investigates* the data
- Output demonstrates genuine clinical insight (e.g., identifying Vitamin C → DBH → Adrenaline pathway blocks)

**2. Cross-System Reasoning (Phase 3) - Strong**
- Correctly links disparate findings (Glyceric+Oxalic → Type II Hyperoxaluria)
- Identifies causal chains rather than just listing abnormalities
- "Connections NOT Found" section prevents false pattern matching

**3. Data Structuring (Phase 5) - Robust**
- Comprehensive JSON with 25+ semantic fields covering clinical categories
- Proper typing with reference ranges, units, and status flags
- `connections` array explicitly models causal relationships with confidence levels
- `trends` array with dataPoints enables longitudinal visualization

**4. Validation Loop (Phase 6) - Thoughtful**
- **Comprehensive validation** across 8 dimensions:
  1. Numeric completeness (every lab value, date, measurement)
  2. Qualitative completeness (symptoms, medications, history)
  3. Calculation accuracy
  4. Claim support verification
  5. Context preservation
  6. Internal consistency
  7. Recommendation traceability
  8. Patient question relevance
- Catches real issues (e.g., using historical vs current values, borderline interpretations stated as abnormal)
- **"1 correction cycle"** = if validation fails, sends issues back to data structurer for ONE correction attempt, then proceeds regardless (prevents infinite loops where fixing one issue creates another)

**5. HTML Output - Production Quality**
- Modern "Claymorphism" design aesthetic
- Plotly.js for interactive gauges, trends, radar charts
- Responsive grid layout with mobile breakpoints
- Clear visual hierarchy for critical findings

### Weaknesses & Known Issues

**1. Data Truncation Throughout the Pipeline (Partially Fixed)**

All truncations in this pipeline share the same origin: they were added **before the chat compression service existed**, as pragmatic workarounds for Gemini API token limit errors and timeouts on large single-shot LLM calls. Now that compression handles conversation history growth, most of these are no longer necessary — but not all have been removed.

**Complete truncation audit** (as of 2026-02-19):

| Location | What's truncated | Cap | Phase | LLM Input? | Status |
|----------|-----------------|-----|-------|------------|--------|
| `agentic-doctor.ts:808` | Full `extracted.md` → only lab-dense subset | **50KB** | 5 (Structurer) | ✅ YES — critical | ✅ Resolved — Phase 5 is now agentic (2026-02-19) |
| `source-excerpts.ts:157` | Source excerpts for correction loop | **100KB** | 6 (Validator correction) | ✅ YES | ⚠️ May be raisable |
| `agentic-validator.ts` | Unique values returned by tool | **20 items** | 6 (Validator) | ✅ YES | 🔧 Should be removed |
| `agentic-validator.ts` | Search match results per query | **5 results** | 6 (Validator) | ✅ YES | 🔧 Should be removed |
| `agentic-validator.ts` | Events per year in timeline check | **10 events** | 6 (Validator) | ✅ YES | 🔧 Should be removed |
| `agentic-validator.ts` | JSON keys shown in tool results | **15 keys** | 6 (Validator) | ✅ YES | 🔧 Should be removed |
| `agentic-analyst.ts` | `search_data` matches per section | **removed** | 2 (Analyst) | ✅ (was YES) | ✅ Fixed 2026-02-19 |
| `agentic-analyst.ts` | `search_data` total sections | **removed** | 2 (Analyst) | ✅ (was YES) | ✅ Fixed 2026-02-19 |
| `agentic-analyst.ts` | `extract_timeline_events` per year | **removed** | 2 (Analyst) | ✅ (was YES) | ✅ Fixed 2026-02-19 |
| Streaming logs | Tool args, thinking text, event messages | 100–500 chars | All | ❌ NO | ✅ Fine — display only |
| Date snippets | Context around extracted dates | 80–100 chars | 2, 6 | ❌ NO | ✅ Fine — internal only |

**Phase 5 (Structurer) 50KB cap — RESOLVED (2026-02-19):**
Phase 5 is now an agentic loop (`AgenticDataStructurer`) with the same tool-based approach as Phase 2. `analysis.md` and `research.json` are passed directly in context (manageable size); the full `extracted.md` is accessed via tools (`search_source`, `get_value_history`, `get_date_range`). The `extractLabSections(50_000)` call has been removed. Chat compression handles history growth across iterations.

**Why validator tool caps exist:**
The agentic validator was built after compression, but its tool result caps were added by analogy with earlier patterns and never cleaned up. Since compression handles history growth, these caps can be safely removed.

**2. Loss of Precision Through Pipeline**
- Each transformation (Raw → Analysis → JSON → HTML) risks information loss
- Validation has caught: RF cited as "40" (2021) instead of current "21-29"; Ceruloplasmin labeled "Low" when borderline
- Analyst summarizes rather than preserving exact values

**3. Research Phase Brittleness**
- Relies on regex parsing for claim extraction (`**Claim**: ... **Search**: ...`)
- If analysis doesn't follow exact format, claims won't be extracted

**4. Timeline Sparseness**
- Despite 18 years of data, timeline arrays often sparse (3 entries from 2024-2025)
- **Root causes** (three compounding factors):
  1. **Analyst prioritizes abnormal values**: Has 35 cycles for 100+ potential sections, must choose what to explore. Historical normal values get skipped.
  2. **Analyst search results were capped** (fixed 2026-02-19): `search_data` was returning at most 15 sections × 10 matches. Even if the analyst searched for a marker across 18 years, it only saw a fraction of results. Now removed.
  3. **Structurer is blind to raw data**: Phase 5 only sees a 50KB lab-dense subset of `extracted.md` plus the analyst's interpretation. Anything the analyst didn't write about never reaches `structured_data.json`.
- **Missing architectural piece**: No dedicated Data Inventory Phase that extracts ALL values/dates before analysis

### Logic Issues

**1. Phase Ordering - Research After Analysis**
- Research (Phase 4) happens *after* analysis is complete
- Claims validated post-hoc rather than informing the analysis
- No feedback loop if research contradicts analysis

**2. Validator Checks Wrong Direction (Critical)**
- Skill says: "Every numeric value in extracted.md must appear in structured_data.json"
- Actually does: Checks that values IN the JSON exist in the source (accuracy, not completeness)
- **Root cause**: Architectural inconsistency in how phases handle large files:

  | Phase | Approach | Result |
  |-------|----------|--------|
  | Phase 2 (Analyst) | Tool-based: `list_documents()`, `read_document()`, `search_data()` | Works - explores full corpus incrementally |
  | Phase 5 (Structurer) | Excludes raw data ("causes 991KB+ timeouts") | Data loss - only sees analyst interpretation |
  | Phase 6 (Validator) | Includes full 1.6MB in single prompt | LLM can't process - samples ~35 items |

- Result: "Items Verified: 35+" out of potentially hundreds → declares PASS
- **This is why 18 years of data reduced to 3 timeline entries wasn't flagged**
- **Fix**: Give validator tool-based access like analyst has:
  ```
  list_all_values()          → Inventory every numeric value from source
  list_all_timeline_events() → Inventory every dated event
  check_in_json(marker, val) → Verify source value appears in JSON
  find_missing_in_json()     → Diff source inventory vs JSON
  ```

**3. Validation Corrections Not Propagated Upstream**
- Phase 6 validation is comprehensive (checks 8 dimensions, 40+ sub-checks)
- However, corrections only update `structured_data.json`
- `analysis.md` and `cross_systems.md` retain original errors (e.g., if validator catches "RF is 40" should be "RF is 21-29", the analysis.md still says 40)

**4. HTML Regeneration Dependency**
- Phase 9 uses same `structured_data.json` - if data is wrong, regeneration can't fix it

**5. No Data Inventory Phase (Architectural Gap)**
- Analyst is a clinical interpreter (forms hypotheses, finds patterns)
- No phase systematically extracts ALL values, dates, events into structured inventory
- Analyst has 20 cycles for 100+ sections → must prioritize → skips "less important" historical data
- Data Structurer only sees analyst's interpretation, not raw data (excluded to avoid timeouts)
- Result: Data that analyst didn't explore never reaches structured_data.json

### Recommendations

0. **Remove validator tool result caps**: `agentic-validator.service.ts` still has pre-compression slice caps on tool results (20 unique values, 5 search results, 10 events/year, 15 JSON keys). These were added before compression existed. Since compression now handles history growth, remove them the same way analyst caps were removed (2026-02-19).

1. **Make Validator Agentic**: Give validator the same tool-based approach as the analyst:
   - `list_all_values()` - inventory all numeric values from source
   - `list_all_timeline_events()` - inventory all dated events
   - `check_in_json(marker, val)` - verify source value appears in JSON
   - `find_missing_in_json()` - diff source inventory vs JSON
   - This allows systematic Source → JSON completeness checking
2. **Pre-Extract Data Inventory**: Before Phase 2, create a structured inventory of ALL values/events from extracted.md that downstream phases can reference
3. **Research-Informed Analysis**: Move research to before/parallel with analysis so claims inform the analysis
4. **Question Requirement**: Make patient question mandatory - pipeline designed for focused analysis
5. **Confidence Propagation**: Flow confidence scores through pipeline (suspected vs confirmed diagnoses)

### Tool Enhancement Implementation Plan

#### Current Analyst Tools
| Tool | Purpose | Limitation |
|------|---------|------------|
| `list_documents()` | See document names & sizes | No date/temporal info |
| `read_document(name)` | Read specific document | Must know name |
| `search_data(query)` | Text search | No structured value extraction |
| `get_analysis()` | Review current analysis | - |
| `update_analysis()` | Build analysis | - |
| `complete_analysis()` | Signal done | No completeness verification |

#### P0: Critical Tools (Address Timeline Sparseness)

**For Analyst AND Validator:**

```typescript
// 1. get_date_range() - Temporal awareness
// Implementation: Parse all dates from parsedData.sections using regex
// Returns: { earliest: "2007-09", latest: "2025-10", years: 18, documentsByYear: {...} }
// Impact: LLM knows data scope before exploring

// 2. extract_timeline_events() - Systematic event extraction
// Implementation: Regex extract all dated events from sections (locally, not LLM)
// Returns: [{ date: "2007-09-15", document: "CBC", event: "Lab test", snippet: "..." }, ...]
// Impact: Provides complete timeline without LLM needing to find each one

// 3. list_documents_by_year() - Temporal distribution
// Implementation: Group parsedData.sections by extracted year
// Returns: { 2007: ["CBC Report"], 2008: ["Metabolic Panel"], ..., 2025: ["OAT", "Bartonella"] }
// Impact: LLM sees temporal gaps explicitly
```

**Validator-Specific:**

```typescript
// 4. compare_date_ranges() - Bidirectional timeline check
// Implementation: Compare source date range vs structured_data.json timeline
// Returns: { source: "2007-2025", json: "2024-2025", missingYears: [2007,2008,...,2023] }
// Impact: Directly flags timeline sparseness

// 5. get_structured_json() - Access JSON for comparison
// Implementation: Return parsed structured_data.json
// Returns: The full JSON object
// Impact: Validator can inspect what was captured
```

#### P1: Important Tools (Improve Coverage)

```typescript
// 6. get_value_history(marker: string) - Track specific marker
// Implementation: Search all sections for marker, extract values with dates
// Returns: [{ date: "2024-05", value: 10.4, unit: "umol/L" }, { date: "2025-07", value: 20.08 }]
// Impact: Ensures trends are captured completely

// 7. list_unique_markers() - Show all markers found
// Implementation: Regex extract all lab marker names from sections
// Returns: ["Homocysteine", "TSH", "Neutrophils", "Oxalic Acid", ...]
// Impact: Analyst/Validator knows universe of data

// 8. check_value_in_json(marker: string, value: number) - Verify capture
// Implementation: Search structured_data.json for marker+value
// Returns: { found: true, location: "criticalFindings[2]" } or { found: false }
// Impact: Validator can verify specific values were captured

// 9. find_values_missing_from_json() - Bidirectional completeness
// Implementation: Extract all values from source, check each against JSON
// Returns: [{ marker: "TSH", value: 2.3, date: "2008-03", location: "CBC Report" }, ...]
// Impact: The key bidirectional check for data fidelity
```

#### P2: Nice-to-Have Tools (Coverage Tracking)

```typescript
// 10. get_exploration_stats() - Track thoroughness
// Implementation: Count documents read, searches performed, sections accessed
// Returns: { documentsRead: 12, documentsTotal: 47, coveragePercent: 25 }
// Impact: LLM knows if it's being thorough

// 11. list_unread_documents() - Explicit gaps
// Implementation: Track which documents haven't been accessed via read_document()
// Returns: ["2008 CBC", "2012 Thyroid Panel", ...]
// Impact: Prompts LLM to explore more
```

#### Implementation Location

All tools implemented in `server/src/services/agentic-medical-analyst.service.ts`:

1. **Extend `ParsedExtractedData` interface** (line 75-80):
   ```typescript
   interface ParsedExtractedData {
     sections: DocumentSection[];
     documentNames: string[];
     totalCharacters: number;
     totalSections: number;
     // NEW:
     dateRange: { earliest: string; latest: string; years: number };
     documentsByYear: Record<string, string[]>;
     allTimelineEvents: TimelineEvent[];
     allMarkers: string[];
   }
   ```

2. **Enhance `parseExtractedData()` function** (line 183-235):
   - Add date extraction regex
   - Add marker extraction regex
   - Populate new fields during initial parse

3. **Add new tool definitions to `ANALYST_TOOLS`** (line 86-177):
   - Add tool declarations for each new tool

4. **Extend `AnalystToolExecutor` class** (line 241-439):
   - Add implementation for each new tool

5. **Create `ValidatorToolExecutor` class** (new):
   - Extends AnalystToolExecutor
   - Adds JSON comparison tools
   - Takes both extractedContent AND structuredDataJson

6. **Create `AgenticValidator` service** (new file):
   - Similar structure to AgenticMedicalAnalyst
   - Uses ValidatorToolExecutor
   - Called from Phase 6 instead of single-pass validation

#### Skill Updates Required

1. **Update `.gemini/skills/medical-analysis/SKILL.md`**:
   - Document new tools in "Available Tools" section
   - Add "Timeline Completeness Requirement" to completion criteria
   - Add example usage of `get_date_range()` and `extract_timeline_events()`

2. **Update `.gemini/skills/validator/SKILL.md`**:
   - Change from single-pass to agentic with tools
   - Document comparison tools
   - Add workflow: "Call compare_date_ranges() FIRST to check timeline coverage"

### Quality Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | 9/10 | Clean separation, skill-based prompts, graceful degradation |
| Clinical Reasoning | 8/10 | Strong cross-system connections, some precision loss |
| Data Fidelity | 6/10 | Validation catches issues, corrections don't fully propagate |
| Output Quality | 9/10 | Professional HTML, comprehensive JSON, interactive visualizations |
| Robustness | 7/10 | Regex-dependent research, single correction cycle |

---

## Pipeline Audit — Known Concerns (2026-02-19)

Full end-to-end review of `agentic-doctor.use-case.ts` and all phase services. Concerns are categorized by severity.

### 🔴 High — Could break functionality

**H1 · Shared intermediate file paths across concurrent sessions**
- `LegacyPaths.extracted`, `LegacyPaths.analysis`, `LegacyPaths.structuredData`, `LegacyPaths.validation` etc. are global paths, NOT scoped to the session UUID.
- The session UUID (`realmId`) only scopes the final output: `LegacyPaths.realm(realmId)`.
- If two pipeline runs overlap, they write `extracted.md`, `analysis.md`, `structured_data.json` to the same files and silently corrupt each other's state.
- Currently safe only because the app handles one request at a time in practice — a latent concurrency bug.
- **Fix**: Scope all intermediate paths to `realmId` or add a request queue / mutex.

**H2 · Missing SKILL.md falls back silently to a 1-line generic prompt**
- `loadSkill()` catches file-not-found and returns a fallback string like `'You are a medical analyst...'`.
- The agentic phases still get their tools registered but have no workflow guidance, no required-sections list, no completion criteria.
- The agent would call tools randomly, likely never call `complete_analysis`, and hit `maxIterations` — surfacing only as very short or empty output, not as an obvious error.
- **Fix**: Log a loud warning (or throw) if a SKILL.md for an agentic phase is missing. Distinguish between "skill not found" and "skill loaded with fallback".

---

### 🟡 Medium — Quality or correctness issues

**M1 · Phase 2 failure yields `extracted.md` URL instead of an error event**
- On analysis failure (line ~714): `yield { type: 'result', url: LegacyPaths.extracted }`.
- The client receives a "result" URL pointing to a markdown file it can't render — a broken UX.
- All other fatal phase failures correctly yield `{ type: 'error', content: '...' }` and return.
- **Fix**: Replace with `yield { type: 'error', content: 'Medical analysis failed: ...' }`.

**M2 · Max-iteration fallback doesn't check required sections**
- If the analyst exhausts 35 iterations without calling `complete_analysis`, it returns whatever it accumulated.
- The orchestrator only checks `analysisContent.trim().length === 0`.
- An analyst that timed out after only writing an "Executive Summary" proceeds to Phase 3 with a truncated analysis — no warning.
- **Fix**: After consuming the analyst generator, check that `analysisContent` contains the key required section headers before proceeding.

**M3 · Claim extraction via rigid regex — silent skip on format variation**
- Research agent parses LLM output via: `/**Claim**: .../` and `/**Search**: .../` regex.
- If the model formats slightly differently (colon placement, bullet numbering, different bold markers), `claims.length === 0` and research is silently skipped with no error event.
- Already documented under Weaknesses but worth tracking as an active bug.
- **Fix**: Make claim extraction more flexible, or switch to structured output (JSON schema) for the claim-extraction LLM call.

**M4 · Content review uses raw `sendMessageStream` — no retry**
- HTML generation uses `streamWithRetry(maxRetries=3)`. Content review (line ~1441) uses raw `sendMessageStream` with no retry wrapper.
- On transient failure the pipeline catches it and defaults to `passed: true` — silently skipping the entire review.
- **Fix**: Wrap in `streamWithRetry` the same way HTML generation is wrapped. Or at minimum log a visible warning when falling back to `passed: true`.

**M5 · Content review prompt payload is 400–700KB — highest timeout risk in the pipeline**
- The review prompt includes both `structuredDataContent` (~100–200KB) and `htmlContent` (~200–500KB) in a single call.
- Runs on `doctor` model (1M context), so it won't hard-fail, but at 100K–175K tokens it's the most expensive and latency-sensitive single call in the pipeline.
- **Fix short-term**: Pass only `structuredDataContent` + a condensed HTML summary (section headers + key values) rather than the full HTML.
- **Fix long-term**: Make content review agentic with targeted checks rather than a full-document comparison.

**M6 · Validation correction stream has no retry**
- The correction call at line ~1066 uses `this.llmClient.sendMessageStream` directly — no `streamWithRetry` wrapper.
- The adapter-level retry comment (line 37) acknowledges retry is at the adapter, but mid-stream drops may not be caught at that layer.
- **Fix**: Wrap in `streamWithRetry` consistent with HTML generation.

---

### 🟢 Low — Design notes and minor issues

**L1 · `REALM_CONFIG.agenticLoop.maxIterations` and `enableWebSearch` are unused**
- Both config values exist in `config.ts` and can be set via env vars but are never read during the pipeline.
- All agentic phases hardcode their iteration limits (35 / 25 / 15).
- Developers setting `MAX_AGENTIC_ITERATIONS` or `ENABLE_WEB_SEARCH=false` would get no effect.
- **Fix**: Either wire them up or remove them from config and the `.env.example`.

**L2 · No claim count cap — research is fully serial**
- Each claim is researched one at a time with 250ms throttle between requests.
- No limit on how many claims are extracted — a verbose analyst could produce 15–20 claims.
- **Fix**: Cap extracted claims at ~10 (configurable). Consider parallelising up to `webSearch.maxConcurrent` (currently 3).

**L3 · HTML regeneration uses raw `sendMessageStream` — no retry**
- Same as M4 but lower severity (the fallback is "keep original HTML" which is valid).
- **Fix**: Wrap in `streamWithRetry` for consistency.

**L4 · Validation correction prompt omits `researchMarkdown`**
- The initial structurer received `analysisContent + researchMarkdown` as primary sources.
- The correction prompt includes `analysisContent` and source excerpts but not `researchMarkdown`.
- If the validator flags a citation or confidence level that the structurer originally resolved via research, the correction step has less context than the original.
- **Fix**: Include `researchMarkdown` in the correction prompt.

**L5 · New `AgenticValidator` instance per correction cycle — no exploration memory**
- Each correction cycle creates a fresh `AgenticValidator` with empty conversation history.
- `allPreviouslyRaisedIssues` is passed in so the validator skips re-raising known issues, but it has no memory of which documents it already explored — may re-explore the same sections before getting to new ones.
- Low impact for 1–3 cycles; would matter more if `MAX_CORRECTION_CYCLES` were raised.

**L6 · `transformOrganInsightsToBodyTwin` called twice**
- Called at line ~1237 (to save `body-twin.json`) and again at line ~1682 (to inject into HTML).
- Pure computation, no correctness risk — just redundant work.
- **Fix**: Cache the result in a local variable between the two call sites.

**L7 · JSON repair fallback loses root cause**
- When `structured_data.json` fails to parse and the `lastBrace` repair also fails, `structuredDataContent` becomes `'{}'`.
- The subsequent empty-object check aborts the pipeline with "failed to extract any data" — correct outcome but misleading message. The real cause (JSON truncation/formatting) is lost in logs.
- **Fix**: Log the specific parse error and char count before setting the fallback.

**L8 · Research uses a different LLM client pattern than all other phases**
- Phases 2, 4, 5 use `createGoogleGenAI(billingContext)` → billing headers threaded through.
- Phase 3 research uses `this.llmClient.getConfig()` → vendor `Config` object → `geminiClient.generateContent()`. Different code path, billing attribution may not flow correctly.
- **Fix**: Migrate research agent to use `createGoogleGenAI(billingContext)` consistent with other phases, or verify that the vendor config path carries the same billing headers.

---

### Quick Reference

| ID | Phase | Severity | One-liner |
|----|-------|----------|-----------|
| H1 | All | 🔴 High | Shared intermediate paths — concurrent sessions corrupt each other |
| H2 | All | 🔴 High | Missing SKILL.md silently falls back to 1-line generic prompt |
| M1 | Phase 2 | 🟡 Medium | Analysis failure yields `extracted.md` URL instead of error event |
| M2 | Phase 2 | 🟡 Medium | Max-iteration fallback has no required-section check |
| M3 | Phase 3 | 🟡 Medium | Regex claim extraction silently skips if LLM format varies |
| M4 | Phase 7 | 🟡 Medium | Content review has no retry — silently passes on failure |
| M5 | Phase 7 | 🟡 Medium | Content review payload 400–700KB — highest timeout risk |
| M6 | Phase 5 | 🟡 Medium | Validation correction stream has no retry |
| L1 | Config | 🟢 Low | `agenticLoop.maxIterations` + `enableWebSearch` config never used |
| L2 | Phase 3 | 🟢 Low | No claim count cap, serial execution |
| L3 | Phase 9 | 🟢 Low | HTML regeneration has no retry |
| L4 | Phase 5 | 🟢 Low | Correction prompt omits `researchMarkdown` |
| L5 | Phase 5 | 🟢 Low | New validator instance per correction cycle — no exploration memory |
| L6 | Phase 6 | 🟢 Low | `transformOrganInsightsToBodyTwin` called twice |
| L7 | Phase 4 | 🟢 Low | JSON repair fallback loses root cause in error log |
| L8 | Phase 3 | 🟢 Low | Research uses different LLM client pattern — billing attribution gap |

---

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

---

#### 🧹 Track 1: Remove Remaining Truncations (Quick Wins)

All items below are pre-compression workarounds that are now safe to remove. Compression handles history growth.

**Validator tool result caps** (`server/src/services/agentic-validator.service.ts`):
- [x] Line 629: `[...new Set(keyValues)].slice(0, 20)` — unique values list in `summarize_document` tool. ✅
- [x] Line 635: `.slice(0, 5)` — date list in `summarize_document` tool. ✅
- [x] Lines 907, 910: `sourceMatches.slice(0, 5)` / `jsonMatches.slice(0, 5)` — match results in `check_value_in_json` tool. ✅
- [x] Line 919: `.slice(0, 5)` — filtered matches in source search. ✅
- [x] Line 929: `results.slice(0, 10)` — search results in `search_source` tool. ✅
- [x] Line 974: `byYear[y].slice(0, 10)` — events per year in timeline events tool. ✅
- [x] Lines 1067, 1099, 1206 — intentionally kept: `getJsonSectionSummary` is a preview tool by design (helps validator navigate before diving in). These are not data loss. ✅ (kept intentionally)

**Previously completed** (2026-02-19):
- [x] `agentic-medical-analyst.ts` — `search_data` matches per section (was 10) ✅
- [x] `agentic-medical-analyst.ts` — `search_data` total sections (was 15) ✅
- [x] `agentic-medical-analyst.ts` — `extract_timeline_events` events per year (was 20) ✅

---

#### ✅ Track 2: Make Data Structurer Agentic (Phase 5) — COMPLETE (2026-02-19)

**Problem solved**: Phase 5 was a single-shot LLM call that only saw a 50KB lab-dense subset of `extracted.md`. Structurer was blind to older records, narrative sections, and full date ranges.

**What was built**:
- [x] Created `server/src/services/agentic-data-structurer.service.ts` — `StructurerToolExecutor` + `AgenticDataStructurer` ✅
- [x] Tools: `search_source`, `get_value_history`, `get_date_range`, `list_source_documents`, `update_json_section`, `get_json_draft`, `complete_structuring` ✅
- [x] `analysis.md` + `research.json` passed directly in context (primary sources, manageable size) ✅
- [x] Full `extracted.md` accessible via tools — no more 50KB cap ✅
- [x] Added `'structurer'` phase to `chat-compression.service.ts` with dedicated compression prompt ✅
- [x] Replaced single-shot `streamWithRetry` + `extractLabSections(50_000)` call in `agentic-doctor.use-case.ts` with agentic generator loop ✅
- [x] Updated `data-structurer/SKILL.md` with agentic workflow, tool table, source priority ordering ✅
- [x] External state: `currentJson` Map lives outside conversation history — never lost during compression ✅

---

#### 🧠 Track 3: Organ Insights Truncation (3D Body Twin)

**Problem**: The body-twin pipeline has its own data loss points separate from the main medical pipeline.

**In `body-twin-transformer.service.ts`**:
- [ ] Line 414: `o.insights[0] || ''` — only the **first** insight is used as the `implication` for a system finding. If an organ has 3 insights, 2 are dropped. Fix: concatenate all insights or pick the most relevant one.
- [ ] Line 425: `findings.slice(0, 5)` — system findings capped at 5 per body system. If a system has 10 abnormal metrics, 5 are silently dropped. Evaluate: is 5 a UI constraint (too many to show?) or an arbitrary cap? If UI, make it configurable; if arbitrary, remove.
- [ ] Line 468: `o.insights[0] || ''` — same issue: only first insight used for system summary text.

**In `body-twin-viewer.html`**:
- [ ] Lines 1895–1896: `.slice(0, 2)` — connection spotlight shows only 2 insights per organ. This is a UI constraint (limited panel space), but worth revisiting if the panel is expanded. Document as intentional if kept.

**Design question**: The `findings.slice(0, 5)` may be intentional for the 3D viewer panel (too many findings clutters the UI). Decide whether this is a data cap (should show all) or a display cap (show 5 but store all). If display-only, move the cap to the rendering layer and store full findings in `body-twin.json`.

---

#### 🔧 Track 4: Previously Completed Tool Enhancements

- [x] Add `get_date_range()` tool to analyst ✅
- [x] Add `extract_timeline_events()` tool ✅
- [x] Add `list_documents_by_year()` tool ✅
- [x] Add `get_value_history(marker)` tool ✅
- [x] Create `AgenticValidator` service with tool-based access ✅
- [x] Add `compare_date_ranges()` validator tool ✅
- [x] Add `find_missing_timeline_years()` validator tool ✅
- [x] Add `check_value_in_json()` validator tool ✅
- [x] Update medical-analysis SKILL.md with new tools and timeline requirements ✅
- [x] Integrate AgenticValidator into Phase 6 ✅

---

#### 📦 Track 5: Other Pipeline Improvements

- [ ] Add `list_unique_markers()` tool to analyst — show all lab markers found in source
- [ ] Add `find_values_missing_from_json()` validator tool — bidirectional completeness diff
- [ ] Move research phase before/parallel with analysis so claims inform the analysis
- [ ] Make patient question mandatory input
- [ ] Confidence score propagation through pipeline
- [ ] Propagate validation corrections upstream to `analysis.md` and `cross_systems.md`

---

#### 🔒 Track 6: Tool Schema Validation (Correctness Gap)

**Problem**: There is no compile-time or startup-time contract between tool *declarations* (the `ANALYST_TOOLS` / `VALIDATOR_TOOLS` / `STRUCTURER_TOOLS` schema arrays) and their *implementations* (the `switch` dispatch in each `ToolExecutor.execute()`). The two are linked only by string matching — a typo or missing case silently degrades behavior.

**How tools work today**:
- Each service file declares a module-level `const *_TOOLS` array of plain objects (`{ name, description, parameters }`)
- These are passed to every `generateContent()` call via `config: { tools: [{ functionDeclarations: *_TOOLS }] }`
- Gemini reads the schemas and decides what to call based on the SKILL.md system prompt + conversation history
- When Gemini returns `functionCall` parts, the loop dispatches via `toolExecutor.execute(toolName, args)` → `switch(toolName)`
- One iteration can produce **multiple parallel tool calls** (Gemini batches related lookups); dependent calls happen sequentially across iterations

**Current validation gaps**:

| Risk | Current state | Symptom if hit |
|------|--------------|----------------|
| Schema `name` ≠ switch `case` (typo) | Undetected | Returns `"Unknown tool: ..."` — Gemini degrades silently |
| New tool added to schema, forgotten in switch | Undetected | Same as above |
| Tool description wrong → Gemini misuses tool | Undetected | Wrong tool called, wrong data returned |
| `args.marker as string` is actually `undefined` | TypeScript cast hides it | Tool returns empty/wrong result |
| Schema `name` ≠ `case` across phases (copy-paste drift) | Undetected | Silent degradation in that phase only |

**Only current guards**:
1. `default: return \`Unknown tool: ${toolName}\`` — Gemini sees the error and may retry differently
2. Completion gates (`complete_analysis`, `complete_structuring`, `complete_validation`) require required sections to be filled before signalling done — catches behavioral failures but not structural ones
3. Log watching: every tool call is yielded as a `tool_call` event with name + args + result (truncated to 500 chars)

**Recommended fix — Typed Tool Registry**:

Replace the parallel `const TOOLS = [...]` + `switch` pattern with a single registry where schema and implementation are co-located:

```typescript
// Each entry: schema + executor in one place — impossible to declare without implementing
type ToolName = 'list_documents' | 'read_document' | 'search_data' | ...;

const TOOL_REGISTRY: Record<ToolName, {
  schema: { name: ToolName; description: string; parameters: object };
  execute: (executor: AnalystToolExecutor, args: Record<string, unknown>) => string;
}> = {
  'list_documents': {
    schema: { name: 'list_documents', description: '...', parameters: {...} },
    execute: (ex) => ex.listDocuments(),
  },
  'search_data': {
    schema: { name: 'search_data', description: '...', parameters: {...} },
    execute: (ex, args) => ex.searchData(args.query as string),
  },
};

// Derived — no divergence possible:
const ANALYST_TOOLS = Object.values(TOOL_REGISTRY).map(t => t.schema);
// Dispatch:
const handler = TOOL_REGISTRY[toolName as ToolName];
return handler ? handler.execute(executor, args) : `Unknown tool: ${toolName}`;
```

TypeScript will error at compile time if a `ToolName` value has no registry entry.

**Simpler short-term alternative** — startup assertion:

```typescript
function assertToolSchemasCovered(
  tools: Array<{ name: string }>,
  knownCases: string[],
  phase: string,
) {
  const caseSet = new Set(knownCases);
  for (const tool of tools) {
    if (!caseSet.has(tool.name)) {
      throw new Error(`[${phase}] Tool "${tool.name}" declared in schema but missing from switch`);
    }
  }
}
// Called once at module load time, before any pipeline runs
```

**Files to change**:
- `server/src/services/agentic-medical-analyst.service.ts` — `ANALYST_TOOLS` + `AnalystToolExecutor.execute()`
- `server/src/services/agentic-data-structurer.service.ts` — `STRUCTURER_TOOLS` + `StructurerToolExecutor.execute()`
- `server/src/services/agentic-validator.service.ts` — `VALIDATOR_TOOLS` + `ValidatorToolExecutor.execute()`

- [ ] Add startup assertion (`assertToolSchemasCovered`) to each service as a quick safety net
- [ ] Migrate to typed tool registry pattern for compile-time correctness (bigger refactor, do after assertion is in place)

---

#### 🏢 Infrastructure

- [ ] Database instead of file storage
- [ ] User authentication
- [ ] Cloud storage integration (S3/GCS)
- [ ] Realm versioning and history
- [ ] Support for more file types
- [ ] Improved error handling and retries
- [ ] Rate limiting and quota management

## Reference Documentation

- **README.md** - Full setup, pipeline documentation, and architecture details
- **QUICKSTART.md** - 5-minute setup guide

## Key Conventions

1. **TypeScript strict mode** - All code should be properly typed
2. **No any types** - Use proper interfaces/types
3. **Adapter pattern** - All external dependencies go through adapters
4. **Use Cases for business logic** - Keep HTTP handlers thin
5. **Async/await** - Prefer over callbacks and raw Promises
6. **Error handling** - Use try/catch in Use Cases, propagate to HTTP layer
7. **Logging** - Use console.log in development (TODO: proper logger in production)
8. **Agentic tool naming** - When adding a tool to any `*_TOOLS` schema array, you MUST also add a matching `case` to that service's `ToolExecutor.execute()` switch. There is currently no compile-time enforcement — a mismatch silently returns `"Unknown tool: ..."` and degrades the agent. See Track 6 for the planned fix.
9. **No new slice caps** - Do NOT add `.slice(0, N)` to tool result strings. Chat compression handles history growth. If a tool result is genuinely large, trust compression — don't truncate data.

## Need Help?

1. Check this file first
2. Read relevant documentation (README, DESIGN)
3. Look at existing code patterns in similar files
4. Check git history for context on why things are the way they are

---

**💡 Pro Tip**: When you make significant changes, update this file! Future you (and Claude) will thank you.
