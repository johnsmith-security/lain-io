import React, { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { C } from '../../theme/colors';
import { InlineVideo } from './InlineVideo';
import { embedUrl, externalMediaUrl } from './mediaLinks';

/**
 * Embeds are hosted in a tiny page whose origin is our site, so the provider's iframe is requested
 * with `Referer: https://lain.xn--tckwe/`. YouTube requires embedders to identify themselves this
 * way: loading the embed URL directly in a WebView sends no Referer and fails with
 * "Error 153 — video player configuration error".
 */
const EMBED_ORIGIN = 'https://lain.xn--tckwe';
const embedPage = (src: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{margin:0;height:100%;background:#090912;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head>
<body><iframe src="${src.replace(/"/g, '&quot;')}" referrerpolicy="strict-origin-when-cross-origin"
allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></body></html>`;

const YOUTUBE_FRAME_HOSTS = (host: string) =>
  host === 'www.youtube-nocookie.com' || host === 'www.youtube.com' || host.endsWith('.youtube.com') || host.endsWith('.googlevideo.com') || host.endsWith('.ytimg.com') || host.endsWith('.google.com') || host.endsWith('.gstatic.com');

/** Inline display for direct GIF/video URLs and tap-to-play YouTube/PeerTube embeds. */
export function ExternalMedia({ url, thumbnail }: { url: string; thumbnail?: string }) {
  const media = externalMediaUrl(url);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!media) return null;

  if (media.kind === 'gif') {
    return <Image source={{ uri: media.url }} resizeMode="contain" style={styles.media} onError={() => setFailed(true)} />;
  }

  if (media.kind === 'video') {
    return (
      <View style={styles.media}>
        {playing ? <InlineVideo uri={media.url} onError={() => setFailed(true)} /> : (
          <Pressable onPress={() => setPlaying(true)} style={styles.poster} accessibilityRole="button" accessibilityLabel="Play linked video">
            {thumbnail ? <Image source={{ uri: thumbnail }} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}
            <Text style={styles.play}>▶</Text>
          </Pressable>
        )}
        {failed ? <Pressable onPress={() => void Linking.openURL(media.url)} style={styles.failed}><Text style={styles.failedText}>Can’t play here · Open link</Text></Pressable> : null}
      </View>
    );
  }

  const source = embedUrl(media.url, media.kind);
  return (
    <View style={styles.media}>
      {playing && source ? (
        <WebView
          source={{ html: embedPage(source), baseUrl: `${EMBED_ORIGIN}/` }}
          style={styles.webview}
          originWhitelist={[EMBED_ORIGIN, 'about:*', 'https://*']}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) => {
            if (request.url.startsWith('about:') || request.url.startsWith('data:')) return true;
            try {
              const url = new URL(request.url);
              const host = url.hostname.toLowerCase();
              if (url.origin === EMBED_ORIGIN) return true;                     // the hosting page itself
              const topFrame = request.isTopFrame !== false;
              // "Watch on YouTube" / title links try to replace the whole view: open them outside instead.
              if (topFrame) { void Linking.openURL(request.url); return false; }
              return media.kind === 'youtube' ? YOUTUBE_FRAME_HOSTS(host) : host === new URL(source).hostname.toLowerCase();
            } catch { return false; }
          }}
          onError={() => setFailed(true)}
        />
      ) : (
        <Pressable onPress={() => setPlaying(true)} style={styles.poster} accessibilityRole="button" accessibilityLabel={`Play ${media.kind} video`}>
          {thumbnail ? <Image source={{ uri: thumbnail }} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}
          <Text style={styles.play}>▶</Text>
          <Text style={styles.playLabel}>PLAY VIDEO</Text>
        </Pressable>
      )}
      {failed ? <Pressable onPress={() => void Linking.openURL(media.url)} style={styles.failed}><Text style={styles.failedText}>Can’t play here · Open link</Text></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  media: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#090912', overflow: 'hidden' },
  poster: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panelDeep },
  play: { color: '#fff', fontSize: 30, textShadowColor: '#000', textShadowRadius: 8 },
  playLabel: { color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 1.4, marginTop: 5, textShadowColor: '#000', textShadowRadius: 5 },
  webview: { flex: 1, backgroundColor: '#090912' },
  failed: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center' },
  failedText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
