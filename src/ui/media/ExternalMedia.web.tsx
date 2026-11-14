import React, { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from '../../theme/colors';
import { InlineVideo } from './InlineVideo';
import { externalMediaUrl } from './mediaLinks';

/** Browser equivalent: direct media plays inline; provider embeds open their trusted source. */
export function ExternalMedia({ url, thumbnail }: { url: string; thumbnail?: string }) {
  const media = externalMediaUrl(url);
  const [playing, setPlaying] = useState(false);
  if (!media) return null;
  if (media.kind === 'gif') return <Image source={{ uri: media.url }} resizeMode="contain" style={styles.media} />;
  if (media.kind === 'video') return <View style={styles.media}>{playing ? <InlineVideo uri={media.url} onError={() => {}} /> : (
    <Pressable onPress={() => setPlaying(true)} style={styles.poster} accessibilityRole="button" accessibilityLabel="Play linked video">
      {thumbnail ? <Image source={{ uri: thumbnail }} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}<Text style={styles.play}>▶</Text>
    </Pressable>
  )}</View>;
  return <Pressable onPress={() => void Linking.openURL(media.url)} style={[styles.media, styles.poster]} accessibilityRole="link" accessibilityLabel={`Open ${media.kind} video`}>
    {thumbnail ? <Image source={{ uri: thumbnail }} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}<Text style={styles.play}>▶</Text><Text style={styles.label}>OPEN VIDEO</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  media: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#090912', overflow: 'hidden' },
  poster: { alignItems: 'center', justifyContent: 'center', backgroundColor: C.panelDeep },
  play: { color: '#fff', fontSize: 30, textShadowColor: '#000', textShadowRadius: 8 },
  label: { color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 1.4, marginTop: 5, textShadowColor: '#000', textShadowRadius: 5 },
});
