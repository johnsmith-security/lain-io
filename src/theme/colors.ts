import { Platform } from 'react-native';
import { getActivePalette, type ThemePalette } from './themes';

/** Current app palette. Values switch when the selected theme changes. */
export const C: ThemePalette = new Proxy({} as ThemePalette, {
  get: (_target, key: keyof ThemePalette) => getActivePalette()[key],
});

export const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
