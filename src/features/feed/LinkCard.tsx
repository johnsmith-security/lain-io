import { themedStyles } from '../../theme/themedStyles';
// Preview of a link in a post (YouTube / PeerTube / any page), captured when posting.
import React from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LinkPreview } from '../../db/native';
import { C } from '../../theme/colors';
import { ExternalMedia } from '../../ui/media/ExternalMedia';
import { externalMediaUrl } from '../../ui/media/mediaLinks';

const providerLabel = (link: LinkPreview) =>
  link.provider === 'youtube' ? 'YOUTUBE' : link.provider === 'peertube' ? 'PEERTUBE' : new URL(link.url).hostname.toUpperCase();

export function LinkCard({ link }: { link: LinkPreview }) {
  const externalMedia = externalMediaUrl(link.url);
  return (
    <View style={styles.card}>
      {externalMedia ? <ExternalMedia url={link.url} thumbnail={link.thumbnail} /> : link.thumbnail ? (
        <View>
          <Image source={{ uri: link.thumbnail }} resizeMode="cover" style={styles.thumb} />
          {link.provider !== 'link' ? <Text style={styles.play}>▶</Text> : null}
        </View>
      ) : null}
      <Pressable onPress={() => void Linking.openURL(link.url)} style={styles.meta} accessibilityRole="link">
        <Text style={styles.provider}>{providerLabel(link)}</Text>
        <Text numberOfLines={2} style={styles.title}>{link.title}</Text>
        {link.author ? <Text style={styles.author}>{link.author}</Text> : null}
        <Text numberOfLines={1} style={styles.url}>{link.url}</Text>
      </Pressable>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  card: { marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, overflow: 'hidden', backgroundColor: C.panelDeep },
  thumb: { width: '100%', aspectRatio: 16 / 9 },
  play: { position: 'absolute', alignSelf: 'center', top: '38%', color: C.ink, fontSize: 28 },
  meta: { padding: 11 },
  provider: { color: C.cyan, fontSize: 8, letterSpacing: 1.6, fontWeight: '800' },
  title: { color: C.ink, fontSize: 13, fontWeight: '700', marginTop: 4 },
  author: { color: C.muted, fontSize: 11, marginTop: 2 },
  url: { color: C.cyan, fontSize: 9, marginTop: 5 },
}));
