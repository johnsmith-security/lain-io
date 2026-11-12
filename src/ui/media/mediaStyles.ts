import { themedStyles } from '../../theme/themedStyles';
// Tiles and grids for photos and videos, shared by posts and direct messages.
import { StyleSheet } from 'react-native';
import { C } from '../../theme/colors';

/** Aspect ratio for a single tile, clamped so very tall or wide images stay readable. */
export const tileRatio = (m: { width?: number; height?: number }) =>
  m.width && m.height ? Math.min(Math.max(m.width / m.height, 0.6), 1.9) : 1.33;

export const mediaStyles = themedStyles(() => StyleSheet.create({
  grid: { marginTop: 12, borderRadius: 12, overflow: 'hidden' },
  gridMulti: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 6, borderRadius: 0 },
  tile: { borderRadius: 12, overflow: 'hidden', backgroundColor: C.panelRaised },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(12,7,23,.35)' },
  overlayTitle: { color: C.ink, fontSize: 10, letterSpacing: 2, fontWeight: '800' },
  overlayText: { color: C.muted, fontSize: 10, marginTop: 4 },
  playGlyph: { color: C.ink, fontSize: 30 },
}));
