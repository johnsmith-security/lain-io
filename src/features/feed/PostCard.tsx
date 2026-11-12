import { themedStyles } from '../../theme/themedStyles';
// A post in the feed: author, text, media, link, repost, and like / relay actions.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLikes, usePost, useProfile, useReposts } from '../../db/hooks';
import { shortFingerprint, type Post } from '../../db/native';
import { showError } from '../../lib/alerts';
import { timeAgo } from '../../lib/time';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { AvatarFace } from '../../ui/AvatarFace';
import { LinkCard } from './LinkCard';
import { MediaGrid } from './MediaGrid';

function PostContent({ post, showSensitive }: { post: Post; showSensitive: boolean }) {
  return (
    <>
      {post.body ? <Text style={common.body}>{post.body}</Text> : null}
      {post.media ? <MediaGrid media={post.media} showSensitive={showSensitive} /> : null}
      {post.link ? <LinkCard link={post.link} /> : null}
    </>
  );
}

/** The original post inside a repost. */
function RepostedPost({ postRef, showSensitive }: { postRef: string; showSensitive: boolean }) {
  const original = usePost(postRef);
  const author = useProfile(original?.author ?? null);
  if (!original) return <View style={styles.repostBox}><Text style={common.emptyText}>This post is no longer available.</Text></View>;
  return (
    <View style={styles.repostBox}>
      <Text style={styles.repostAuthor}>{author?.name ?? '…'}  <Text style={styles.handle}>@{author?.username ?? shortFingerprint(original.author)}  ·  {timeAgo(original.createdAt)}</Text></Text>
      <PostContent post={original} showSensitive={showSensitive} />
    </View>
  );
}

export function PostCard({ post, showSensitive, me }: { post: Post; showSensitive: boolean; me: string }) {
  const author = useProfile(post.author);
  // A bare repost (no own text/media) is liked and relayed as the original.
  const target = post.repostOf && !post.body && !post.media && !post.link ? post.repostOf : post.ref;
  const likes = useLikes(target);
  const reposts = useReposts(target);
  const ownTarget = target.startsWith(`${me}/`);
  const accent = author?.accent ?? C.violet;
  const name = author?.name ?? author?.username ?? '…';
  const handle = author ? `@${author.username}${author.verified === false ? ' · unverified' : ''}` : `@${shortFingerprint(post.author)}`;
  const like = () => { likes.toggle().catch(showError('Like failed')); };
  const relay = () => { if (!ownTarget) reposts.toggle().catch(showError('Relay failed')); };

  return (
    <View style={common.card}>
      <View style={styles.head}>
        <View style={[styles.avatar, { borderColor: accent }]}><AvatarFace avatar={author?.avatar} name={name} textStyle={[styles.avatarText, { color: accent }]} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.author}>{name}</Text>
          <Text style={styles.handle}>{handle}  ·  {timeAgo(post.createdAt)}{post.editedAt ? ' · edited' : ''}</Text>
        </View>
        <Text style={styles.more}>···</Text>
      </View>
      {post.repostOf ? <Text style={styles.repostLabel}>↗  RELAYED</Text> : null}
      <PostContent post={post} showSensitive={showSensitive} />
      {post.repostOf ? <RepostedPost postRef={post.repostOf} showSensitive={showSensitive} /> : null}
      <View style={styles.actions}>
        <Pressable onPress={like} hitSlop={10} accessibilityLabel={likes.likedByMe ? 'Unlike' : 'Like'}><Text style={[styles.action, likes.likedByMe && { color: C.pink }]}>{likes.likedByMe ? '♥' : '♡'}  {likes.count}</Text></Pressable>
        <Text style={styles.action}>◌</Text>
        <Pressable onPress={relay} disabled={ownTarget} hitSlop={10} accessibilityLabel="Relay (repost)"><Text style={[styles.action, reposts.repostedByMe && { color: C.cyan }, ownTarget && { opacity: 0.45 }]}>↗  Relay{reposts.count ? `  ${reposts.count}` : ''}</Text></Pressable>
        <Text style={styles.action}>⌁</Text>
      </View>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 37, height: 37, borderRadius: 13, borderWidth: 1, backgroundColor: C.panelRaised, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarText: { fontSize: 15, fontWeight: '800' },
  author: { color: C.ink, fontSize: 12, fontWeight: '700' },
  handle: { fontSize: 9, color: C.muted, marginTop: 3 },
  more: { color: C.violet, fontSize: 19, marginTop: -8 },
  actions: { borderTopWidth: 1, borderColor: C.line, marginTop: 15, paddingTop: 12, flexDirection: 'row', justifyContent: 'space-between' },
  action: { fontSize: 10, color: C.muted },
  repostLabel: { color: C.cyan, fontSize: 8, letterSpacing: 1.6, fontWeight: '800', marginTop: 10 },
  repostBox: { marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 11 },
  repostAuthor: { color: C.ink, fontSize: 12, fontWeight: '700' },
}));
