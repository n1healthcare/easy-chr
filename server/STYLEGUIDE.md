# Easy CHR — Report Styleguide

Reference document for the centralized design system used in generated HTML reports.

**Source of truth:** `server/src/styles/report.css`
**Injection logic:** `server/src/styles/inject-styles.ts`

> To change how reports look, edit `report.css`. This styleguide is documentation only.

---

## How It Works

1. LLM generates HTML with class names (no `<style>` tags)
2. `injectStyles()` strips any LLM-generated `<style>` blocks
3. `report.css` is injected as a `<style>` block before `</head>`
4. CSS is cached in memory after first read

Called from `agentic-doctor.use-case.ts` in Phase 6 (HTML generation) and Phase 8 (regeneration).

---

## Design Tokens

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--accent-primary` | `#0F766E` | Primary teal accent (N1 brand) |
| `--accent-primary-dark` | `#115E59` | Headings, links, hover states |
| `--accent-light` | `#99F6E4` | Borders, subtle accents |
| `--accent-bg` | `#F0FDFA` | Light teal backgrounds |
| `--success` | `#10B981` | Positive findings, with-intervention |
| `--success-bg` | `#D1FAE5` | Success backgrounds |
| `--warning` | `#F59E0B` | Warnings, top priority, data gaps |
| `--warning-bg` | `#FEF3C7` | Warning backgrounds |
| `--danger` | `#EF4444` | Critical findings, without-intervention |
| `--danger-bg` | `#FEE2E2` | Danger backgrounds |
| `--info` | `#3B82F6` | Informational, mild severity |
| `--info-bg` | `#DBEAFE` | Info backgrounds |
| `--text-main` | `#1E293B` | Primary text |
| `--text-muted` | `#64748B` | Secondary/description text |
| `--bg-card` | `#FFFFFF` | Card backgrounds |
| `--bg-section` | `#F8FAFC` | Page/section backgrounds |

**Aliases** (for backward compatibility):
`--primary-color`, `--primary-dark`, `--primary-light`, `--text-primary`, `--text-secondary`, `--critical-color`, `--warning-color`

### Typography

| Element | Font | Weight |
|---------|------|--------|
| Body text | Inter | 400 |
| Headings (h1-h4) | Inter | 700 |
| Bold text | Inter | 600-700 |

Google Fonts loaded via `@import` in the CSS file.

### Spacing & Radius

| Pattern | Value |
|---------|-------|
| Section gap | `48px` (via `--section-gap`) |
| Card padding | `20px` |
| Section border-radius | `10px-12px` |
| Card border-radius | `8px-10px` |
| Small element radius | `4px-6px` |
| Badge radius | `4px` |
| Content max-width | `860px` (via `--content-max-width`) |
| Card gap | `12px-16px` |

### Borders (Document-oriented)

Cards use `border: 1px solid #E2E8F0` instead of shadows. Colored left borders (`border-left: 3-4px solid`) indicate severity or category.

---

## Component Catalog

### Report Header
```html
<div class="report-header">
  <div class="header-brand">
    <svg class="n1-logo">...</svg>
    <h1>N1 Care Report</h1>
  </div>
</div>
```

### Executive Summary
```html
<div class="executive-summary">
  <h2>Executive Summary</h2>
  <div class="question-text">Patient's question here</div>
  <div class="short-answer"><p>...</p></div>
  <div class="key-findings-preview"><ul><li>...</li></ul></div>
  <div class="top-priority"><h3>Top Priority</h3><p>...</p></div>
</div>
```

### Diagnosis Cards
Severity classes: `critical`, `moderate`, `mild`
```html
<div class="diagnoses-grid">
  <div class="diagnosis-card critical">
    <span class="diagnosis-status-badge">Confirmed</span>
    <div class="diagnosis-name">Diagnosis Name</div>
    <div class="diagnosis-evidence"><span class="evidence-item">Lab: value</span></div>
    <div class="diagnosis-implications">Clinical implications...</div>
  </div>
</div>
```

### Plotly Charts
```html
<!-- Gauge grid -->
<div class="gauges-grid">
  <div class="gauge-card">
    <div class="gauge-title">Marker Name</div>
    <div class="plotly-gauge" id="gauge-1"></div>
    <div class="gauge-description">Description</div>
  </div>
</div>

<!-- Line chart / trend -->
<div class="chart-section">
  <div class="plotly-chart" id="chart-1"></div>
  <div class="trend-interpretation">Interpretation text</div>
</div>

<!-- Radar chart -->
<div class="plotly-radar" id="radar-1"></div>
```

### Visual Timeline
Significance classes: `significance-high`, `significance-medium`
Value classes: `critical`, `warning`, `normal`
```html
<div class="timeline-section">
  <div class="visual-timeline">
    <div class="timeline-item significance-high">
      <div class="timeline-date"><span class="month">Jan</span><span class="year">2024</span></div>
      <div class="timeline-marker"></div>
      <div class="timeline-content">
        <div class="timeline-card">
          <h4 class="timeline-title">Event</h4>
          <p class="timeline-description">Details</p>
          <div class="timeline-values">
            <span class="timeline-value critical">TSH: 8.2</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

### Flowchart / Connections
Node types: `root-cause`, `mechanism`, `effect`
Confidence: `high`, `medium`, `low`
```html
<div class="flowchart-section">
  <div class="flowchart">
    <div class="flow-node root-cause">
      <div class="flow-node-label">Root Cause</div>
      <div class="flow-node-value">Name</div>
      <div class="flow-node-data">Supporting data</div>
    </div>
    <div class="flow-arrow">→</div>
    <div class="flow-node effect">...</div>
  </div>
  <span class="confidence-badge high">High Confidence</span>
</div>
```

### Action Plan
Phase types: `immediate`, `short-term`, `follow-up`
```html
<div class="action-plan">
  <div class="action-phase">
    <div class="phase-header immediate">
      <span class="phase-title">Immediate (Week 1-2)</span>
    </div>
    <div class="phase-actions">
      <div class="action-item">
        <div class="action-title">Action</div>
        <div class="action-timing">Timeline</div>
        <div class="action-description">Details</div>
        <div class="action-related">Related to: Diagnosis</div>
        <div class="action-notes">Important notes</div>
      </div>
    </div>
  </div>
</div>
```

### Supplement Schedule
```html
<div class="supplement-schedule">
  <div class="schedule-grid">
    <div class="schedule-time-block">
      <div class="time-label">Morning</div>
      <div class="supplement-card">
        <div class="supplement-name">Supplement</div>
        <div class="supplement-dose">500mg</div>
        <div class="supplement-purpose">Purpose</div>
        <div class="supplement-related">Related to: Finding</div>
        <div class="supplement-notes">Take with food</div>
      </div>
    </div>
  </div>
  <div class="interactions-warning">
    <h4>Interactions</h4>
    <ul><li>Warning text</li></ul>
  </div>
</div>
```

### Lifestyle Optimizations
```html
<div class="lifestyle-section">
  <div class="lifestyle-grid">
    <div class="lifestyle-card"><h4>Category</h4><p>Recommendation</p></div>
  </div>
</div>
```

### Doctor Questions
```html
<div class="doctor-questions">
  <div class="question-card">
    <div class="question-number">1</div>
    <div>
      <span class="question-category">Category</span>
      <div class="question-text">Question?</div>
      <div class="question-context">Why this matters...</div>
      <div class="question-related">Related to: Finding</div>
    </div>
  </div>
</div>
```

### Prognosis
Card types: `without-intervention`, `with-intervention`
```html
<div class="prognosis-section">
  <div class="prognosis-grid">
    <div class="prognosis-card without-intervention">
      <h4>Without Intervention</h4>
      <p>Projection...</p>
    </div>
    <div class="prognosis-card with-intervention">
      <h4>With Intervention</h4>
      <p>Projection...</p>
    </div>
  </div>
  <div class="milestones">
    <div class="milestones-timeline">
      <div class="milestone">
        <div class="milestone-time">2 Weeks</div>
        <div class="milestone-expectation">Expected outcome</div>
      </div>
    </div>
  </div>
</div>
```

### Monitoring Protocol
```html
<div class="monitoring-section">
  <div class="monitoring-grid">
    <div class="monitoring-card"><h4>Test</h4><p>Schedule and rationale</p></div>
  </div>
</div>
```

### Integrative Reasoning (The Big Picture)
```html
<div class="integrative-reasoning-section">
  <!-- Root Cause Hypothesis -->
  <div class="root-cause-card">
    <div class="root-cause-header">
      <span class="root-cause-icon">icon</span>
      <h3>Root Cause</h3>
    </div>
    <div class="root-cause-hypothesis">Hypothesis text</div>
    <div class="root-cause-evidence"><h4>Supporting Evidence</h4><ul><li>...</li></ul></div>
  </div>

  <!-- Causal Chain -->
  <div class="causal-chain">
    <h3>Causal Chain</h3>
    <div class="chain-flow">
      <div class="chain-step">
        <span class="chain-number">1</span>
        <div><div class="chain-event">Event</div><div class="chain-leads-to">Leads to...</div></div>
      </div>
      <span class="chain-arrow">→</span>
    </div>
  </div>

  <!-- Keystone Findings -->
  <div class="keystone-findings">
    <h3>Keystone Findings</h3>
    <p class="keystone-intro">Intro text</p>
    <div class="keystone-grid">
      <div class="keystone-card">
        <span class="keystone-priority">#1 Priority</span>
        <h4>Finding</h4>
        <div class="keystone-why">Why it matters</div>
        <div class="keystone-effects"><span>Effect 1</span><span>Effect 2</span></div>
      </div>
    </div>
  </div>

  <!-- Temporal Narrative -->
  <div class="temporal-narrative">
    <h3>The Story</h3>
    <div class="narrative-text">Narrative paragraph...</div>
  </div>

  <!-- Priority Stack -->
  <div class="priority-stack">
    <h3>Priority Stack</h3>
    <p class="priority-intro">Ordered by clinical impact</p>
    <ol class="priority-list">
      <li><strong>Priority item</strong><span class="priority-rationale">Rationale</span></li>
    </ol>
  </div>
</div>
```

### Positive Findings
```html
<div class="positive-findings">
  <div class="positive-grid">
    <div class="positive-card">
      <div class="positive-icon">icon</div>
      <div>
        <div class="positive-title">Finding</div>
        <div class="positive-description">Details</div>
      </div>
    </div>
  </div>
</div>
```

### Data Gaps
Priority classes: `high`, `medium`, `low`
```html
<div class="data-gaps-section">
  <div class="gaps-grid">
    <div class="gap-card">
      <div class="gap-title">Missing Test</div>
      <div class="gap-reason">Why it matters</div>
      <span class="gap-priority high">High Priority</span>
    </div>
  </div>
</div>
```

### Safety Net
```html
<div class="safety-net-section">
  <div class="safety-net-header">
    <span class="safety-net-icon">icon</span>
    <h2>Safety Net</h2>
  </div>
  <p class="safety-net-note">Disclaimer text</p>
  <div class="safety-net-findings">
    <div class="safety-net-item critical">
      <div class="safety-net-finding">Finding</div>
      <div class="safety-net-recommendation">Action needed</div>
    </div>
  </div>
</div>
```

### References
Source types: `journal`, `institution`, `guideline`, `health-site`
```html
<div class="references-section">
  <p class="references-intro">Intro text</p>
  <div class="reference-list">
    <div class="reference-item">
      <span class="reference-number">1</span>
      <div>
        <div class="reference-title"><a href="url">Title</a></div>
        <div class="reference-claim">Supporting claim</div>
        <span class="source-type-badge journal">Journal</span>
        <span class="confidence-indicator">High</span>
        <div class="reference-snippet">Relevant excerpt...</div>
      </div>
    </div>
  </div>
</div>
```

---

## Utility Classes

| Class | Purpose |
|-------|---------|
| `section-wrapper` | Standard section spacing (`margin-bottom: 48px`) |
| `clay-card` | Generic card with border (legacy name, no longer claymorphism) |
| `blob`, `blob-1`, `blob-2`, `blob-3` | Hidden (kept for HTML compatibility) |

---

## Responsive Behavior

At `max-width: 768px`:
- All grids collapse to single column
- Flowcharts and causal chains stack vertically (arrows rotate 90deg)
- Timeline simplifies (less left padding, inline dates)
- Question cards stack vertically

## Print Styles

- Background set to white
- Major sections use `break-inside: avoid`
