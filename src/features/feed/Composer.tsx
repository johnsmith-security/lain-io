import { themedStyles } from '../../theme/themedStyles';
// "What's on your mind?" — text, up to 4 photos or 1 video, optional 18+ flag.
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDraft } from '../../app/drafts';
import { useProfile, useSession } from '../../db/hooks';
import { findLink, getDb, pickPostMedia, uploadPrepared, type PreparedMedia } from '../../db/native';
import { showError } from '../../lib/alerts';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { AvatarFace } from '../../ui/AvatarFace';
import { firstExternalMediaUrl } from '../../ui/media/mediaLinks';
import { AttachmentChip } from '../../ui/media/AttachmentChip';

export function Composer() {
  const session = useSession();
  const profile = useProfile(session?.pub ?? null);
  const [draft, setDraft] = useDraft('feed:text', '');
  const [attachments, setAttachments] = useDraft<PreparedMedia[]>('feed:attachments', []);
  const [sensitive, setSensitive] = useDraft('feed:sensitive', false);
  const [posting, setPosting] = useState(false);

  const attach = async () => {
    try {
      const picked = await pickPostMedia({ already: attachments.length });
      if (picked.length) setAttachments((previous) => [...previous, ...picked]);
    } catch (error) { showError('Can’t attach', 'Try another file.')(error); }
  };

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || posting) return;
    setPosting(true);
    try {
      const db = getDb();
      const media = await uploadPrepared(db, attachments.map((item) => ({ ...item, sensitive: item.sensitive || sensitive })));
      const url = firstExternalMediaUrl(text) ?? findLink(text);
      const link = url ? await db.media.linkPreview(url) : undefined;
      await db.social.createPost(text, { media, link });
      setDraft(''); setAttachments([]); setSensitive(false);
    } catch (error) { showError('Not transmitted')(error); }
    finally { setPosting(false); }
  };

  return (
    <View style={styles.composer}>
      <View style={styles.row}>
        <View style={[common.avatarSmall, { backgroundColor: C.avatar }]}><AvatarFace avatar={profile?.avatar} name={profile?.name ?? session?.username ?? '?'} textStyle={common.avatarSmallText} /></View>
        <TextInput value={draft} onChangeText={setDraft} placeholder="What’s on your mind?" placeholderTextColor={C.muted} multiline style={styles.input} />
      </View>
      {attachments.length ? (
        <View style={styles.attachRow}>
          {attachments.map((item, index) => <AttachmentChip key={item.uri} item={item} onRemove={() => setAttachments((previous) => previous.filter((_, i) => i !== index))} />)}
          <Pressable onPress={() => setSensitive(!sensitive)} accessibilityLabel="Mark as adult content" style={[styles.sensitiveChip, sensitive && styles.sensitiveChipOn]}>
            <Text style={[styles.sensitiveText, sensitive && { color: C.pink }]}>18+</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.foot}>
        <Pressable onPress={() => void attach()} hitSlop={10} disabled={posting}><Text style={styles.hint}>▣  PHOTO / VIDEO</Text></Pressable>
        <Pressable onPress={() => void submit()} disabled={posting} style={[styles.post, posting && { opacity: 0.6 }]}>
          {posting ? <ActivityIndicator color={C.ink} /> : <Text style={styles.postText}>Transmit  ↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  composer: { padding: 14, borderRadius: 16, backgroundColor: C.panel, borderWidth: 1, borderColor: C.lineStrong, marginBottom: 25 },
  row: { flexDirection: 'row', gap: 11, alignItems: 'flex-start' },
  input: { color: C.ink, minHeight: 47, flex: 1, fontSize: 13, paddingTop: 8, textAlignVertical: 'top' },
  attachRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' },
  sensitiveChip: { height: 30, paddingHorizontal: 10, borderRadius: 15, borderWidth: 1, borderColor: C.line, justifyContent: 'center' },
  sensitiveChipOn: { borderColor: C.pink },
  sensitiveText: { color: C.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  foot: { borderTopWidth: 1, borderColor: C.line, marginTop: 8, paddingTop: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { fontSize: 8, letterSpacing: 1.2, color: C.cyan, fontWeight: '700' },
  post: { backgroundColor: C.panelRaised, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 12 },
  postText: { color: C.pink, fontSize: 10, fontWeight: '700' },
}));
