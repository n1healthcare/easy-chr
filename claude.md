# Claude Context: N1 Personal Realm Generator

> **Last Updated**: 2026-02-06
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
| 1 | Document Extraction | `extracted.md` | PDFs → Vision OCR, other files → direct text extraction |
| 2 | Agentic Medical Analysis | `analysis.md` | 25-cycle iterative exploration with tools (list_documents, search_data, update_analysis) |
| 3 | Cross-System Analysis | `cross_systems.md` | Identifies bidirectional relationships between body systems |
| 4 | Research | `research.json` | Claim extraction + web search validation |
| 5 | Data Structuring | `structured_data.json` | **SOURCE OF TRUTH** - 25+ semantic fields for HTML rendering |
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
- `server/src/application/use-cases/agentic-doctor.use-case.ts` - Main orchestrator
- `server/src/services/agentic-medical-analyst.service.ts` - Phase 2 agent with tool executor
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

**1. Payload Size Management**
- `extracted.md` can reach 1.6MB - risks token limit issues
- Raw extraction excluded from Phase 5 to stay under 300KB, meaning Data Structurer sees analyst's interpretation only

**2. Loss of Precision Through Pipeline**
- Each transformation (Raw → Analysis → JSON → HTML) risks information loss
- Validation has caught: RF cited as "40" (2021) instead of current "21-29"; Ceruloplasmin labeled "Low" when borderline
- Analyst summarizes rather than preserving exact values

**3. Research Phase Brittleness**
- Relies on regex parsing for claim extraction (`**Claim**: ... **Search**: ...`)
- If analysis doesn't follow exact format, claims won't be extracted

**4. Timeline Sparseness**
- Despite 18 years of data, timeline arrays often sparse (3 entries from 2024-2025)
- **Root cause**: Analyst is designed for clinical interpretation, not exhaustive extraction:
  - Has 20 cycles to explore 100+ potential sections
  - Prioritizes "significant abnormal values" over historical normal values
  - Timeline built incidentally during analysis, not systematically
  - Skill says "Medical History Timeline - very important!" but completion criteria focuses on "significant abnormal values"
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

**P0: Tool Enhancements** (fixes timeline sparseness):
- [x] Add `get_date_range()` tool to analyst - temporal awareness ✅
- [x] Add `extract_timeline_events()` tool - systematic event extraction ✅
- [x] Add `list_documents_by_year()` tool - temporal distribution ✅
- [x] Add `get_value_history(marker)` tool - track markers across time ✅
- [x] Create `AgenticValidator` service with tool-based access ✅
- [x] Add `compare_date_ranges()` validator tool - bidirectional timeline check ✅
- [x] Add `find_missing_timeline_years()` validator tool ✅
- [x] Add `check_value_in_json()` validator tool ✅
- [x] Update medical-analysis SKILL.md with new tools and timeline requirements ✅
- [x] Update validator SKILL.md for agentic workflow (system prompt enhanced in AgenticValidator) ✅
- [x] Integrate AgenticValidator into agentic-doctor.use-case.ts (Phase 6) ✅

**P1: Coverage Tools**:
- [ ] Add `list_unique_markers()` tool - show all markers found
- [x] Add `check_value_in_json()` validator tool - verify capture ✅ (done in P0)
- [ ] Add `find_values_missing_from_json()` validator tool - bidirectional completeness

**P2: Other Pipeline Improvements**:
- [ ] Move research phase before/parallel with analysis
- [ ] Make patient question mandatory input
- [ ] Confidence score propagation through pipeline
- [ ] Propagate validation corrections to analysis.md and cross_systems.md

**Infrastructure**:
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
