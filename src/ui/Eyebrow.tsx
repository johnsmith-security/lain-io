import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { C } from '../theme/colors';

/** Small uppercase label above a section. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

const styles = themedStyles(() => StyleSheet.create({
  eyebrow: { color: C.violet, fontSize: 9, fontWeight: '700', letterSpacing: 1.8 },
}));
