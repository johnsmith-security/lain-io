import { themedStyles } from '../../theme/themedStyles';
// Docked message composer: attach (encrypted on the phone), text, send.
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDraft } from '../../app/drafts';
import { getDb, pickPostMedia, uploadPrivatePrepared, type PreparedMedia } from '../../db/native';
import { showError } from '../../lib/alerts';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { AttachmentChip } from '../../ui/media/AttachmentChip';
import { SendButton } from '../../ui/SendButton';

export function ChatComposer({ conversationId, blocked, onSent }: { conversationId: string; blocked: boolean; onSent: () => void }) {
  const [text, setText] = useDraft(`chat:${conversationId}:text`, '');
  const [attachments, setAttachments] = useDraft<PreparedMedia[]>(`chat:${conversationId}:attachments`, []);
  const [sending, setSending] = useState(false);
  const empty = !text.trim() && !attachments.length;

  const attach = async () => {
    try {
      const picked = await pickPostMedia({ already: attachments.length });
      if (picked.length) setAttachments((previous) => [...previous, ...picked]);
    } catch (error) { showError('Can’t attach', 'Try another file.')(error); }
  };

  const send = async () => {
    if (empty || sending) return;
    setSending(true);
    try {
      const db = getDb();
      // Encrypted on this device before upload; the keys travel only inside the Signal message.
      const media = attachments.length ? await uploadPrivatePrepared(db, attachments) : undefined;
      const sent = await db.messages.send(conversationId, text, { media });
      if (sent.status === 'failed') Alert.alert('Not delivered yet', 'The relay didn’t answer. Lain IO will keep retrying for 24 hours, or tap the message to retry now.');
      setText('');
      setAttachments([]);
      onSent();
    } catch (error) { showError('Message not sent')(error); }
    finally { setSending(false); }
  };

  return (
    <>
      {attachments.length > 0 && (
        <View style={styles.attachments}>
          {attachments.map((item, index) => <AttachmentChip key={item.uri} item={item} onRemove={() => setAttachments((previous) => previous.filter((_, i) => i !== index))} />)}
          <Text style={styles.note}>Encrypted on this phone · kept 30 days</Text>
        </View>
      )}
      <View style={[common.composerDock, styles.dock]}>
        <Pressable onPress={() => void attach()} disabled={sending || blocked} accessibilityRole="button" accessibilityLabel="Attach photo or video" style={[styles.attach, (sending || blocked) && { opacity: 0.4 }]}>
          <Text style={styles.attachGlyph}>▣</Text>
        </Pressable>
        <TextInput value={text} onChangeText={setText} editable={!blocked} placeholder={blocked ? 'Unblock to send messages' : 'Message your friend…'} placeholderTextColor={C.muted} multiline blurOnSubmit={false} maxLength={4000} style={[common.dockInput, { maxHeight: 110 }]} />
        <SendButton onPress={() => void send()} disabled={empty || sending || blocked} busy={sending} />
      </View>
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  dock: { marginTop: 6, marginBottom: 8 },
  attach: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.panelRaised },
  attachGlyph: { color: C.cyan, fontSize: 18 },
  attachments: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 8, backgroundColor: C.bg },
  note: { color: C.muted, fontSize: 10, letterSpacing: 0.6, flexBasis: '100%' },
}));
