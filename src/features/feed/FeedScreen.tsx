import { themedStyles } from '../../theme/themedStyles';
// "The Wired": composer + discovery feed.
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useDiscoveryFeed, useSession, useSettings } from '../../db/hooks';
import { longDate } from '../../lib/time';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { Eyebrow } from '../../ui/Eyebrow';
import { ScreenScroll } from '../../ui/ScreenScroll';
import { ScreenTitle } from '../../ui/ScreenTitle';
import { Composer } from './Composer';
import { PostCard } from './PostCard';

export function FeedScreen() {
  const session = useSession();
  const discovery = useDiscoveryFeed();
  const [settings] = useSettings();
  const showSensitive = settings?.showSensitiveMedia ?? false;
  if (!session) return null;
  return (
    <ScreenScroll>
      <ScreenTitle eyebrow={longDate()} title={<>The Wired<Text style={{ color: C.pink }}>.</Text></>} subtitle="A place to exist together." />
      <Composer />
      <View style={styles.sectionHead}><Eyebrow>RECENT SIGNALS</Eyebrow><Text style={common.liveCount}>◉  2.4k online</Text></View>
      {discovery.items.map((post) => <PostCard key={post.ref} post={post} showSensitive={showSensitive} me={session.pub} />)}
      {discovery.items.length === 0 && (
        <View style={common.card}>{discovery.loading ? <ActivityIndicator color={C.cyan} /> : <Text style={common.emptyText}>No signals yet. Transmit the first one.</Text>}</View>
      )}
    </ScreenScroll>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
}));
