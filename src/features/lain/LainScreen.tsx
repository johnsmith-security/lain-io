import { themedStyles } from '../../theme/themedStyles';
// Lain tab: the 3D avatar, the on-device model card, and a docked composer.
// While the keyboard is open it switches to a compact split view: transcript | avatar.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useKeyboard } from '../../app/keyboard';
import { useSettings } from '../../db/hooks';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { Eyebrow } from '../../ui/Eyebrow';
import { ScreenScroll } from '../../ui/ScreenScroll';
import { SendButton } from '../../ui/SendButton';
import { ExternalMedia } from '../../ui/media/ExternalMedia';
import { firstExternalMediaUrl } from '../../ui/media/mediaLinks';
import AvatarScene from './AvatarScene';
import { ACTIVE_STATUSES, useLain, type LainStatus } from './LainProvider';
import { LainLog } from './LainLog';

const stageLabel = (s: LainStatus) => (s === 'listening' ? 'LISTENING' : s === 'thinking' ? 'THINKING' : s === 'speaking' ? 'SPEAKING' : 'RENDERING');
const statusLabel = (s: LainStatus) => (s === 'listening' ? 'Listening on device' : s === 'processing' ? 'Transcribing locally…' : s === 'thinking' ? 'Lain is thinking…' : s === 'speaking' ? 'Lain is speaking' : 'READY · ON DEVICE');
const statusColor = (s: LainStatus) => (s === 'listening' ? C.pink : s === 'thinking' ? C.violet : s === 'speaking' ? C.cyan : C.green);

export function LainScreen() {
  const keyboard = useKeyboard();
  const [settings] = useSettings();
  const lain = useLain();
  const [viewportHeight, setViewportHeight] = useState(0);
  const compact = keyboard.visible;
  const visualStyle = settings?.lainStyle ?? 'vaporwave';
  const voiceEffect = settings?.lainVoice ?? 'wired';
  // The voice runs natively; tell it which effect this account chose.
  useEffect(() => { lain.setVoiceEffect(voiceEffect); }, [lain.setVoiceEffect, voiceEffect]);

  return (
    <>
      <ScreenScroll
        contentContainerStyle={[compact && styles.compactContent, compact && viewportHeight > 0 && { height: viewportHeight }]}
        onLayout={(event) => { const height = event.nativeEvent.layout.height; setViewportHeight((current) => (current === height ? current : height)); }}
      >
        <View style={compact ? [styles.compactStage, viewportHeight > 0 ? { height: viewportHeight, flex: 0 } : null] : undefined}>
          <LainLog hidden={!compact} />
          <View style={[styles.frame, compact && styles.compactFrame, visualStyle === 'wired' && styles.wiredFrame]}>
            <View style={styles.meta}><Text style={styles.tag}>3D ARCHIVE</Text><Text style={styles.stageStatus}>● {stageLabel(lain.status)}</Text></View>
            <AvatarScene animationState={lain.status} fill={compact} visualStyle={visualStyle} mouth={lain.mouth} />
            <View style={styles.caption}><Text style={styles.name}>Lain</Text><Text style={styles.hint}>{compact ? 'SWIPE ↔ TO ROTATE' : 'ROTATE · EXPLORE · CONNECT'}</Text></View>
          </View>
        </View>
        <ModelCard hidden={compact} />
      </ScreenScroll>
      <LainComposer compact={compact} />
    </>
  );
}

/** Download / load the model, mic button, and the last few exchanges. */
function ModelCard({ hidden }: { hidden: boolean }) {
  const lain = useLain();
  const { status } = lain;
  const busy = status === 'downloading' || status === 'loading';
  const needsSetup = status !== 'ready' && !ACTIVE_STATUSES.includes(status);
  const setupTitle = status === 'downloading' ? `Downloading model · ${lain.progress}%`
    : status === 'loading' ? 'Loading Gemma into memory…'
    : status === 'downloaded' ? 'Load model into memory'
    : status === 'error' ? (!lain.available ? 'Android development build required' : 'Retry local model setup')
    : 'Download Gemma 4 E2B';
  return (
    <View style={[styles.card, hidden && common.hidden]}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Eyebrow>LOCAL INTELLIGENCE</Eyebrow>
          <Text style={styles.cardTitle}>Talk to Lain</Text>
          <Text style={styles.cardCopy}>Lain is an AI character. {lain.model.name} runs on this device, and your conversation stays here.</Text>
        </View>
        <View style={styles.pulse}><Text style={styles.pulseText}>✳</Text></View>
      </View>
      {needsSetup ? (
        <Pressable onPress={() => void lain.prepare()} disabled={busy} style={styles.prepare}>
          {busy ? <ActivityIndicator color={C.cyan} /> : <Text style={styles.prepareIcon}>↓</Text>}
          <View style={{ flex: 1 }}>
            <Text style={styles.prepareTitle}>{setupTitle}</Text>
            <Text style={styles.prepareDetail}>{status === 'downloading' ? 'About 2.6 GB · downloaded once' : 'Model download once · speech needs offline voices'}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ) : (
        <>
          <View style={styles.status}>
            <View style={[styles.statusDot, { backgroundColor: statusColor(status) }]} />
            <Text style={styles.statusText}>{statusLabel(status)}</Text>
            <Pressable onPress={() => void lain.toggleListening()} accessibilityLabel={status === 'listening' ? 'Stop listening' : status === 'speaking' ? 'Stop Lain speaking' : 'Talk'} style={styles.mic}><Text style={styles.micText}>{status === 'listening' || status === 'speaking' ? '■' : '⌁'}</Text></Pressable>
          </View>
          {lain.voice !== 'ready' && (
            <Pressable onPress={() => void lain.downloadVoice()} disabled={lain.voice === 'downloading'} style={styles.prepare}>
              {lain.voice === 'downloading' ? <ActivityIndicator color={C.pink} /> : <Text style={[styles.prepareIcon, { color: C.pink }]}>◉</Text>}
              <View style={{ flex: 1 }}>
                <Text style={styles.prepareTitle}>{lain.voice === 'downloading' ? `Downloading Lain’s voice · ${lain.voiceProgress}%` : 'Give Lain her voice'}</Text>
                <Text style={styles.prepareDetail}>Neural voice, on device · about 103 MB · downloaded once</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
          {lain.messages.slice(-4).map((message) => (
            <View key={message.id} style={[styles.bubble, message.role === 'you' ? styles.bubbleYou : styles.bubbleLain]}>
              <Text style={styles.bubbleRole}>{message.role === 'you' ? 'YOU' : 'LAIN'}</Text>
              {firstExternalMediaUrl(message.text) ? <View style={styles.linkMedia}><ExternalMedia url={firstExternalMediaUrl(message.text)!} /></View> : null}
              <Text style={styles.bubbleText}>{message.text}</Text>
            </View>
          ))}
        </>
      )}
      {lain.error ? <Text style={styles.error}>{lain.error}</Text> : null}
    </View>
  );
}

function LainComposer({ compact }: { compact: boolean }) {
  const lain = useLain();
  const locked = ['missing', 'downloaded', 'downloading', 'loading'].includes(lain.status);
  const placeholder = !lain.available ? 'Android development build required'
    : lain.status === 'ready' ? 'Message Lain…'
    : ['thinking', 'processing', 'speaking'].includes(lain.status) ? 'Lain is responding…'
    : 'Download Gemma to start chatting';
  return (
    <View style={[common.composerDock, compact && styles.compactDock]}>
      <TextInput ref={lain.composerRef} value={lain.draft} onChangeText={lain.setDraft} placeholder={placeholder} placeholderTextColor={C.muted} multiline blurOnSubmit={false} style={[common.dockInput, { maxHeight: 92 }]} editable={lain.available && !locked} onSubmitEditing={() => void lain.send(lain.draft, true)} />
      <SendButton onPress={() => void lain.send(lain.draft, true)} disabled={!lain.draft.trim() || lain.status !== 'ready'} />
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  compactContent: { flexGrow: 1, paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  compactStage: { flex: 1, height: '100%', maxHeight: '100%', minHeight: 0, flexDirection: 'row', alignItems: 'stretch', overflow: 'hidden' },
  frame: { borderRadius: 18, overflow: 'hidden', backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.lineStrong, shadowColor: C.violet, shadowOpacity: 0.2, shadowRadius: 16 },
  compactFrame: { flex: 1, width: 0, height: '100%', maxHeight: '100%', minHeight: 0, marginBottom: 0, borderRadius: 0, borderWidth: 0 },
  wiredFrame: { backgroundColor: C.panelDeep, borderColor: C.lineStrong },
  meta: { position: 'absolute', zIndex: 2, left: 14, right: 14, top: 14, flexDirection: 'row', justifyContent: 'space-between' },
  tag: { color: C.cyan, fontSize: 8, letterSpacing: 1.4, fontWeight: '700' },
  stageStatus: { color: C.green, fontSize: 8, fontWeight: '700' },
  caption: { position: 'absolute', zIndex: 2, bottom: 12, left: 14, right: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  name: { color: '#fff', fontSize: 20, fontWeight: '700', textShadowColor: C.pink, textShadowRadius: 12 },
  hint: { color: C.violet, fontSize: 7, letterSpacing: 1.2 },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.lineStrong, borderRadius: 17, padding: 15, marginBottom: 13, shadowColor: C.violet, shadowOpacity: 0.12, shadowRadius: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: C.ink, fontSize: 18, fontWeight: '700', marginTop: 6 },
  cardCopy: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 5, maxWidth: 245 },
  pulse: { width: 38, height: 38, borderRadius: 13, backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.lineStrong, alignItems: 'center', justifyContent: 'center' },
  pulseText: { fontSize: 22, color: C.pink },
  prepare: { minHeight: 58, backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.lineStrong, borderRadius: 12, marginTop: 15, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 11 },
  prepareIcon: { color: C.cyan, fontSize: 20, fontWeight: '700' },
  prepareTitle: { color: C.ink, fontSize: 11, fontWeight: '700' },
  prepareDetail: { color: C.muted, fontSize: 8, marginTop: 4 },
  chevron: { color: C.cyan, fontSize: 23 },
  status: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 14, borderTopWidth: 1, borderColor: C.line, paddingTop: 11 },
  statusDot: { width: 7, height: 7, borderRadius: 5 },
  statusText: { color: C.muted, fontSize: 8, fontWeight: '700', letterSpacing: 1, flex: 1 },
  mic: { height: 32, width: 32, borderRadius: 10, backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.pink, alignItems: 'center', justifyContent: 'center' },
  micText: { color: C.pink, fontSize: 21 },
  bubble: { maxWidth: '92%', padding: 11, borderRadius: 12, marginTop: 9 },
  bubbleYou: { alignSelf: 'flex-end', backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.lineStrong },
  bubbleLain: { alignSelf: 'flex-start', backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.lineStrong },
  bubbleRole: { color: C.cyan, fontSize: 7, letterSpacing: 1.2, fontWeight: '800', marginBottom: 5 },
  bubbleText: { color: C.ink, fontSize: 11, lineHeight: 17 },
  linkMedia: { width: '100%', marginTop: 8, borderRadius: 8, overflow: 'hidden' },
  error: { color: C.danger, fontSize: 9, lineHeight: 14, marginTop: 9 },
  compactDock: { marginHorizontal: 8, marginTop: 6, marginBottom: 6, padding: 6 },
}));
