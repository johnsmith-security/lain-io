import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from '../../theme/colors';
import { THEMES, type ThemeId } from '../../theme/themes';
import { themedStyles } from '../../theme/themedStyles';
import { Eyebrow } from '../../ui/Eyebrow';

const THEME_ORDER: ThemeId[] = ['wired', 'vaporwave', 'cyberpunk', 'material'];

export function ThemeChoice({ value, onChange }: { value: ThemeId; onChange: (id: ThemeId) => void }) {
  return (
    <>
      <Eyebrow>APP THEME</Eyebrow>
      <Text style={styles.hint}>Choose the color language for your whole space.</Text>
      <View style={styles.grid}>
        {THEME_ORDER.map((id) => {
          const theme = THEMES[id];
          const selected = value === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(id)}
              style={[styles.option, selected && styles.selected]}
            >
              <View style={styles.optionHeader}>
                <Text style={styles.name}>{theme.name}</Text>
                <View style={[styles.radio, selected && styles.radioSelected]}>
                  {selected && <View style={styles.radioDot} />}
                </View>
              </View>
              <View style={styles.swatches}>
                {[theme.palette.bg, theme.palette.panel, theme.palette.cyan, theme.palette.pink].map((color, index) => (
                  <View key={index} style={[styles.swatch, { backgroundColor: color }]} />
                ))}
              </View>
              <Text style={styles.description}>{theme.description}</Text>
              {selected && <Text style={styles.active}>ACTIVE</Text>}
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  hint: { fontSize: 10, color: C.muted, marginTop: 6, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 24 },
  option: { width: '48%', minHeight: 112, padding: 11, borderRadius: 13, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line },
  selected: { borderColor: C.cyan, backgroundColor: C.panelSelected },
  optionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { color: C.ink, fontSize: 11, fontWeight: '700' },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: C.cyan },
  radioDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.cyan },
  swatches: { flexDirection: 'row', gap: 5, marginTop: 11 },
  swatch: { width: 17, height: 17, borderRadius: 6, borderWidth: 1, borderColor: C.lineStrong },
  description: { color: C.muted, fontSize: 7.5, marginTop: 8 },
  active: { color: C.cyan, fontSize: 7, letterSpacing: 1, fontWeight: '800', marginTop: 7 },
}));
