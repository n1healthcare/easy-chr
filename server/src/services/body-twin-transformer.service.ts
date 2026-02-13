/**
 * Body Twin Transformer Service
 *
 * Parses organ_insights.md into BodyTwinData JSON for the 3D body viewer.
 * No external dependencies — pure TypeScript string parsing.
 */

// -- Types (mirror client-side body-twin-schema) --

export interface BodyTwinData {
  meta: MetaInfo;
  systems: BodySystem[];
  organs: OrganState[];
  connections: Connection[];
  annotations: Annotation[];
}

interface MetaInfo {
  generatedAt: string;
  overallHealthScore: number;
  overallStatus: HealthStatus;
  summary: string;
}

interface BodySystem {
  id: string;
  name: string;
  score: number;
  status: HealthStatus;
  organIds: string[];
  summary: string;
  findings: Finding[];
}

interface Finding {
  marker: string;
  value: string;
  status: MetricStatus;
  implication: string;
}

interface OrganState {
  id: string;
  name: string;
  systemId: string;
  meshName: string;
  health: {
    score: number;
    status: HealthStatus;
    color: string;
  };
  metrics: Metric[];
  insights: string[];
  recommendations: string[];
}

interface Metric {
  name: string;
  value: number;
  unit: string;
  referenceRange: { low: number; high: number };
  status: MetricStatus;
}

interface Connection {
  fromOrganId: string;
  toOrganId: string;
  type: 'affects' | 'correlates' | 'causes';
  strength: number;
  description: string;
}

interface Annotation {
  organId: string;
  priority: 'high' | 'medium' | 'low';
  text: string;
  icon?: 'warning' | 'info' | 'success';
}

type HealthStatus = 'optimal' | 'attention' | 'concern' | 'critical';
type MetricStatus = 'low' | 'normal' | 'elevated' | 'high';

// -- Constants --

const STATUS_TO_SCORE: Record<string, number> = {
  critical: 20,
  warning: 50,
  stable: 75,
  optimal: 90,
};

const STATUS_TO_HEALTH: Record<string, HealthStatus> = {
  critical: 'critical',
  warning: 'concern',
  stable: 'attention',
  optimal: 'optimal',
};

const HEALTH_COLORS: Record<HealthStatus, string> = {
  optimal: '#22c55e',
  attention: '#eab308',
  concern: '#f97316',
  critical: '#ef4444',
};

// Canonical organ name → organ ID (IDs match GLB mesh names where a mesh exists)
// Canonical names are enforced by the organ-insights SKILL.md prompt
const CLINICAL_TO_ID: Record<string, string> = {
  Heart: 'Heart',
  Liver: 'Liver',
  Lungs: 'Lungs',
  Stomach: 'Stomach',
  'Large Intestine': 'Large intestine',
  'Small Intestine': 'Small intestine',
  Kidneys: 'Kidney',
  Breast: 'Breast',
  Pancreas: 'Pancreas',
  Spleen: 'Spleen',
  Thyroid: 'Thyroid',
  Adrenals: 'Adrenal Gland',
  'Blood Vessels': 'Heart Arteries',
  Esophagus: 'Esophagus',
  Gallbladder: 'Gallbladder',
  'Bile Duct': 'Bile Duct',
  Bronchioles: 'Bronchioles',
  Larynx: 'Larynx',
  Ovary: 'Ovary',
  Thymus: 'Thymus',
  'Fallopian Tube': 'Fallopian Tube',
  Ureter: 'Ureter',
  Bladder: 'Urinary Blader',
  // Data-only organs
  Brain: 'brain',
  Testes: 'testes',
  'Bone Marrow': 'bone-marrow',
  'Lymph Nodes': 'lymph-nodes',
  Bones: 'bones',
  Joints: 'joints',
  Skin: 'skin',
};

// Canonical organ name → GLB mesh name
const CLINICAL_TO_MESH: Record<string, string> = {
  Heart: 'Heart',
  Liver: 'Liver',
  Lungs: 'Lungs',
  Stomach: 'Stomach',
  'Large Intestine': 'Large intestine',
  'Small Intestine': 'Small intestine',
  Kidneys: 'Kidney',
  Breast: 'Breast',
  Pancreas: 'Pancreas',
  Spleen: 'Spleen',
  Thyroid: 'Thyroid',
  Adrenals: 'Adrenal Gland',
  'Blood Vessels': 'Heart Arteries',
  Esophagus: 'Esophagus',
  Gallbladder: 'Gallbladder',
  'Bile Duct': 'Bile Duct',
  Bronchioles: 'Bronchioles',
  Larynx: 'Larynx',
  Ovary: 'Ovary',
  Thymus: 'Thymus',
  'Fallopian Tube': 'Fallopian Tube',
  Ureter: 'Ureter',
  Bladder: 'Urinary Blader',
};

const CLINICAL_TO_SYSTEM: Record<string, string> = {
  Heart: 'cardiovascular',
  'Blood Vessels': 'cardiovascular',
  Lungs: 'respiratory',
  Bronchioles: 'respiratory',
  Larynx: 'respiratory',
  Esophagus: 'digestive',
  Stomach: 'digestive',
  Liver: 'digestive',
  'Large Intestine': 'digestive',
  'Small Intestine': 'digestive',
  Pancreas: 'digestive',
  Gallbladder: 'digestive',
  'Bile Duct': 'digestive',
  Kidneys: 'urinary',
  Ureter: 'urinary',
  Bladder: 'urinary',
  Brain: 'nervous',
  Thyroid: 'endocrine',
  Adrenals: 'endocrine',
  Spleen: 'immune',
  Thymus: 'immune',
  'Lymph Nodes': 'immune',
  'Bone Marrow': 'immune',
  Bones: 'musculoskeletal',
  Joints: 'musculoskeletal',
  Skin: 'integumentary',
  Breast: 'reproductive',
  Ovary: 'reproductive',
  'Fallopian Tube': 'reproductive',
  Testes: 'reproductive',
};

const ALL_SYSTEMS = [
  { id: 'cardiovascular', name: 'Cardiovascular System' },
  { id: 'respiratory', name: 'Respiratory System' },
  { id: 'digestive', name: 'Digestive System' },
  { id: 'urinary', name: 'Urinary System' },
  { id: 'nervous', name: 'Nervous System' },
  { id: 'endocrine', name: 'Endocrine System' },
  { id: 'immune', name: 'Immune & Lymphatic' },
  { id: 'musculoskeletal', name: 'Musculoskeletal' },
  { id: 'integumentary', name: 'Integumentary' },
  { id: 'reproductive', name: 'Reproductive System' },
];

// -- Parsed intermediate type --

interface ParsedOrgan {
  name: string;
  status: string;
  confidence: string;
  markers: { name: string; value: string; refRange: string; status: string }[];
  findings: string[];
  crossConnections: string[];
  implications: string;
}

// -- Parser --

function parseOrganSections(markdown: string): ParsedOrgan[] {
  const organs: ParsedOrgan[] = [];

  // Split on ## headers (level 2), skip the title (# Organ-by-Organ...)
  const sections = markdown.split(/\n## /).slice(1);

  for (const section of sections) {
    const lines = section.split('\n');
    const name = lines[0].trim().replace(/^\[|\]$/g, '');

    // Skip the Summary section at the end
    if (name === 'Summary') continue;

    const fullText = lines.join('\n');

    // Extract status
    const statusMatch = fullText.match(/\*\*Status:\*\*\s*(.+)/i);
    const status = statusMatch ? statusMatch[1].trim().toLowerCase() : 'stable';

    // Extract confidence
    const confMatch = fullText.match(/\*\*Confidence:\*\*\s*(.+)/i);
    const confidence = confMatch ? confMatch[1].trim().split(/\s/)[0].toLowerCase() : 'medium';

    // Extract markers from table
    const markers: ParsedOrgan['markers'] = [];
    const tableRows = fullText.match(/\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|/g) || [];
    for (const row of tableRows) {
      // Skip header and separator rows
      if (row.includes('Marker') || row.includes('---')) continue;
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 4) {
        markers.push({
          name: cells[0],
          value: cells[1],
          refRange: cells[2],
          status: cells[3],
        });
      }
    }

    // Extract clinical findings (bullet list under ### Clinical Findings)
    const findings = extractBulletList(fullText, 'Clinical Findings');

    // Extract cross-organ connections (bullet list under ### Cross-Organ Connections)
    const crossConnections = extractBulletList(fullText, 'Cross-Organ Connections');

    // Extract clinical implications (paragraph under ### Clinical Implications)
    const implMatch = fullText.match(/###\s*Clinical Implications\s*\n([\s\S]*?)(?=###|$)/i);
    const implications = implMatch ? implMatch[1].trim() : '';

    organs.push({
      name,
      status,
      confidence,
      markers,
      findings,
      crossConnections,
      implications,
    });
  }

  return organs;
}

function extractBulletList(text: string, sectionHeader: string): string[] {
  const regex = new RegExp(
    `###\\s*${sectionHeader}\\s*\\n([\\s\\S]*?)(?=###|$)`,
    'i'
  );
  const match = text.match(regex);
  if (!match) return [];

  return match[1]
    .split('\n')
    .filter((line) => line.trim().startsWith('-') || line.trim().startsWith('*'))
    .map((line) => line.replace(/^[\s]*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function parseMetricValue(valueStr: string): { value: number; unit: string } {
  // Parse strings like "180 mg/dL", "5.7%", "20.08 umol/L"
  const match = valueStr.match(/([\d.]+)\s*(.*)/);
  if (!match) return { value: 0, unit: '' };
  return {
    value: parseFloat(match[1]),
    unit: match[2].trim(),
  };
}

function parseRefRange(rangeStr: string): { low: number; high: number } {
  // Parse strings like "3.5-5.0", "<150", ">60", "150-400 mg/dL"
  const rangeMatch = rangeStr.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
  if (rangeMatch) {
    return { low: parseFloat(rangeMatch[1]), high: parseFloat(rangeMatch[2]) };
  }

  const ltMatch = rangeStr.match(/<\s*([\d.]+)/);
  if (ltMatch) {
    return { low: 0, high: parseFloat(ltMatch[1]) };
  }

  const gtMatch = rangeStr.match(/>\s*([\d.]+)/);
  if (gtMatch) {
    return { low: parseFloat(gtMatch[1]), high: parseFloat(gtMatch[1]) * 2 };
  }

  return { low: 0, high: 100 };
}

function mapMetricStatus(status: string): MetricStatus {
  const s = status.toLowerCase().trim();
  if (s === 'critical' || s === 'high') return 'high';
  if (s === 'low') return 'low';
  if (s === 'elevated' || s === 'borderline') return 'elevated';
  return 'normal';
}

// -- Main transformer --

export function transformOrganInsightsToBodyTwin(
  organInsightsMd: string
): BodyTwinData {
  const parsedOrgans = parseOrganSections(organInsightsMd);

  // Build organs
  const organs: OrganState[] = parsedOrgans.map((parsed) => {
    const id = CLINICAL_TO_ID[parsed.name] || parsed.name.toLowerCase().replace(/\s+/g, '-');
    const meshName = CLINICAL_TO_MESH[parsed.name] || '';
    const systemId = CLINICAL_TO_SYSTEM[parsed.name] || 'other';
    const score = STATUS_TO_SCORE[parsed.status] ?? 60;
    const healthStatus = STATUS_TO_HEALTH[parsed.status] ?? 'attention';
    const color = HEALTH_COLORS[healthStatus];

    const metrics: Metric[] = parsed.markers.map((m) => {
      const { value, unit } = parseMetricValue(m.value);
      const referenceRange = parseRefRange(m.refRange);
      return {
        name: m.name,
        value,
        unit,
        referenceRange,
        status: mapMetricStatus(m.status),
      };
    });

    return {
      id,
      name: parsed.name,
      systemId,
      meshName,
      health: { score, status: healthStatus, color },
      metrics,
      insights: parsed.findings,
      recommendations: parsed.implications
        ? [parsed.implications]
        : [],
    };
  });

  // Build systems (only include systems that have organs)
  const systemOrganMap = new Map<string, string[]>();
  for (const organ of organs) {
    const existing = systemOrganMap.get(organ.systemId) || [];
    existing.push(organ.id);
    systemOrganMap.set(organ.systemId, existing);
  }

  const systems: BodySystem[] = ALL_SYSTEMS
    .filter((s) => systemOrganMap.has(s.id))
    .map((s) => {
      const organIds = systemOrganMap.get(s.id) || [];
      const systemOrgans = organs.filter((o) => organIds.includes(o.id));
      const avgScore = systemOrgans.length > 0
        ? Math.round(systemOrgans.reduce((sum, o) => sum + o.health.score, 0) / systemOrgans.length)
        : 60;
      const status = getHealthStatusFromScore(avgScore);

      // Collect findings from organ metrics
      const findings: Finding[] = systemOrgans.flatMap((o) =>
        o.metrics
          .filter((m) => m.status !== 'normal')
          .map((m) => ({
            marker: m.name,
            value: `${m.value} ${m.unit}`,
            status: m.status,
            implication: o.insights[0] || '',
          }))
      );

      return {
        id: s.id,
        name: s.name,
        score: avgScore,
        status,
        organIds,
        summary: `${organIds.length} organ(s) analyzed`,
        findings: findings.slice(0, 5),
      };
    });

  // Build connections from cross-organ connection text
  const connections: Connection[] = [];
  for (const parsed of parsedOrgans) {
    const fromId = CLINICAL_TO_ID[parsed.name] || parsed.name.toLowerCase().replace(/\s+/g, '-');
    for (const connText of parsed.crossConnections) {
      // Try to find which organ is referenced in the connection text
      for (const otherParsed of parsedOrgans) {
        if (otherParsed.name === parsed.name) continue;
        if (
          connText.toLowerCase().includes(otherParsed.name.toLowerCase()) ||
          connText.toLowerCase().includes(otherParsed.name.toLowerCase().replace(/\s+/g, ' '))
        ) {
          const toId = CLINICAL_TO_ID[otherParsed.name] || otherParsed.name.toLowerCase().replace(/\s+/g, '-');
          // Avoid duplicate connections
          const exists = connections.some(
            (c) =>
              (c.fromOrganId === fromId && c.toOrganId === toId) ||
              (c.fromOrganId === toId && c.toOrganId === fromId)
          );
          if (!exists) {
            connections.push({
              fromOrganId: fromId,
              toOrganId: toId,
              type: 'affects',
              strength: 0.6,
              description: connText,
            });
          }
        }
      }
    }
  }

  // Build annotations from critical organs
  const annotations: Annotation[] = organs
    .filter((o) => o.health.status === 'critical')
    .map((o) => ({
      organId: o.id,
      priority: 'high' as const,
      text: o.insights[0] || `${o.name} requires attention`,
      icon: 'warning' as const,
    }));

  // Compute overall score
  const overallScore = organs.length > 0
    ? Math.round(organs.reduce((sum, o) => sum + o.health.score, 0) / organs.length)
    : 60;

  const meta: MetaInfo = {
    generatedAt: new Date().toISOString(),
    overallHealthScore: overallScore,
    overallStatus: getHealthStatusFromScore(overallScore),
    summary: `Analysis of ${organs.length} organs across ${systems.length} body systems`,
  };

  return { meta, systems, organs, connections, annotations };
}

function getHealthStatusFromScore(score: number): HealthStatus {
  if (score >= 80) return 'optimal';
  if (score >= 60) return 'attention';
  if (score >= 40) return 'concern';
  return 'critical';
}
