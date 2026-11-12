import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { StatusBar, View } from 'react-native';
import { useSettings } from '../db/hooks';
import { isThemeId, setActiveTheme, THEMES, type ThemeDefinition, type ThemeId } from './themes';

type ThemeContextValue = {
  id: ThemeId;
  theme: ThemeDefinition;
  chooseTheme: (id: ThemeId) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [settings, updateSettings] = useSettings();
  const storedTheme = settings?.appTheme;
  const id: ThemeId = isThemeId(storedTheme) ? storedTheme : 'wired';
  const theme = THEMES[id];
  setActiveTheme(id);

  const chooseTheme = useCallback((nextId: ThemeId) => {
    setActiveTheme(nextId);
    return updateSettings({ appTheme: nextId }).then(() => undefined);
  }, [updateSettings]);
  const value = useMemo(() => ({ id, theme, chooseTheme }), [id, theme, chooseTheme]);

  return (
    <ThemeContext.Provider value={value}>
      <View style={{ flex: 1, backgroundColor: theme.palette.bg }}>
        <StatusBar barStyle={theme.mode === 'light' ? 'dark-content' : 'light-content'} />
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside ThemeProvider.');
  return value;
}
