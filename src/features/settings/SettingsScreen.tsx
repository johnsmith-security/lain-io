import { themedStyles } from '../../theme/themedStyles';
// Preferences (encrypted, synced settings document on Gun), profile picture, account.
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useProfile, useSafety, useSession, useSettings } from '../../db/hooks';
import { getDb, pickAvatar, shortFingerprint, type Settings } from '../../db/native';
import { errorMessage, showError } from '../../lib/alerts';
import { LINKS, openLink } from '../../lib/links';
import { clockTime } from '../../lib/time';
import { C } from '../../theme/colors';
import { common } from '../../theme/common';
import { useAppTheme } from '../../theme/ThemeProvider';
import { AvatarFace } from '../../ui/AvatarFace';
import { Eyebrow } from '../../ui/Eyebrow';
import { ScreenScroll } from '../../ui/ScreenScroll';
import { ScreenTitle } from '../../ui/ScreenTitle';
import { ThemeChoice } from './ThemePreferences';
import { LookChoice, ModelChoice, VoiceChoice, type ModelId } from './LainPreferences';
import { SettingGroup, SettingLink, SettingRow, rows } from './SettingRows';

export function SettingsScreen() {
  const session = useSession();
  const profile = useProfile(session?.pub ?? null);
  const [settings, updateSettings] = useSettings();
  const { id: appTheme, chooseTheme } = useAppTheme();
  const safety = useSafety();
  const openedAt = useMemo(() => clockTime(), []);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  if (!session) return null;

  // In-app account deletion (App Store 5.1.1(v), Google Play account deletion policy).
  const startDelete = () => Alert.alert('Delete your account?', 'This removes your profile, posts, settings, Lain data and messages from Lain IO’s relays and releases your username. It can’t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Continue', style: 'destructive', onPress: () => setDeleting(true) },
  ]);
  const confirmDelete = async () => {
    if (!deletePassword) return;
    setDeleteBusy(true);
    try { await getDb().deleteAccount(deletePassword); }
    catch (failure) { Alert.alert('Account not deleted', errorMessage(failure, 'Check your password and try again.')); }
    finally { setDeleteBusy(false); setDeletePassword(''); }
  };

  const save = (patch: Partial<Omit<Settings, 'updatedAt'>>) => { updateSettings(patch).catch(showError('Settings', 'Could not save.')); };
  const showSensitive = settings?.showSensitiveMedia ?? false;
  const setShowSensitive = (value: boolean) => {
    if (!value) { save({ showSensitiveMedia: false }); return; }
    Alert.alert('Show sensitive media?', 'Photos and videos flagged as adult content will show without blur. You must be 18 or older.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'I’m 18 or older', onPress: () => save({ showSensitiveMedia: true }) },
    ]);
  };
  const choosePhoto = () => { pickAvatar(getDb()).catch(showError('Profile picture not updated', 'Please try another photo.')); };
  const signOut = () => Alert.alert('Sign out', 'You can sign back in with your username and password on any device.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign out', style: 'destructive', onPress: () => { getDb().signOut().catch(() => {}); } },
  ]);
  const relay = (getDb().ctx.config.peers[0] ?? 'no relay').replace(/^\w+:\/\//, '').replace(/\/gun$/, '');
  const name = profile?.name ?? session.username;

  return (
    <ScreenScroll>
      <ScreenTitle eyebrow="PREFERENCES" title="Settings" subtitle="Tune your presence in the Wired." />

      <Pressable style={styles.profile} onPress={choosePhoto} accessibilityRole="button" accessibilityLabel="Choose profile picture">
        <View style={[common.personAvatar, styles.profileAvatar]}>
          <AvatarFace avatar={profile?.avatar} name={name} textStyle={common.personLetter} />
          <View style={styles.badge}><Text style={styles.badgeText}>✎</Text></View>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={common.personName}>{name}</Text>
          <Text style={common.personDetail}>@{session.username}  ·  {shortFingerprint(session.pub)}</Text>
          <Text style={styles.photoHint}>TAP TO CHANGE · PUBLIC PROFILE</Text>
        </View>
        <Text style={rows.chevron}>›</Text>
      </Pressable>

      <ModelChoice value={(settings?.selectedModel ?? 'lain-000') as ModelId} onChange={(selectedModel) => save({ selectedModel })} />
      <ThemeChoice value={appTheme} onChange={(appTheme) => { chooseTheme(appTheme).catch(showError('Theme', 'Could not save.')); }} />
      <LookChoice value={settings?.lainStyle ?? 'vaporwave'} onChange={(lainStyle) => save({ lainStyle })} />
      <VoiceChoice value={settings?.lainVoice ?? 'wired'} onChange={(lainVoice) => save({ lainVoice })} />

      <Eyebrow>PRIVACY & PRESENCE</Eyebrow>
      <SettingGroup>
        <SettingRow label="Private presence" detail="Only connections can see when you’re online" value={settings?.privatePresence ?? true} onChange={(privatePresence) => save({ privatePresence })} />
        <SettingRow label="Quiet mode" detail="Pause notifications and mentions" value={settings?.quietMode ?? false} onChange={(quietMode) => save({ quietMode })} />
        <SettingRow label="Show activity status" detail="Let others see when you’re active" value={settings?.showActivity ?? true} onChange={(showActivity) => save({ showActivity })} />
        <SettingRow label="Read receipts" detail="Let people you message see when you’ve read their messages. Delivery ticks are always on" value={settings?.readReceipts ?? false} onChange={(readReceipts) => save({ readReceipts })} />
        <SettingRow label="Show sensitive media" detail="Photos and videos flagged as adult content stay blurred until you tap them" value={showSensitive} onChange={setShowSensitive} />
      </SettingGroup>

      <Eyebrow>ACCOUNT</Eyebrow>
      <SettingGroup>
        <SettingLink label="Username" value={`@${session.username}`} />
        <SettingLink label="Sync & storage" value={`GunDB · ${relay}`} />
        <SettingLink label="Blocked connections" value={String(Object.keys(safety?.blocked ?? {}).length)} />
        <SettingLink label="About Lain IO" value="Version 1.0.0" />
      </SettingGroup>

      <Eyebrow>SAFETY & LEGAL</Eyebrow>
      <SettingGroup>
        <SettingLink label="Community guidelines" value="lain.コム" onPress={() => openLink(LINKS.guidelines)} />
        <SettingLink label="Child safety standards" value="" onPress={() => openLink(LINKS.childSafety)} />
        <SettingLink label="Privacy policy" value="" onPress={() => openLink(LINKS.privacy)} />
        <SettingLink label="Terms of use" value="" onPress={() => openLink(LINKS.terms)} />
        <SettingLink label="Help & contact" value="" onPress={() => openLink(LINKS.support)} />
      </SettingGroup>

      <Pressable style={styles.signout} onPress={signOut}><Text style={styles.signoutText}>Sign out</Text></Pressable>
      {deleting ? (
        <View style={styles.deleteBox}>
          <Text style={styles.deleteTitle}>Enter your password to delete @{session.username}</Text>
          <TextInput value={deletePassword} onChangeText={setDeletePassword} placeholder="password" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="Password" style={styles.deleteInput} />
          <View style={styles.deleteActions}>
            <Pressable style={styles.deleteCancel} onPress={() => { setDeleting(false); setDeletePassword(''); }}><Text style={styles.signoutText}>Cancel</Text></Pressable>
            <Pressable style={[styles.deleteGo, (!deletePassword || deleteBusy) && { opacity: 0.5 }]} disabled={!deletePassword || deleteBusy} onPress={() => void confirmDelete()}>
              <Text style={styles.deleteGoText}>{deleteBusy ? 'Deleting…' : 'Delete forever'}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={styles.delete} onPress={startDelete} accessibilityRole="button"><Text style={styles.deleteText}>Delete account</Text></Pressable>
      )}
      <Text style={styles.foot}>LAIN INPUT / OUTPUT  ·  {openedAt}</Text>
    </ScreenScroll>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: C.panel, borderRadius: 15, borderWidth: 1, borderColor: C.lineStrong, marginBottom: 24 },
  profileAvatar: { backgroundColor: C.avatar, width: 54, height: 54 },
  badge: { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: C.pink, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.panel },
  badgeText: { color: C.inverseInk, fontSize: 11, fontWeight: '800' },
  photoHint: { fontSize: 7, color: C.cyan, letterSpacing: 1, marginTop: 5 },
  signout: { height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: C.lineStrong, marginTop: 3 },
  signoutText: { color: C.pink, fontSize: 11, fontWeight: '600' },
  delete: { height: 40, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  deleteText: { color: C.danger, fontSize: 11 },
  deleteBox: { marginTop: 10, padding: 14, borderRadius: 13, borderWidth: 1, borderColor: C.danger, backgroundColor: C.panel },
  deleteTitle: { color: C.ink, fontSize: 12, marginBottom: 8 },
  deleteInput: { height: 44, borderRadius: 10, borderWidth: 1, borderColor: C.lineStrong, paddingHorizontal: 12, color: C.ink, fontSize: 14, backgroundColor: C.panelDeep },
  deleteActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  deleteCancel: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: C.lineStrong },
  deleteGo: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: C.danger },
  deleteGoText: { color: C.inverseInk, fontSize: 11, fontWeight: '700' },
  foot: { textAlign: 'center', color: C.muted, fontSize: 8, letterSpacing: 1.4, marginTop: 20 },
}));
