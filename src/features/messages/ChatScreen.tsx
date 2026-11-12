import { themedStyles } from '../../theme/themedStyles';
// One conversation: end-to-end encrypted (Signal protocol over Gun).
import React, { useEffect, useRef } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '../../app/navigation';
import { useConversations, useIdentityWarnings, useMessages, useProfile, useSafety, useSession } from '../../db/hooks';
import { getDb, shortFingerprint } from '../../db/native';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { AvatarFace } from '../../ui/AvatarFace';
import { ScreenScroll, isAtBottom, type ScrollHandle } from '../../ui/ScreenScroll';
import { ChatComposer } from './ChatComposer';
import { MessageBubble } from './MessageBubble';
import { useChatActions } from './useChatActions';

export function ChatScreen() {
  const session = useSession();
  const { activeChatId, go } = useNavigation();
  const conversations = useConversations();
  const conversation = conversations.find((c) => c.id === activeChatId) ?? null;
  const peerPub = conversation?.members.find((pub) => pub !== session?.pub) ?? null;
  const profile = useProfile(peerPub);
  const messages = useMessages(activeChatId);
  const warnings = useIdentityWarnings();
  const safety = useSafety();
  const warning = peerPub ? warnings.find((w) => w.pub === peerPub) ?? null : null;
  const blocked = Boolean(peerPub && safety?.blocked?.[peerPub]);
  const scrollRef = useRef<ScrollHandle>(null);
  const atBottom = useRef(true);
  const actions = useChatActions({ conversationId: activeChatId, peer: { pub: peerPub, name: profile?.name, username: profile?.username }, me: session?.pub ?? '', blocked, messages });

  // Reading the chat marks it read (and sends a read receipt if enabled).
  useEffect(() => { if (activeChatId) getDb().messages.markRead(activeChatId); }, [activeChatId, messages.length]);

  if (!session || !activeChatId) return null;
  const name = profile?.name ?? profile?.username ?? 'Direct message';

  return (
    <>
      <ScreenScroll
        ref={scrollRef}
        onScroll={(event) => { atBottom.current = isAtBottom(event.nativeEvent); }}
        onContentSizeChange={() => { if (atBottom.current) scrollRef.current?.scrollToEnd({ animated: true }); }}
      >
        <Pressable style={styles.back} onPress={() => { Keyboard.dismiss(); go('friends'); }}><Text style={styles.backText}>‹  CONNECTIONS</Text></Pressable>
        <View style={styles.header}>
          <View style={[common.personAvatar, { backgroundColor: profile?.accent ?? C.violet }]}><AvatarFace avatar={profile?.avatar} name={name} textStyle={common.personLetter} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{conversation?.kind === 'group' ? conversation.name : name}</Text>
            <Text style={common.personDetail}>@{profile?.username ?? (peerPub ? shortFingerprint(peerPub) : 'friend')}</Text>
          </View>
          <Text style={styles.lock}>🔒</Text>
          <Pressable onPress={actions.chatMenu} hitSlop={12} accessibilityRole="button" accessibilityLabel="Chat options" style={styles.menu}><Text style={styles.menuText}>···</Text></Pressable>
        </View>
        <Text style={styles.privacy}>{conversation?.kind === 'group' ? `GROUP · ${conversation.members.length} MEMBERS · END-TO-END ENCRYPTED` : 'ONE-TO-ONE · END-TO-END ENCRYPTED'}</Text>
        {warning ? (
          <Pressable onPress={() => void actions.safetyNumber()} style={styles.banner}>
            <Text style={styles.bannerTitle}>SAFETY NUMBER CHANGED</Text>
            <Text style={styles.bannerText}>This person’s device key changed (new phone or reinstall, or someone in the middle). Messages to that device are paused until you verify. Tap to compare.</Text>
          </Pressable>
        ) : null}
        {blocked ? (
          <Pressable onPress={actions.chatMenu} style={styles.banner}>
            <Text style={styles.bannerTitle}>BLOCKED</Text>
            <Text style={styles.bannerText}>You won’t receive or send messages here. Tap ··· to unblock.</Text>
          </Pressable>
        ) : null}
        <Text style={styles.hint}>Tap a message for options.</Text>
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>✉</Text>
            <Text style={styles.emptyTitle}>Start a private conversation</Text>
            <Text style={styles.emptyCopy}>Only you and this friend can read these messages.</Text>
          </View>
        ) : messages.map((message) => (
          <MessageBubble key={message.id} message={message} mine={message.from === session.pub} onPress={() => actions.messageMenu(message)} />
        ))}
      </ScreenScroll>
      <ChatComposer
        conversationId={activeChatId}
        blocked={blocked}
        onSent={() => { atBottom.current = true; requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true })); }}
      />
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  back: { marginBottom: 16 },
  backText: { color: C.cyan, fontSize: 9, fontWeight: '800', letterSpacing: 1.3 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 15 },
  name: { color: C.ink, fontSize: 14, fontWeight: '700' },
  lock: { fontSize: 16 },
  menu: { paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6 },
  menuText: { color: C.cyan, fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  privacy: { color: C.cyan, fontSize: 7, fontWeight: '800', letterSpacing: 1.2, marginTop: 11, marginBottom: 4 },
  banner: { borderWidth: 1, borderColor: C.sun, backgroundColor: C.banner, borderRadius: 12, padding: 12, marginBottom: 12 },
  bannerTitle: { color: C.sun, fontSize: 11, fontWeight: '900', letterSpacing: 1.4, marginBottom: 4 },
  bannerText: { color: C.ink, fontSize: 13, lineHeight: 18 },
  hint: { color: C.muted, fontSize: 8, marginBottom: 8 },
  empty: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 36 },
  emptyGlyph: { fontSize: 24, color: C.violet },
  emptyTitle: { fontSize: 12, color: C.ink, fontWeight: '700', marginTop: 12 },
  emptyCopy: { fontSize: 9, color: C.muted, lineHeight: 14, textAlign: 'center', marginTop: 6 },
}));
