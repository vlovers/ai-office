import { expect, it } from 'vitest';
import { assessHandoff } from '../src/server/handoff-assessment.js';

const file = (path: string, status = 'M', availability?: 'text' | 'binary' | 'withheld') => ({
  path,
  status,
  availability,
});

it('accepts a bounded safe change manifest including adds, edits and deletes', () => {
  const result = assessHandoff([
    file('src/main.ts'),
    file('new.txt', '??'),
    file('removed.txt', 'D'),
  ]);
  expect(result).toEqual({
    eligible: true,
    fileCount: 3,
    inspectableFileCount: 3,
    excludedFileCount: 0,
    reasons: [],
  });
});

it('rejects traversal, absolute paths, platform escapes and case collisions', () => {
  const report = assessHandoff([
    file('../escape'),
    file('/tmp/absolute'),
    file('a/../b'),
    file('C:/Windows/secret'),
    file('src\\win.txt'),
    file('Src/INDEX.ts'),
    file('src/index.ts'),
    file('good.ts'),
  ]);
  expect(report.eligible).toBe(false);
  expect(report.reasons).toContain('invalid-path');
  expect(report.reasons).toContain('case-collision');
});

it('fails closed on unsupported changes and unavailable evidence content', () => {
  const report = assessHandoff([
    file('changed.txt', 'R100'),
    file('.env', '??', 'withheld'),
    file('image.png', 'M', 'binary'),
  ]);
  expect(report.eligible).toBe(false);
  expect(report.reasons).toEqual(['unavailable-content', 'unsupported-change']);
  expect(report.excludedFileCount).toBe(3);
});

it('refuses empty or excessive manifests instead of approving ambiguous data', () => {
  expect(assessHandoff([]).reasons).toEqual(['empty-change-set']);
  expect(assessHandoff(Array.from({ length: 501 }, (_, i) => file(`f${i}.txt`))).reasons).toEqual([
    'too-many-files',
  ]);
});
