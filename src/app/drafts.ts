// Unsent text that should survive switching tabs (the screen unmounts).
// In memory only; cleared on sign-out.
import { useCallback, useState } from 'react';

const drafts = new Map<string, unknown>();

export function useDraft<T>(key: string, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (drafts.has(key) ? (drafts.get(key) as T) : initial));
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(previous) : next;
      drafts.set(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, set];
}

export const clearDrafts = () => drafts.clear();
