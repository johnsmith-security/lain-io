import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { C } from '../theme/colors';

/** The round ↑ button of a docked composer. */
export function SendButton({ onPress, disabled, busy = false }: { onPress: () => void; disabled: boolean; busy?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel="Send" style={[styles.send, disabled && styles.disabled]}>
      <Text style={styles.text}>{busy ? '…' : '↑'}</Text>
    </Pressable>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  send: { height: 40, width: 40, borderRadius: 11, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  text: { fontSize: 21, color: C.inverseInk, fontWeight: '800' },
}));
