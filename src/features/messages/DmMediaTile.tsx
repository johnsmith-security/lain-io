// A DM attachment. The relay / IPFS only hold ciphertext; this downloads it,
// checks the hash, decrypts it on the device into the app cache, and shows it.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { getDb, isVideo, openPrivateMedia, type PrivateMediaRef } from '../../db/native';
import { errorMessage } from '../../lib/alerts';
import { duration } from '../../lib/time';
import { C } from '../../theme/colors';
import { InlineVideo } from '../../ui/media/InlineVideo';
import { mediaStyles as m } from '../../ui/media/mediaStyles';

export function DmMediaTile({ media, style }: { media: PrivateMediaRef; style: StyleProp<ViewStyle> }) {
  const video = isVideo({ mime: media.plainMime });
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const load = useCallback(() => {
    setError('');
    openPrivateMedia(getDb(), media).then(setUri).catch((e: unknown) => setError(errorMessage(e, 'Couldn’t open it.')));
  }, [media]);
  // Photos decrypt right away; videos only when you tap play.
  useEffect(() => { if (!video) load(); }, [video, load]);

  return (
    <View style={[m.tile, style]}>
      {media.thumb ? <Image source={{ uri: media.thumb }} blurRadius={uri && !video ? 0 : 10} style={StyleSheet.absoluteFill} /> : null}
      {uri && !video ? <Image source={{ uri }} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}
      {uri && video && playing ? <InlineVideo uri={uri} onError={() => setError('Couldn’t play this video.')} /> : null}
      {error ? (
        <Pressable onPress={load} style={m.overlay}><Text style={m.overlayTitle}>{/expired/i.test(error) ? 'EXPIRED' : 'TAP TO RETRY'}</Text><Text style={m.overlayText}>{error}</Text></Pressable>
      ) : video && !playing ? (
        <Pressable onPress={() => { setPlaying(true); if (!uri) load(); }} style={m.overlay}><Text style={m.playGlyph}>▶</Text>{media.duration ? <Text style={m.overlayText}>{duration(media.duration)}</Text> : null}</Pressable>
      ) : !uri ? (
        <View style={m.overlay}><ActivityIndicator color={C.cyan} /></View>
      ) : null}
    </View>
  );
}
