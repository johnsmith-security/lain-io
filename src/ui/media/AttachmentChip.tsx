import { themedStyles } from '../../theme/themedStyles';
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PreparedMedia } from '../../db/native';
import { C } from '../../theme/colors';

/** A picked photo/video waiting to be sent, with a ✕ to remove it. */
export function AttachmentChip({ item, onRemove }: { item: PreparedMedia; onRemove: () => void }) {
  return (
    <View style={styles.chip}>
      <Image source={{ uri: item.kind === 'video' ? (item.thumb ?? item.uri) : item.uri }} resizeMode="cover" style={StyleSheet.absoluteFill} />
      {item.kind === 'video' ? <Text style={styles.video}>▶</Text> : null}
      <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel="Remove attachment" style={styles.remove}><Text style={styles.removeText}>✕</Text></Pressable>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  chip: { width: 58, height: 58, borderRadius: 10, overflow: 'hidden', backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.line },
  video: { position: 'absolute', alignSelf: 'center', top: 16, color: C.ink, fontSize: 18 },
  remove: { position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(12,7,23,.8)', alignItems: 'center', justifyContent: 'center' },
  removeText: { color: C.ink, fontSize: 9 },
}));
