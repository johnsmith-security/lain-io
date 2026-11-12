import { themedStyles } from './themedStyles';
// Styles shared by more than one feature. Feature-only styles live next to
// their screen (e.g. src/features/feed/styles.ts).
import { StyleSheet } from 'react-native';
import { C } from './colors';

export const common = themedStyles(() => StyleSheet.create({
  // cards and text
  card: { backgroundColor: C.panel, borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 15, marginBottom: 11 },
  body: { color: C.ink, fontSize: 13, lineHeight: 21, marginTop: 14 },
  emptyText: { color: C.muted, fontSize: 12, textAlign: 'center' },
  liveCount: { fontSize: 9, color: C.green, fontWeight: '600' },
  errorText: { color: C.danger, fontSize: 9, marginTop: 7, marginBottom: 14 },

  // a person in a list (friends, conversations, chat header, settings profile)
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderColor: C.line },
  personAvatar: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  personLetter: { color: '#fff', fontWeight: '800', fontSize: 16 },
  personName: { color: C.ink, fontSize: 12, fontWeight: '700' },
  personDetail: { color: C.muted, fontSize: 9, marginTop: 4 },

  // small avatar (header, composer)
  avatarSmall: { width: 34, height: 34, borderRadius: 12, backgroundColor: C.avatar, borderWidth: 1, borderColor: C.pink, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarSmallText: { color: '#fff', fontWeight: '700' },

  // a composer docked under a screen (Lain chat, direct messages)
  composerDock: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginHorizontal: 14, marginTop: 7, marginBottom: 8, padding: 7, backgroundColor: C.panel, borderWidth: 1, borderColor: C.lineStrong, borderRadius: 16 },
  dockInput: { minHeight: 40, flex: 1, color: C.ink, fontSize: 12, backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8, textAlignVertical: 'top' },

  hidden: { display: 'none' },
}));
