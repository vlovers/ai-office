export interface DiffLine {
  text: string;
  kind: 'meta' | 'hunk' | 'add' | 'delete' | 'context';
  old?: number;
  new?: number;
}
// Parse only unified hunk content. Headers/filenames can contain arbitrary text.
export function diffLines(patch: string): DiffLine[] {
  let old = 0,
    next = 0,
    oldLeft = 0,
    newLeft = 0;
  return patch.split('\n').map((text): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1);
      newLeft = Number(hunk[4] ?? 1);
      return { text, kind: 'hunk' };
    }
    if (text.startsWith('+') && newLeft > 0) {
      newLeft--;
      return { text, kind: 'add', new: next++ };
    }
    if (text.startsWith('-') && oldLeft > 0) {
      oldLeft--;
      return { text, kind: 'delete', old: old++ };
    }
    if (text.startsWith(' ') && oldLeft > 0 && newLeft > 0) {
      oldLeft--;
      newLeft--;
      return { text, kind: 'context', old: old++, new: next++ };
    }
    return { text, kind: 'meta' };
  });
}
