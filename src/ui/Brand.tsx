import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C } from '../theme/colors';

export function Brand() {
  return (
    <View style={styles.brand}>
      <View style={styles.mark}><Text style={styles.glyph}>L</Text></View>
      <View>
        <Text style={styles.name}>LAIN <Text style={{ color: C.cyan }}>IO</Text></Text>
        <Text style={styles.sub}>LAIN INPUT / OUTPUT</Text>
      </View>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  mark: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center', shadowColor: C.pink, shadowOpacity: 0.5, shadowRadius: 14 },
  glyph: { fontSize: 23, fontWeight: '800', color: '#fff' },
  name: { color: C.ink, fontSize: 15, fontWeight: '800', letterSpacing: 2.1 },
  sub: { color: C.muted, fontSize: 8, letterSpacing: 1.7, marginTop: 3 },
}));
