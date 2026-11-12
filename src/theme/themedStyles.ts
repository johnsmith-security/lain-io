import { getActiveThemeId } from './themes';

/**
 * Defers StyleSheet creation until the current palette is known and caches one
 * sheet per theme. Existing screens can keep their normal StyleSheet API while
 * refreshing their colors when the app theme changes.
 */
export function themedStyles<T extends object>(create: () => T): T {
  let cachedTheme = '';
  let cachedStyles: T | undefined;

  return new Proxy({} as T, {
    get: (_target, key, receiver) => {
      const theme = getActiveThemeId();
      if (!cachedStyles || cachedTheme !== theme) {
        cachedStyles = create();
        cachedTheme = theme;
      }
      return Reflect.get(cachedStyles, key, receiver);
    },
  });
}
