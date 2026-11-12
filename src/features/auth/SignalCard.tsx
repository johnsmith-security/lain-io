import { themedStyles } from '../../theme/themedStyles';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C } from '../../theme/colors';

const BARS = [20, 36, 28, 48, 30, 42, 18, 34, 50, 27, 39, 22];

/** Decorative "network status" card on the welcome screen. */
export function SignalCard() {
  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <View style={styles.pulse} />
        <Text style={styles.label}>NETWORK STATUS</Text>
        <Text style={styles.live}>● LIVE</Text>
      </View>
      <View style={styles.wave}>
        {BARS.map((height, index) => <View key={index} style={[styles.bar, { height, backgroundColor: index % 3 === 0 ? C.cyan : index % 3 === 1 ? C.pink : C.violet }]} />)}
      </View>
      <Text style={styles.foot}>“No matter where you go, everyone is connected.”</Text>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  card: { borderRadius: 18, backgroundColor: C.panel, borderWidth: 1, borderColor: C.lineStrong, padding: 16, marginTop: 27, marginBottom: 23, shadowColor: C.violet, shadowOpacity: 0.16, shadowRadius: 16 },
  top: { flexDirection: 'row', alignItems: 'center' },
  pulse: { width: 7, height: 7, borderRadius: 5, backgroundColor: C.pink, marginRight: 8, shadowColor: C.pink, shadowOpacity: 1, shadowRadius: 8 },
  label: { color: C.muted, fontSize: 9, letterSpacing: 1.5, fontWeight: '700', flex: 1 },
  live: { color: C.green, fontSize: 9, fontWeight: '700' },
  wave: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 9, paddingHorizontal: 4 },
  bar: { width: 3, borderRadius: 4, backgroundColor: C.pink, opacity: 0.9 },
  foot: { color: C.muted, fontSize: 10, fontStyle: 'italic' },
}));
