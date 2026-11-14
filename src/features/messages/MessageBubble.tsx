import { themedStyles } from '../../theme/themedStyles';
// One message: attachments, text, and time + delivery ticks (✓ sent, ✓✓ delivered, ✓✓ READ).
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage } from '../../db/native';
import { clockTime } from '../../lib/time';
import { C } from '../../theme/colors';
import { ExternalMedia } from '../../ui/media/ExternalMedia';
import { firstExternalMediaUrl } from '../../ui/media/mediaLinks';
import { mediaStyles as m, tileRatio } from '../../ui/media/mediaStyles';
import { DmMediaTile } from './DmMediaTile';

export function statusLabel(message: ChatMessage): string {
  const time = clockTime(message.sentAt);
  switch (message.status) {
    case 'failed': return 'NOT DELIVERED · TAP TO RETRY';
    case 'sending': return 'SENDING…';
    case 'sent': return `${time}  ✓`;
    case 'delivered': return `${time}  ✓✓`;
    case 'read': return `${time}  ✓✓ READ`;
    default: return time;
  }
}

export function MessageBubble({ message, mine, onPress }: { message: ChatMessage; mine: boolean; onPress: () => void }) {
  const media = message.media;
  const external = firstExternalMediaUrl(message.text);
  // Media lives *beside* the tappable parts, never inside them: a Pressable around a WebView or a
  // native video player takes the touch, so the player never gets it (tapping a YouTube embed
  // opened the message options instead of playing). Text and time open the options.
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs, media && styles.withMedia]}>
      {message.deleted ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Message options"><Text style={styles.deleted}>Message deleted</Text></Pressable>
      ) : (
        <>
          {media ? (
            <View style={[m.grid, media.length > 1 && m.gridMulti, { marginTop: 0, marginBottom: message.text ? 8 : 4 }]}>
              {media.map((item) => <DmMediaTile key={item.sha} media={item} style={media.length > 1 ? { width: '49%', aspectRatio: 1 } : { width: '100%', aspectRatio: tileRatio(item) }} />)}
            </View>
          ) : null}
          {external ? <View style={styles.external}><ExternalMedia url={external} /></View> : null}
        </>
      )}
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Message options" hitSlop={{ top: 6, bottom: 8 }}>
        {!message.deleted && message.text ? <Text style={styles.text}>{message.text}</Text> : null}
        <Text style={[styles.meta, message.status === 'failed' && styles.failed, message.status === 'read' && { color: C.cyan }]}>{statusLabel(message)}</Text>
      </Pressable>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  bubble: { maxWidth: '86%', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, marginTop: 9, borderWidth: 1 },
  mine: { alignSelf: 'flex-end', backgroundColor: C.panelRaised, borderColor: C.lineStrong, borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: C.panelDeep, borderColor: C.lineStrong, borderBottomLeftRadius: 4 },
  withMedia: { width: '78%' },
  text: { color: C.ink, fontSize: 12, lineHeight: 18 },
  external: { borderRadius: 9, overflow: 'hidden', marginBottom: 7, width: '100%' },
  deleted: { color: C.muted, fontStyle: 'italic', fontSize: 14 },
  meta: { fontSize: 7, color: C.muted, alignSelf: 'flex-end', marginTop: 5, letterSpacing: 0.4 },
  failed: { color: C.danger },
}));
