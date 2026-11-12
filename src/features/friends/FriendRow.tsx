import { themedStyles } from '../../theme/themedStyles';
// Someone you follow. Long-press to unfollow, ✉ to message.
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../../db/hooks';
import { getDb, shortFingerprint } from '../../db/native';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { AvatarFace } from '../../ui/AvatarFace';

export function FriendRow({ pub, onMessage }: { pub: string; onMessage: (pub: string) => void }) {
  const profile = useProfile(pub);
  const name = profile?.name ?? '…';
  const unfollow = () => Alert.alert('Unfollow', `Stop following @${profile?.username ?? shortFingerprint(pub)}?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Unfollow', style: 'destructive', onPress: () => { getDb().social.unfollow(pub).catch(() => {}); } },
  ]);
  return (
    <Pressable onLongPress={unfollow} style={common.personRow}>
      <View style={[common.personAvatar, { backgroundColor: profile?.accent ?? C.violet }]}><AvatarFace avatar={profile?.avatar} name={name} textStyle={common.personLetter} /></View>
      <View style={{ flex: 1 }}>
        <Text style={common.personName}>{name}</Text>
        <Text style={common.personDetail}>@{profile?.username ?? shortFingerprint(pub)}{profile?.bio ? `  ·  ${profile.bio}` : ''}</Text>
      </View>
      <Pressable onPress={() => onMessage(pub)} accessibilityRole="button" accessibilityLabel={`Message ${profile?.name ?? profile?.username ?? 'friend'}`} style={styles.message}>
        <Text style={styles.messageText}>✉</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  message: { width: 32, height: 32, borderRadius: 10, borderWidth: 1, borderColor: C.lineStrong, alignItems: 'center', justifyContent: 'center' },
  messageText: { color: C.cyan },
}));
