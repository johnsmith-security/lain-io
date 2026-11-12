import { themedStyles } from '../../theme/themedStyles';
// A chat in the Messages list: who, last message, time, unread count.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../../db/hooks';
import { shortFingerprint, type Conversation } from '../../db/native';
import { timeAgo } from '../../lib/time';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { AvatarFace } from '../../ui/AvatarFace';

type Props = { conversation: Conversation; me: string; onOpen: () => void; onLongPress: () => void };

export function ConversationRow({ conversation, me, onOpen, onLongPress }: Props) {
  const peer = conversation.members.find((pub) => pub !== me) ?? null;
  const profile = useProfile(conversation.kind === 'direct' ? peer : null);
  const name = conversation.kind === 'group' ? conversation.name : profile?.name ?? profile?.username ?? (peer ? shortFingerprint(peer) : '…');
  const unread = conversation.unread;
  return (
    <Pressable onPress={onOpen} onLongPress={onLongPress} style={common.personRow} accessibilityRole="button" accessibilityLabel={`Chat with ${name}${unread ? `, ${unread} unread` : ''}`}>
      <View style={[common.personAvatar, { backgroundColor: profile?.accent ?? C.violet }]}>
        {conversation.kind === 'group' ? <Text style={common.personLetter}>#</Text> : <AvatarFace avatar={profile?.avatar} name={name} textStyle={common.personLetter} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={common.personName}>{name}</Text>
        <Text numberOfLines={1} style={[common.personDetail, unread > 0 && { color: C.ink }]}>{conversation.lastMessagePreview || 'No messages yet'}</Text>
      </View>
      <View style={styles.side}>
        <Text style={styles.time}>{conversation.lastMessageAt ? timeAgo(conversation.lastMessageAt) : ''}</Text>
        {unread > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text></View> : null}
      </View>
    </Pressable>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  side: { alignItems: 'flex-end', gap: 5 },
  time: { color: C.muted, fontSize: 10, letterSpacing: 0.5 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: C.inverseInk, fontSize: 11, fontWeight: '900' },
}));
