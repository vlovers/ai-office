/** Keyboard navigation moves focus, never changes the active destination. */
export function nextNavigationIndex(key: string, current: number, length: number): number | null {
  if (length <= 0 || current < 0 || current >= length) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % length;
    case 'ArrowLeft':
      return (current - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}
