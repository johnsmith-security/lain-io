// Menus of the chat screen (native alerts, no extra screens):
//   tap a message   → retry / delete for everyone / delete for me / report
//   ··· in header   → safety number / block / report / delete chat
import { Alert } from 'react-native';
import { useNavigation } from '../../app/navigation';
import { getDb, type ChatMessage } from '../../db/native';
import { showError } from '../../lib/alerts';

type Peer = { pub: string | null; name?: string; username?: string };

export function useChatActions({ conversationId, peer, me, blocked, messages }: { conversationId: string | null; peer: Peer; me: string; blocked: boolean; messages: ChatMessage[] }) {
  const { closeChat } = useNavigation();
  const peerPub = peer.pub;

  /** Reports are sealed to the moderators. Only the messages chosen here are shared, decrypted, as evidence. */
  const report = (evidence: ChatMessage[]) => {
    if (!peerPub) return;
    Alert.alert('Report this conversation?', 'The moderators get the account and the messages shown as evidence. Nothing else in your chat is shared.', [
      { text: 'Cancel', style: 'cancel' },
      ...(['spam', 'harassment', 'sexual', 'other'] as const).map((reason) => ({
        text: reason[0].toUpperCase() + reason.slice(1),
        onPress: () => {
          getDb().moderation.report({
            kind: 'message', target: peerPub, reason,
            evidence: evidence.filter((m) => !m.deleted).slice(-20).map((m) => ({ from: m.from, text: m.text || (m.media ? '[attachment]' : ''), sentAt: m.sentAt })),
          })
            .then(() => Alert.alert('Reported', 'Thanks. You can also block this person from the ··· menu.'))
            .catch(showError('Report failed'));
        },
      })),
    ]);
  };

  const messageMenu = (message: ChatMessage) => {
    const db = getDb();
    const mine = message.from === me;
    const buttons: Parameters<typeof Alert.alert>[2] = [];
    if (mine && message.status === 'failed') buttons.push({ text: 'Retry now', onPress: () => { db.messages.resend(message.conversationId, message.id).catch(showError('Message not sent')); } });
    if (mine && !message.deleted) buttons.push({ text: 'Delete for everyone', style: 'destructive', onPress: () => { db.messages.deleteForEveryone(message.conversationId, message.id).catch(showError('Couldn’t delete')); } });
    buttons.push({ text: 'Delete for me', style: 'destructive', onPress: () => { db.messages.deleteLocalMessage(message.conversationId, message.id); } });
    if (!mine && !message.deleted) buttons.push({ text: 'Report', onPress: () => report([message]) });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(
      mine ? 'Your message' : 'Message',
      mine ? '“Delete for me” removes it from this device only. “Delete for everyone” also removes your friend’s copy.' : '“Delete for me” removes it from this device only. Your friend keeps their copy.',
      buttons,
    );
  };

  /** Compare in person; if a device key changed and the numbers match, trust it again. */
  const safetyNumber = async () => {
    if (!peerPub) return;
    try {
      const numbers = await getDb().messages.safetyNumbers(peerPub);
      if (!numbers.length) { Alert.alert('Safety number', 'This person hasn’t set up messaging on any device yet.'); return; }
      const changed = numbers.filter((n) => n.changed);
      const text = numbers.map((n) => `Device ${String(n.deviceId).slice(-4)}\n${n.safetyNumber.replace(/(\d{5})/g, '$1 ').trim()}`).join('\n\n');
      Alert.alert(changed.length ? 'Safety number changed' : 'Safety number', `${text}\n\nCompare these numbers with your friend in person or over a call. If they match, nobody is in the middle.`, [
        { text: 'Close', style: 'cancel' },
        ...(changed.length ? [{ text: 'They match — trust', onPress: () => { Promise.all(changed.map((n) => getDb().messages.trustNewIdentity(peerPub, n.deviceId))).catch(showError('Couldn’t update')); } }] : []),
      ]);
    } catch (error) { showError('Safety number')(error); }
  };

  const chatMenu = () => {
    if (!peerPub || !conversationId) return;
    const db = getDb();
    const name = peer.username ? `@${peer.username}` : 'this person';
    Alert.alert(peer.name ?? name, undefined, [
      { text: 'Verify safety number', onPress: () => void safetyNumber() },
      blocked
        ? { text: `Unblock ${name}`, onPress: () => { db.safety.unblock(peerPub).catch(showError('Couldn’t unblock')); } }
        : { text: `Block ${name}`, style: 'destructive', onPress: () => Alert.alert(`Block ${name}?`, 'Their messages are dropped on your devices and you won’t send them anything. They aren’t told.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Block', style: 'destructive', onPress: () => { db.safety.block(peerPub).catch(showError('Couldn’t block')); } },
        ]) },
      { text: 'Report…', onPress: () => report(messages.filter((m) => m.from === peerPub)) },
      { text: 'Delete chat on this device', style: 'destructive', onPress: () => Alert.alert('Delete this chat?', 'Removes the conversation from this device. Your friend keeps their copy.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { db.messages.deleteLocalConversation(conversationId); closeChat(); } },
      ]) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return { messageMenu, chatMenu, safetyNumber };
}
