import { themedStyles } from '../../theme/themedStyles';
// Connections: your chats (with unread counts) and the people you follow.
import React from 'react';
import { Alert, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDraft } from '../../app/drafts';
import { useNavigation } from '../../app/navigation';
import { useConversations, useFollowing, useSession } from '../../db/hooks';
import { getDb, normalizeUsername, type Conversation } from '../../db/native';
import { showError } from '../../lib/alerts';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { Button } from '../../ui/Button';
import { ScreenScroll } from '../../ui/ScreenScroll';
import { ScreenTitle } from '../../ui/ScreenTitle';
import { ConversationRow } from './ConversationRow';
import { FriendRow } from './FriendRow';

export function FriendsScreen() {
  const session = useSession();
  const following = useFollowing();
  const conversations = useConversations();
  const { openChat } = useNavigation();
  const [search, setSearch] = useDraft('friends:search', '');
  const unread = conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
  if (!session) return null;

  const follow = async () => {
    const name = normalizeUsername(search);
    if (!name) return;
    try {
      const db = getDb();
      const pub = await db.usernames.resolve(name, { fresh: true });
      if (!pub) { Alert.alert('Not found', `No one is called @${name} yet.`); return; }
      if (pub === db.session?.pub) { Alert.alert('That’s you', 'Search for someone else.'); return; }
      await db.social.follow(pub);
      setSearch('');
    } catch (error) { showError('Follow failed')(error); }
  };

  const message = async (pub: string) => {
    if (pub === session.pub) return;
    Keyboard.dismiss();
    try { openChat((await getDb().messages.openDirect(pub)).id); }
    catch (error) { showError('Could not open chat')(error); }
  };

  const deleteChat = (conversation: Conversation) => Alert.alert('Delete this chat?', 'Removes the conversation from this device. The other side keeps their copy.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => getDb().messages.deleteLocalConversation(conversation.id) },
  ]);

  return (
    <ScreenScroll>
      <ScreenTitle eyebrow="YOUR NETWORK" title="Connections" subtitle="People across the boundary." />

      {conversations.length > 0 && (
        <>
          <View style={styles.summary}>
            <Text style={styles.count}>{String(conversations.length).padStart(2, '0')} <Text style={styles.countLabel}>{unread ? `MESSAGES · ${unread} UNREAD` : 'MESSAGES'}</Text></Text>
            <Text style={common.liveCount}>LONG-PRESS TO DELETE</Text>
          </View>
          {conversations.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} me={session.pub} onOpen={() => { Keyboard.dismiss(); openChat(conversation.id); }} onLongPress={() => deleteChat(conversation)} />
          ))}
          <View style={{ height: 14 }} />
        </>
      )}

      <View style={styles.search}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput value={search} onChangeText={setSearch} onSubmitEditing={() => void follow()} placeholder="Follow a username, e.g. bob" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={styles.searchInput} />
      </View>
      <View style={styles.summary}>
        <Text style={styles.count}>{String(following.items.length).padStart(2, '0')} <Text style={styles.countLabel}>FOLLOWING</Text></Text>
        <Text style={common.liveCount}>LONG-PRESS TO UNFOLLOW</Text>
      </View>
      {following.items.map((pub) => <FriendRow key={pub} pub={pub} onMessage={(friend) => void message(friend)} />)}
      {following.items.length === 0 && !following.loading && <Text style={[common.emptyText, { marginVertical: 18 }]}>You’re not following anyone yet. Search a username above.</Text>}
      <Button title="＋  Follow" secondary onPress={() => void follow()} />
    </ScreenScroll>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  search: { height: 45, borderRadius: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.lineStrong, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, marginBottom: 18 },
  searchIcon: { fontSize: 22, color: C.cyan, marginRight: 8 },
  searchInput: { color: C.ink, fontSize: 12, flex: 1 },
  summary: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 13 },
  count: { color: C.ink, fontSize: 19, fontWeight: '700' },
  countLabel: { fontSize: 8, color: C.violet, letterSpacing: 1.2 },
}));
