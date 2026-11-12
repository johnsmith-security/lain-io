// Photos and videos of a post (public files on the media relay / IPFS).
import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { getDb, isVideo, type MediaRef } from '../../db/native';
import { duration } from '../../lib/time';
import { InlineVideo } from '../../ui/media/InlineVideo';
import { mediaStyles as m, tileRatio } from '../../ui/media/mediaStyles';

/** One photo or video. Sensitive files stay blurred until tapped (unless the setting says otherwise). */
export function MediaTile({ media, showSensitive, style }: { media: MediaRef; showSensitive: boolean; style: StyleProp<ViewStyle> }) {
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const hidden = media.sensitive && !showSensitive && !revealed;
  const uri = getDb().media.url(media.sha);   // '' when the file was banned
  const video = isVideo(media);
  return (
    <View style={[m.tile, style]}>
      {media.thumb ? <Image source={{ uri: media.thumb }} blurRadius={hidden || failed || !uri ? 25 : 8} style={StyleSheet.absoluteFill} /> : null}
      {!hidden && !failed && uri && !video ? <Image source={{ uri }} resizeMode="cover" onError={() => setFailed(true)} style={StyleSheet.absoluteFill} /> : null}
      {!hidden && !failed && uri && video && playing ? <InlineVideo uri={uri} onError={() => setFailed(true)} /> : null}
      {hidden ? (
        <Pressable onPress={() => setRevealed(true)} style={m.overlay}><Text style={m.overlayTitle}>SENSITIVE</Text><Text style={m.overlayText}>Tap to view</Text></Pressable>
      ) : failed || !uri ? (
        <View style={m.overlay}><Text style={m.overlayTitle}>{uri ? 'EXPIRED' : 'REMOVED'}</Text><Text style={m.overlayText}>{uri ? 'This file was ephemeral.' : 'Removed by moderation.'}</Text></View>
      ) : video && !playing ? (
        <Pressable onPress={() => setPlaying(true)} style={m.overlay}><Text style={m.playGlyph}>▶</Text>{media.duration ? <Text style={m.overlayText}>{duration(media.duration)}</Text> : null}</Pressable>
      ) : null}
    </View>
  );
}

/** One tile at its own aspect ratio, or a 2-column grid of squares. */
export function MediaGrid({ media, showSensitive }: { media: MediaRef[]; showSensitive: boolean }) {
  if (media.length === 1) {
    return <View style={m.grid}><MediaTile media={media[0]} showSensitive={showSensitive} style={{ width: '100%', aspectRatio: tileRatio(media[0]) }} /></View>;
  }
  return <View style={[m.grid, m.gridMulti]}>{media.map((item) => <MediaTile key={item.sha} media={item} showSensitive={showSensitive} style={{ width: '49%', aspectRatio: 1 }} />)}</View>;
}
