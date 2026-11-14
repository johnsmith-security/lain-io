// Inline "why are you reporting this?" chooser (no extra screen; Android alerts allow only 3 buttons).
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Report } from '../db/native';
import { C } from '../theme/colors';
import { themedStyles } from '../theme/themedStyles';

export const REPORT_REASONS: Array<{ id: Report['reason']; label: string }> = [
  { id: 'minor-safety', label: 'Child safety' },
  { id: 'harassment', label: 'Harassment' },
  { id: 'hate', label: 'Hate' },
  { id: 'violence', label: 'Violence or threats' },
  { id: 'sexual', label: 'Sexual content' },
  { id: 'self-harm', label: 'Self-harm' },
  { id: 'illegal', label: 'Illegal' },
  { id: 'spam', label: 'Spam or scam' },
  { id: 'other', label: 'Something else' },
];

export function ReportPanel({ title, onPick, onCancel, busy }: { title: string; onPick: (reason: Report['reason']) => void; onCancel: () => void; busy?: boolean }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.chips}>
        {REPORT_REASONS.map((r) => (
          <Pressable key={r.id} style={[styles.chip, r.id === 'minor-safety' && styles.urgent]} disabled={busy} onPress={() => onPick(r.id)} accessibilityRole="button">
            <Text style={styles.chipText}>{r.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={onCancel} style={styles.cancel}><Text style={styles.cancelText}>{busy ? 'Sending…' : 'Cancel'}</Text></Pressable>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  panel: { marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.panelDeep },
  title: { color: C.ink, fontSize: 11, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.panel },
  urgent: { borderColor: C.danger },
  chipText: { color: C.ink, fontSize: 10 },
  cancel: { alignSelf: 'flex-end', marginTop: 8, padding: 4 },
  cancelText: { color: C.muted, fontSize: 10 },
}));
