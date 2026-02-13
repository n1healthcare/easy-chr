/**
 * Storage Path Utilities
 *
 * Defines N1 standard path conventions for storage operations.
 * All paths are relative to the storage root (bucket or base directory).
 */

/**
 * 3D organ model constants
 */
export const OrganModel = {
  /** Filename used across pipeline, templates, and storage */
  FILENAME: 'human_organ.glb',
  /** Content type for GLB files */
  CONTENT_TYPE: 'model/gltf-binary',
  /** Placeholder in the HTML template, replaced at injection or deploy time */
  URL_PLACEHOLDER: '__ORGAN_MODEL_URL__',
  /** Resolve the local source path (relative to server cwd) */
  localSourcePath: () =>
    `${process.cwd()}/../client/public/models/human_organ.glb`,
};

/**
 * Session-scoped storage paths for intermediate artifacts
 */
export const SessionPaths = {
  /**
   * Root directory for a session's artifacts
   */
  root: (sessionId: string) => `sessions/${sessionId}`,

  /**
   * Extracted markdown content from all documents
   */
  extracted: (sessionId: string) => `sessions/${sessionId}/extracted.md`,

  /**
   * Medical analysis output (includes cross-system connections)
   */
  analysis: (sessionId: string) => `sessions/${sessionId}/analysis.md`,

  /**
   * Research validation results
   */
  research: (sessionId: string) => `sessions/${sessionId}/research.json`,

  /**
   * Chart-ready structured data (SOURCE OF TRUTH)
   */
  structuredData: (sessionId: string) =>
    `sessions/${sessionId}/structured_data.json`,

  /**
   * Validation report with corrections
   */
  validation: (sessionId: string) => `sessions/${sessionId}/validation.md`,

  /**
   * Organ-by-organ clinical insights (post-validation)
   */
  organInsights: (sessionId: string) =>
    `sessions/${sessionId}/organ_insights.md`,

  /**
   * Pre-computed 3D body twin viewer data
   */
  bodyTwin: (sessionId: string) => `sessions/${sessionId}/body-twin.json`,

  /**
   * 3D organ model (GLB binary)
   */
  organModel: (sessionId: string) => `sessions/${sessionId}/${OrganModel.FILENAME}`,

  /**
   * Content gap analysis results
   */
  contentReview: (sessionId: string) =>
    `sessions/${sessionId}/content_review.json`,

  /**
   * Final generated HTML realm
   */
  realmHtml: (sessionId: string) => `sessions/${sessionId}/realm/index.html`,

  /**
   * Realm directory
   */
  realmDir: (sessionId: string) => `sessions/${sessionId}/realm`,
};

/**
 * Upload storage paths (temporary files)
 */
export const UploadPaths = {
  /**
   * Generate a unique upload path with timestamp
   */
  upload: (filename: string) => `uploads/${Date.now()}-${filename}`,

  /**
   * Input PDF storage (for fetched PDFs)
   */
  input: (filename: string) => `input/${filename}`,

  /**
   * List all uploads for a session
   */
  uploadsDir: () => 'uploads',
};

/**
 * Production output paths (N1 convention)
 */
export const ProductionPaths = {
  /**
   * User CHR report path
   * Pattern: users/{userId}/chr/{chrId}/{filename}
   */
  userChr: (userId: string, chrId: string, filename: string) =>
    `users/${userId}/chr/${chrId}/${filename}`,

  /**
   * User CHR directory
   */
  userChrDir: (userId: string, chrId: string) =>
    `users/${userId}/chr/${chrId}`,

  /**
   * User root directory
   */
  userRoot: (userId: string) => `users/${userId}`,
};

/**
 * Legacy paths for backward compatibility
 * Maps old flat structure to new session-based structure
 */
export const LegacyPaths = {
  extracted: 'extracted.md',
  analysis: 'analysis.md',
  research: 'research.json',
  structuredData: 'structured_data.json',
  validation: 'validation.md',
  organInsights: 'organ_insights.md',
  bodyTwin: 'body-twin.json',
  contentReview: 'content_review.json',
  finalAnalysis: 'final_analysis.md',

  /**
   * Legacy realm path
   */
  realm: (realmId: string) => `realms/${realmId}/index.html`,

  /**
   * Legacy realm directory
   */
  realmDir: (realmId: string) => `realms/${realmId}`,
};

/**
 * Utility functions for path manipulation
 */
export const PathUtils = {
  /**
   * Extract filename from a path
   */
  filename: (path: string) => path.split('/').pop() ?? path,

  /**
   * Extract directory from a path
   */
  dirname: (path: string) => {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  },

  /**
   * Join path segments
   */
  join: (...segments: string[]) =>
    segments.filter(Boolean).join('/').replace(/\/+/g, '/'),

  /**
   * Check if path is for a realm HTML file
   */
  isRealmPath: (path: string) =>
    path.includes('/realm/') || path.includes('/realms/'),

  /**
   * Check if path is for an upload
   */
  isUploadPath: (path: string) =>
    path.startsWith('uploads/') || path.startsWith('input/'),
};
