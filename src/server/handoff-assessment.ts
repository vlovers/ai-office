import type { ReviewFile } from '../shared/types.js';

export type HandoffReason =
  | 'invalid-path'
  | 'case-collision'
  | 'unsupported-change'
  | 'unavailable-content'
  | 'empty-change-set'
  | 'too-many-files';

export interface HandoffAssessment {
  eligible: boolean;
  fileCount: number;
  inspectableFileCount: number;
  excludedFileCount: number;
  reasons: HandoffReason[];
}

/**
 * Preflight only. This is not a snapshot, not an authorization, and must not
 * be reused in place of a lease-held, identity-verified file copy.
 */
export function assessHandoff(files: readonly ReviewFile[]): HandoffAssessment {
  const reasons = new Set<HandoffReason>();
  const seen = new Set<string>();
  let inspected = 0;
  if (files.length === 0) reasons.add('empty-change-set');
  if (files.length > 500) reasons.add('too-many-files');
  for (const file of files) {
    const path = file.path;
    const parts = path.split('/');
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      /^[a-z]:/i.test(path)
    ) {
      reasons.add('invalid-path');
      continue;
    }
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) reasons.add('case-collision');
    seen.add(key);
    if (!/^(A|M|D|\?\?)$/.test(file.status)) {
      reasons.add('unsupported-change');
      continue;
    }
    if (file.availability && file.availability !== 'text') {
      reasons.add('unavailable-content');
      continue;
    }
    inspected++;
  }
  return {
    eligible: reasons.size === 0,
    fileCount: files.length,
    inspectableFileCount: inspected,
    excludedFileCount: files.length - inspected,
    reasons: [...reasons].sort(),
  };
}
