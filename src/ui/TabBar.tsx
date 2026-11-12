import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Page } from '../app/navigation';
import { C } from '../theme/colors';

const TABS: Array<{ id: Page; icon: string; label: string }> = [
  { id: 'home', icon: '📰', label: 'Feed' },
  { id: 'lain', icon: '🌀', label: 'Lain' },
  { id: 'friends', icon: '👥', label: 'Friends' },
  { id: 'settings', icon: '⚙️', label: 'Settings' },
];

/** Bottom tabs. `badges` shows a count on a tab (unread messages on Friends). */
export function TabBar({ page, onSelect, badges = {}, hidden = false }: { page: Page; onSelect: (page: Page) => void; badges?: Partial<Record<Page, number>>; hidden?: boolean }) {
  return (
    <View style={[styles.bar, hidden && styles.hidden]}>
      {TABS.map((tab) => {
        const active = page === tab.id;
        const badge = badges[tab.id] ?? 0;
        return (
          <Pressable key={tab.id} onPress={() => onSelect(tab.id)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={badge ? `${tab.label}, ${badge} unread` : tab.label}>
            <View>
              <Text style={[styles.icon, active && styles.iconActive]}>{tab.icon}</Text>
              {badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text></View> : null}
            </View>
            <Text style={[styles.label, active && styles.labelActive]}>{tab.label}</Text>
            {active ? <View style={styles.indicator} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  bar: { height: 66, marginBottom: 40, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.panelDeep, flexDirection: 'row', paddingBottom: 4 },
  hidden: { display: 'none' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, position: 'relative' },
  icon: { fontSize: 20, color: C.muted },
  iconActive: { color: C.cyan, textShadowColor: C.cyan, textShadowRadius: 10 },
  label: { fontSize: 8, color: C.muted },
  labelActive: { color: C.ink },
  indicator: { position: 'absolute', top: 0, width: 22, height: 2, borderRadius: 2, backgroundColor: C.pink, shadowColor: C.pink, shadowOpacity: 0.9, shadowRadius: 7 },
  badge: { position: 'absolute', top: -4, right: -12, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.panelDeep },
  badgeText: { color: C.inverseInk, fontSize: 10, fontWeight: '900' },
}));
