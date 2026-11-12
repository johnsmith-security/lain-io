import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

/** Plays a video in place (fills its parent) with native controls. */
export function InlineVideo({ uri, onError }: { uri: string; onError: () => void }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = false; p.play(); });
  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => { if (status === 'error') onError(); });
    return () => sub.remove();
  }, [player, onError]);
  return <VideoView player={player} nativeControls contentFit="contain" style={StyleSheet.absoluteFill} />;
}
