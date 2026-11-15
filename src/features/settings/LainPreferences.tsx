import { themedStyles } from '../../theme/themedStyles';
// Settings sections for Lain: which model, and how she looks.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from '../../theme/colors';
import { Eyebrow } from '../../ui/Eyebrow';

import { MODELS as MODEL_REGISTRY, isInstalled, resolveModel, type LainModelId } from '../../../modules/lain-ai/src';

export type ModelId = LainModelId;
export type LainLook = 'vaporwave' | 'wired';
export type LainVoiceEffect = 'wired' | 'clean';

const MODELS = Object.values(MODEL_REGISTRY);
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

const VOICES = [
  { id: 'wired', icon: '◉', name: 'Through the Wired', sub: 'LINE · ROOM · STATIC' },
  { id: 'clean', icon: '○', name: 'Clean', sub: 'JUST HER VOICE' },
] as const;

const LOOKS = [
  { id: 'vaporwave', icon: '🌆', name: 'Vaporwave', sub: 'NEON · DREAMLIKE' },
  { id: 'wired', icon: '◈', name: 'The Wired', sub: 'COOL · MINIMAL' },
] as const;

export function ModelChoice({ value, onChange }: { value: ModelId; onChange: (value: ModelId) => void }) {
  return (
    <>
      <Eyebrow>LAIN'S MIND</Eyebrow>
      <Text style={styles.hint}>Choose the model profile for your Lain.</Text>
      <View style={styles.models}>
        {MODELS.map((model) => {
          const selected = resolveModel(value, isInstalled).id === model.id;
          const usable = model.available || isInstalled(model);
          return (
            <Pressable key={model.id} accessibilityRole="radio" accessibilityState={{ selected, disabled: !usable }} disabled={!usable} onPress={() => onChange(model.id)} style={[styles.model, selected && styles.modelSelected, !usable && styles.modelUnavailable]}>
              <View style={styles.modelTop}>
                <Text style={styles.modelName}>{model.name}</Text>
                <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioInner} />}</View>
              </View>
              <Text style={styles.modelTag}>{model.available ? `${model.tag} · ${gb(model.bytes)}` : usable ? `${model.tag} · TEST BUILD` : 'COMING SOON'}</Text>
              <Text style={styles.modelDetail}>{model.detail}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.note}>
        <Text style={styles.noteGlyph}>✳</Text>
        <Text style={styles.noteText}>Lain is an AI character. Each model is downloaded once and runs only on this device.</Text>
      </View>
    </>
  );
}

export function LookChoice({ value, onChange }: { value: LainLook; onChange: (value: LainLook) => void }) {
  return (
    <>
      <Eyebrow>LAIN'S APPEARANCE</Eyebrow>
      <Text style={styles.hint}>Choose how Lain looks in your space.</Text>
      <View style={styles.looks}>
        {LOOKS.map((look) => {
          const selected = value === look.id;
          return (
            <Pressable key={look.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => onChange(look.id)} style={[styles.look, selected && styles.lookSelected]}>
              <Text style={styles.lookIcon}>{look.icon}</Text>
              <Text style={styles.lookName}>{look.name}</Text>
              <Text style={styles.lookSub}>{look.sub}</Text>
              {selected && <Text style={styles.lookActive}>ACTIVE</Text>}
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

export function VoiceChoice({ value, onChange }: { value: LainVoiceEffect; onChange: (value: LainVoiceEffect) => void }) {
  return (
    <>
      <Eyebrow>LAIN'S VOICE</Eyebrow>
      <Text style={styles.hint}>How Lain sounds when she speaks. Her voice is generated on this device.</Text>
      <View style={styles.looks}>
        {VOICES.map((voice) => {
          const selected = value === voice.id;
          return (
            <Pressable key={voice.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => onChange(voice.id)} style={[styles.look, selected && styles.lookSelected]}>
              <Text style={styles.lookIcon}>{voice.icon}</Text>
              <Text style={styles.lookName}>{voice.name}</Text>
              <Text style={styles.lookSub}>{voice.sub}</Text>
              {selected && <Text style={styles.lookActive}>ACTIVE</Text>}
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  hint: { fontSize: 10, color: C.muted, marginTop: 6, marginBottom: 10 },
  models: { gap: 9, marginBottom: 14 },
  model: { padding: 13, borderRadius: 13, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line },
  modelUnavailable: { opacity: 0.5 },
  modelSelected: { borderColor: C.pink, backgroundColor: C.panelSelected },
  modelTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modelName: { fontSize: 13, color: C.ink, fontWeight: '700' },
  modelTag: { fontSize: 7, color: C.cyan, letterSpacing: 1.3, fontWeight: '800', marginTop: 5 },
  modelDetail: { fontSize: 9, lineHeight: 14, color: C.muted, marginTop: 6, paddingRight: 20 },
  radio: { height: 18, width: 18, borderRadius: 9, borderWidth: 1.5, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: C.pink },
  radioInner: { height: 8, width: 8, borderRadius: 4, backgroundColor: C.pink },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, marginBottom: 24, borderRadius: 12, backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.lineStrong },
  noteGlyph: { fontSize: 15, color: C.cyan },
  noteText: { flex: 1, fontSize: 9, lineHeight: 14, color: C.muted },
  looks: { flexDirection: 'row', gap: 9, marginBottom: 25 },
  look: { flex: 1, minHeight: 104, padding: 11, borderRadius: 13, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line },
  lookSelected: { borderColor: C.cyan, backgroundColor: C.panelSelected },
  lookIcon: { fontSize: 19, marginBottom: 7, color: C.violet },
  lookName: { fontSize: 11, color: C.ink, fontWeight: '700' },
  lookSub: { fontSize: 6.5, color: C.muted, letterSpacing: 0.8, marginTop: 4 },
  lookActive: { fontSize: 7, color: C.cyan, fontWeight: '800', letterSpacing: 1, marginTop: 8 },
}));
