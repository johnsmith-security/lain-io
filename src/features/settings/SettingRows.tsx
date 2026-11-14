import { themedStyles } from '../../theme/themedStyles';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from '../../theme/colors';

/** A labelled on/off switch. */
export function SettingRow({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Pressable style={rows.row} onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label}>
      <View style={{ flex: 1, paddingRight: 14 }}>
        <Text style={rows.label}>{label}</Text>
        <Text style={rows.detail}>{detail}</Text>
      </View>
      <View style={[rows.toggle, value && rows.toggleOn]}><View style={[rows.knob, value && rows.knobOn]} /></View>
    </Pressable>
  );
}

/** A label with a value on the right. */
export function SettingLink({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  return (
    <Pressable style={rows.row} onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'link' : undefined}>
      <View style={{ flex: 1 }}><Text style={rows.label}>{label}</Text></View>
      <Text style={rows.value}>{value}</Text>
      <Text style={rows.chevron}>›</Text>
    </Pressable>
  );
}

/** Rounded panel that groups rows. */
export function SettingGroup({ children }: { children: React.ReactNode }) {
  return <View style={rows.group}>{children}</View>;
}

export const rows = themedStyles(() => StyleSheet.create({
  group: { backgroundColor: C.panel, borderRadius: 14, borderWidth: 1, borderColor: C.line, marginTop: 11, marginBottom: 23, overflow: 'hidden' },
  row: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: 1, borderColor: C.line },
  label: { fontSize: 11, color: C.ink, fontWeight: '600' },
  detail: { fontSize: 9, color: C.muted, marginTop: 4 },
  value: { fontSize: 9, color: C.muted },
  chevron: { fontSize: 19, color: C.violet, marginLeft: 10 },
  toggle: { width: 36, height: 21, borderRadius: 12, backgroundColor: C.line, justifyContent: 'center', padding: 2 },
  toggleOn: { backgroundColor: C.cyan },
  knob: { width: 17, height: 17, borderRadius: 9, backgroundColor: C.muted },
  knobOn: { alignSelf: 'flex-end', backgroundColor: C.cyan },
}));
