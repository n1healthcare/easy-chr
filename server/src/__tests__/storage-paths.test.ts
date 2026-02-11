/**
 * Tests for common/storage-paths.ts
 *
 * Pure string operations — no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  SessionPaths,
  UploadPaths,
  ProductionPaths,
  LegacyPaths,
  PathUtils,
} from '../common/storage-paths.js';

// ============================================================================
// SessionPaths
// ============================================================================

describe('SessionPaths', () => {
  const sid = 'abc-123';

  it('root returns sessions/{sessionId}', () => {
    expect(SessionPaths.root(sid)).toBe('sessions/abc-123');
  });

  it('extracted returns sessions/{sessionId}/extracted.md', () => {
    expect(SessionPaths.extracted(sid)).toBe('sessions/abc-123/extracted.md');
  });

  it('analysis returns correct path', () => {
    expect(SessionPaths.analysis(sid)).toBe('sessions/abc-123/analysis.md');
  });

  it('research returns correct path', () => {
    expect(SessionPaths.research(sid)).toBe('sessions/abc-123/research.json');
  });

  it('structuredData returns correct path', () => {
    expect(SessionPaths.structuredData(sid)).toBe('sessions/abc-123/structured_data.json');
  });

  it('validation returns correct path', () => {
    expect(SessionPaths.validation(sid)).toBe('sessions/abc-123/validation.md');
  });

  it('contentReview returns correct path', () => {
    expect(SessionPaths.contentReview(sid)).toBe('sessions/abc-123/content_review.json');
  });

  it('realmHtml returns correct path', () => {
    expect(SessionPaths.realmHtml(sid)).toBe('sessions/abc-123/realm/index.html');
  });

  it('realmDir returns correct path', () => {
    expect(SessionPaths.realmDir(sid)).toBe('sessions/abc-123/realm');
  });
});

// ============================================================================
// UploadPaths
// ============================================================================

describe('UploadPaths', () => {
  it('upload generates a timestamped path', () => {
    const result = UploadPaths.upload('report.pdf');
    expect(result).toMatch(/^uploads\/\d+-report\.pdf$/);
  });

  it('input generates input/{filename}', () => {
    expect(UploadPaths.input('lab.pdf')).toBe('input/lab.pdf');
  });

  it('uploadsDir returns uploads', () => {
    expect(UploadPaths.uploadsDir()).toBe('uploads');
  });
});

// ============================================================================
// ProductionPaths
// ============================================================================

describe('ProductionPaths', () => {
  it('userChr returns correct nested path', () => {
    expect(ProductionPaths.userChr('u1', 'chr1', 'report.html')).toBe(
      'users/u1/chr/chr1/report.html',
    );
  });

  it('userChrDir returns correct directory', () => {
    expect(ProductionPaths.userChrDir('u1', 'chr1')).toBe('users/u1/chr/chr1');
  });

  it('userRoot returns correct user root', () => {
    expect(ProductionPaths.userRoot('u1')).toBe('users/u1');
  });
});

// ============================================================================
// LegacyPaths
// ============================================================================

describe('LegacyPaths', () => {
  it('has correct static paths', () => {
    expect(LegacyPaths.extracted).toBe('extracted.md');
    expect(LegacyPaths.analysis).toBe('analysis.md');
    expect(LegacyPaths.research).toBe('research.json');
    expect(LegacyPaths.structuredData).toBe('structured_data.json');
    expect(LegacyPaths.validation).toBe('validation.md');
    expect(LegacyPaths.contentReview).toBe('content_review.json');
    expect(LegacyPaths.finalAnalysis).toBe('final_analysis.md');
  });

  it('realm generates correct realm path', () => {
    expect(LegacyPaths.realm('xyz')).toBe('realms/xyz/index.html');
  });

  it('realmDir generates correct directory', () => {
    expect(LegacyPaths.realmDir('xyz')).toBe('realms/xyz');
  });
});

// ============================================================================
// PathUtils
// ============================================================================

describe('PathUtils', () => {
  describe('filename', () => {
    it('extracts filename from path', () => {
      expect(PathUtils.filename('sessions/abc/extracted.md')).toBe('extracted.md');
    });

    it('returns the input when no slashes', () => {
      expect(PathUtils.filename('file.txt')).toBe('file.txt');
    });

    it('handles trailing slash gracefully', () => {
      // split('/').pop() returns '' for trailing slash
      expect(PathUtils.filename('some/path/')).toBe('');
    });
  });

  describe('dirname', () => {
    it('extracts directory from path', () => {
      expect(PathUtils.dirname('sessions/abc/extracted.md')).toBe('sessions/abc');
    });

    it('returns empty string for bare filename', () => {
      expect(PathUtils.dirname('file.txt')).toBe('');
    });
  });

  describe('join', () => {
    it('joins segments with /', () => {
      expect(PathUtils.join('sessions', 'abc', 'file.md')).toBe('sessions/abc/file.md');
    });

    it('collapses multiple slashes', () => {
      expect(PathUtils.join('sessions/', '/abc/', '/file.md')).toBe('sessions/abc/file.md');
    });

    it('filters out empty segments', () => {
      expect(PathUtils.join('a', '', 'b')).toBe('a/b');
    });
  });

  describe('isRealmPath', () => {
    it('detects session realm path', () => {
      expect(PathUtils.isRealmPath('sessions/abc/realm/index.html')).toBe(true);
    });

    it('detects legacy realms path', () => {
      expect(PathUtils.isRealmPath('/realms/xyz/index.html')).toBe(true);
    });

    it('returns false for non-realm paths', () => {
      expect(PathUtils.isRealmPath('sessions/abc/analysis.md')).toBe(false);
    });
  });

  describe('isUploadPath', () => {
    it('detects uploads path', () => {
      expect(PathUtils.isUploadPath('uploads/12345-file.pdf')).toBe(true);
    });

    it('detects input path', () => {
      expect(PathUtils.isUploadPath('input/lab.pdf')).toBe(true);
    });

    it('returns false for non-upload paths', () => {
      expect(PathUtils.isUploadPath('sessions/abc/file.md')).toBe(false);
    });
  });
});
