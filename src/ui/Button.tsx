import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { C } from '../theme/colors';

type Props = { title: string; onPress: () => void; secondary?: boolean; busy?: boolean };

export function Button({ title, onPress, secondary = false, busy = false }: Props) {
  return (
    <Pressable onPress={onPress} disabled={busy} style={[styles.button, secondary && styles.secondary, busy && { opacity: 0.6 }]}>
      {busy
        ? <ActivityIndicator color={secondary ? C.ink : C.inverseInk} />
        : <Text style={[styles.text, secondary && styles.textSecondary]}>{title}</Text>}
    </Pressable>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  button: { height: 52, borderRadius: 13, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center', marginBottom: 10, shadowColor: C.pink, shadowOpacity: 0.25, shadowRadius: 12 },
  secondary: { backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.lineStrong },
  text: { fontSize: 14, fontWeight: '700', color: C.inverseInk },
  textSecondary: { color: C.ink },
}));
