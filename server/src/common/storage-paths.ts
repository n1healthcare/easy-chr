/**
 * Storage Path Utilities
 *
 * Defines N1 standard path conventions for storage operations.
 * All paths are relative to the storage root (bucket or base directory).
 */

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
   * Medical analysis output
   */
  analysis: (sessionId: string) => `sessions/${sessionId}/analysis.md`,

  /**
   * Cross-system analysis
   */
  crossSystems: (sessionId: string) => `sessions/${sessionId}/cross_systems.md`,

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
  crossSystems: 'cross_systems.md',
  research: 'research.json',
  structuredData: 'structured_data.json',
  validation: 'validation.md',
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
