export type ThemeId = 'vaporwave' | 'wired' | 'cyberpunk' | 'material';

export type ThemePalette = {
  bg: string;
  panel: string;
  panelDeep: string;
  panelRaised: string;
  panelSelected: string;
  ink: string;
  muted: string;
  pink: string;
  cyan: string;
  violet: string;
  sun: string;
  line: string;
  lineStrong: string;
  green: string;
  danger: string;
  inverseInk: string;
  avatar: string;
  banner: string;
};

export type ThemeDefinition = {
  id: ThemeId;
  name: string;
  description: string;
  mode: 'dark' | 'light';
  palette: ThemePalette;
};

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  vaporwave: {
    id: 'vaporwave', name: 'Vaporwave', description: 'Neon · dreamy · after hours', mode: 'dark',
    palette: {
      bg: '#0c0717', panel: '#171025', panelDeep: '#100a1b', panelRaised: '#211536', panelSelected: '#21132e',
      ink: '#fbf3ff', muted: '#aa9bbf', pink: '#ff4fd8', cyan: '#59f3ff', violet: '#ab7bff', sun: '#ffd36b',
      line: '#34244b', lineStrong: '#604179', green: '#79fbd2', danger: '#ff658b', inverseInk: '#190d24',
      avatar: '#542567', banner: '#2a1d12',
    },
  },
  wired: {
    id: 'wired', name: 'The Wired', description: 'Signal cyan · deep black', mode: 'dark',
    palette: {
      bg: '#03090c', panel: '#09171b', panelDeep: '#050f12', panelRaised: '#0d2329', panelSelected: '#0b2b32',
      ink: '#e7fbff', muted: '#8cabb2', pink: '#4deaff', cyan: '#4deaff', violet: '#7ddbe8', sun: '#b6f8ff',
      line: '#183942', lineStrong: '#267080', green: '#79fbd2', danger: '#ff667d', inverseInk: '#041014',
      avatar: '#12404a', banner: '#14272b',
    },
  },
  cyberpunk: {
    id: 'cyberpunk', name: 'Cyberpunk', description: 'Hard black · electric red', mode: 'dark',
    palette: {
      bg: '#090607', panel: '#171012', panelDeep: '#100a0c', panelRaised: '#271317', panelSelected: '#32121a',
      ink: '#fff2f3', muted: '#b89ca0', pink: '#ff304f', cyan: '#ff5265', violet: '#d34a63', sun: '#ffb454',
      line: '#452129', lineStrong: '#852b3b', green: '#7df2b0', danger: '#ff304f', inverseInk: '#21070b',
      avatar: '#54202b', banner: '#33161a',
    },
  },
  material: {
    id: 'material', name: 'Material', description: 'Google blue · clean surfaces', mode: 'light',
    palette: {
      bg: '#ffffff', panel: '#ffffff', panelDeep: '#f1f3f8', panelRaised: '#eef1f8', panelSelected: '#e8f0fe',
      ink: '#202124', muted: '#5f6368', pink: '#1a73e8', cyan: '#34a853', violet: '#a142f4', sun: '#fbbc04',
      line: '#dadce0', lineStrong: '#aeb8c8', green: '#188038', danger: '#d93025', inverseInk: '#ffffff',
      avatar: '#4285f4', banner: '#fff4e5',
    },
  },
};

let activeThemeId: ThemeId = 'wired';

export function setActiveTheme(id: ThemeId) { activeThemeId = id; }
export function getActiveThemeId() { return activeThemeId; }
export function getActivePalette() { return THEMES[activeThemeId].palette; }

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value);
}
