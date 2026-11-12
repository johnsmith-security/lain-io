/** "just now", "5 min ago", "3 h ago", or a date. */
export function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** "14:05" in the device's locale. */
export const clockTime = (at: number = Date.now()): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "0:42" for a duration in seconds. */
export const duration = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** "TUESDAY, NOVEMBER 10" */
export const longDate = (at: number = Date.now()): string =>
  new Date(at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
