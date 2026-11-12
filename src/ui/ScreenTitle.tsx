import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C } from '../theme/colors';
import { Eyebrow } from './Eyebrow';

/** The eyebrow + big title + subtitle block at the top of a tab. */
export function ScreenTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: React.ReactNode; subtitle: string }) {
  return (
    <View style={styles.block}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  block: { marginBottom: 20 },
  title: { color: C.ink, fontSize: 31, fontWeight: '700', letterSpacing: -0.8, marginTop: 8 },
  subtitle: { color: C.muted, fontSize: 12, marginTop: 5 },
}));
