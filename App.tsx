import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, Linking, KeyboardAvoidingView, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import AvatarScene from './src/AvatarScene';
import { GEMMA_MODEL_URL, LainAi } from './modules/lain-ai/src';
import { useDiscoveryFeed, useFollowing, useLainDb, useLikes, usePost, useProfile, useReposts, useSafety, useSession, useSettings } from './src/db/hooks';
import { USERNAME_RULE, checkPassword, findLink, getDb, isVideo, normalizeUsername, pickAvatar, pickPostMedia, shortFingerprint, uploadPrepared, validateUsername, type LinkPreview, type MediaRef, type Post, type PreparedMedia } from './src/db/native';

type Page = 'home' | 'lain' | 'friends' | 'settings';
type LainStatus = 'missing' | 'downloaded' | 'downloading' | 'loading' | 'ready' | 'thinking' | 'listening' | 'processing' | 'speaking' | 'error';
type LainMessage = { id: string; role: 'you' | 'lain'; text: string };
const C = { bg: '#0c0717', panel: '#171025', ink: '#fbf3ff', muted: '#aa9bbf', pink: '#ff4fd8', cyan: '#59f3ff', violet: '#ab7bff', sun: '#ffd36b', line: '#34244b', green: '#79fbd2' };

function Eyebrow({ children }: { children: React.ReactNode }) { return <Text style={styles.eyebrow}>{children}</Text>; }
function Brand() { return <View style={styles.brand}><View style={styles.brandMark}><Text style={styles.brandGlyph}>L</Text></View><View><Text style={styles.brandName}>LAIN <Text style={{ color: C.cyan }}>IO</Text></Text><Text style={styles.brandSub}>LAIN INPUT / OUTPUT</Text></View></View>; }
function Button({ title, onPress, secondary = false, busy = false }: { title: string; onPress: () => void; secondary?: boolean; busy?: boolean }) { return <Pressable onPress={onPress} disabled={busy} style={[styles.button, secondary && styles.buttonSecondary, busy && { opacity: .6 }]}>{busy ? <ActivityIndicator color={secondary ? C.ink : '#190d24'} /> : <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{title}</Text>}</Pressable>; }
function AvatarFace({ avatar, name, textStyle }: { avatar?: string; name: string; textStyle: object }) { const uri = avatar ? getDb().media.resolveUri(avatar) : ''; return uri ? <Image source={{ uri }} resizeMode="cover" style={styles.avatarImage} /> : <Text style={textStyle}>{name[0]?.toUpperCase() ?? '?'}</Text>; }
// ---------- media in posts ----------
function MediaTile({ media, showSensitive, style }: { media: MediaRef; showSensitive: boolean; style: object }) {
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const hidden = media.sensitive && !showSensitive && !revealed;
  const uri = getDb().media.url(media.sha);
  const video = isVideo(media);
  return <View style={[styles.mediaTile, style]}>
    {media.thumb ? <Image source={{ uri: media.thumb }} blurRadius={hidden || failed || !uri ? 25 : 8} style={StyleSheet.absoluteFill} /> : null}
    {!hidden && !failed && uri && !video ? <Image source={{ uri }} resizeMode="cover" onError={() => setFailed(true)} style={StyleSheet.absoluteFill} /> : null}
    {!hidden && !failed && uri && video && playing ? <InlineVideo uri={uri} onError={() => setFailed(true)} /> : null}
    {hidden ? <Pressable onPress={() => setRevealed(true)} style={styles.mediaOverlay}><Text style={styles.mediaOverlayTitle}>SENSITIVE</Text><Text style={styles.mediaOverlayText}>Tap to view</Text></Pressable>
      : failed || !uri ? <View style={styles.mediaOverlay}><Text style={styles.mediaOverlayTitle}>{uri ? 'EXPIRED' : 'REMOVED'}</Text><Text style={styles.mediaOverlayText}>{uri ? 'This file was ephemeral.' : 'Removed by moderation.'}</Text></View>
      : video && !playing ? <Pressable onPress={() => setPlaying(true)} style={styles.mediaOverlay}><Text style={styles.playGlyph}>▶</Text>{media.duration ? <Text style={styles.mediaOverlayText}>{`0:${String(media.duration).padStart(2, '0')}`}</Text> : null}</Pressable> : null}
  </View>;
}
function InlineVideo({ uri, onError }: { uri: string; onError: () => void }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = false; p.play(); });
  useEffect(() => { const sub = player.addListener('statusChange', ({ status }) => { if (status === 'error') onError(); }); return () => sub.remove(); }, [player, onError]);
  return <VideoView player={player} nativeControls contentFit="contain" style={StyleSheet.absoluteFill} />;
}
function MediaGrid({ media, showSensitive }: { media: MediaRef[]; showSensitive: boolean }) {
  if (media.length === 1) {
    const m = media[0];
    const ratio = m.width && m.height ? Math.min(Math.max(m.width / m.height, 0.6), 1.9) : 1.33;
    return <View style={styles.mediaGrid}><MediaTile media={m} showSensitive={showSensitive} style={{ width: '100%', aspectRatio: ratio }} /></View>;
  }
  return <View style={[styles.mediaGrid, styles.mediaGridMulti]}>{media.map((m) => <MediaTile key={m.sha} media={m} showSensitive={showSensitive} style={{ width: '49%', aspectRatio: 1 }} />)}</View>;
}
function LinkCard({ link }: { link: LinkPreview }) {
  return <Pressable onPress={() => void Linking.openURL(link.url)} style={styles.linkCard}>{link.thumbnail ? <View><Image source={{ uri: link.thumbnail }} resizeMode="cover" style={styles.linkThumb} />{link.provider !== 'link' ? <Text style={styles.linkPlay}>▶</Text> : null}</View> : null}<View style={styles.linkMeta}><Text style={styles.linkProvider}>{link.provider === 'youtube' ? 'YOUTUBE' : link.provider === 'peertube' ? 'PEERTUBE' : new URL(link.url).hostname.toUpperCase()}</Text><Text numberOfLines={2} style={styles.linkTitle}>{link.title}</Text>{link.author ? <Text style={styles.linkAuthor}>{link.author}</Text> : null}</View></Pressable>;
}
function PostContent({ post, showSensitive }: { post: Post; showSensitive: boolean }) {
  return <>{post.body ? <Text style={styles.postBody}>{post.body}</Text> : null}{post.media ? <MediaGrid media={post.media} showSensitive={showSensitive} /> : null}{post.link ? <LinkCard link={post.link} /> : null}</>;
}
function RepostedPost({ repostRef, showSensitive }: { repostRef: string; showSensitive: boolean }) {
  const original = usePost(repostRef);
  const author = useProfile(original?.author ?? null);
  if (!original) return <View style={styles.repostBox}><Text style={styles.emptyText}>This post is no longer available.</Text></View>;
  return <View style={styles.repostBox}><Text style={styles.repostAuthor}>{author?.name ?? '…'}  <Text style={styles.handle}>@{author?.username ?? shortFingerprint(original.author)}  ·  {timeAgo(original.createdAt)}</Text></Text><PostContent post={original} showSensitive={showSensitive} /></View>;
}
function timeAgo(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}
function PostCard({ post, showSensitive, me }: { post: Post; showSensitive: boolean; me: string }) {
  const author = useProfile(post.author);
  const target = post.repostOf && !post.body && !post.media && !post.link ? post.repostOf : post.ref;
  const { count, likedByMe, toggle } = useLikes(target);
  const reposts = useReposts(target);
  const ownTarget = target.startsWith(`${me}/`);
  const relay = () => { if (ownTarget) return; reposts.toggle().catch((error: unknown) => Alert.alert('Relay failed', error instanceof Error ? error.message : 'Try again.')); };
  const accent = author?.accent ?? C.violet;
  const name = author?.name ?? author?.username ?? '…';
  const handle = author ? `@${author.username}${author.verified === false ? ' · unverified' : ''}` : `@${shortFingerprint(post.author)}`;
  const like = () => { toggle().catch((error: unknown) => Alert.alert('Like failed', error instanceof Error ? error.message : 'Try again.')); };
  return <View style={styles.postCard}><View style={styles.postHead}><View style={[styles.postAvatar,{borderColor:accent}]}><AvatarFace avatar={author?.avatar} name={name} textStyle={[styles.postAvatarText,{color:accent}]} /></View><View style={{flex:1}}><Text style={styles.postAuthor}>{name}</Text><Text style={styles.handle}>{handle}  ·  {timeAgo(post.createdAt)}{post.editedAt ? ' · edited' : ''}</Text></View><Text style={styles.more}>···</Text></View>{post.repostOf ? <Text style={styles.repostLabel}>↗  RELAYED</Text> : null}<PostContent post={post} showSensitive={showSensitive} />{post.repostOf ? <RepostedPost repostRef={post.repostOf} showSensitive={showSensitive} /> : null}<View style={styles.postActions}><Pressable onPress={like} hitSlop={10}><Text style={[styles.action, likedByMe && { color: C.pink }]}>{likedByMe ? '♥' : '♡'}  {count}</Text></Pressable><Text style={styles.action}>◌</Text><Pressable onPress={relay} disabled={ownTarget} hitSlop={10}><Text style={[styles.action, reposts.repostedByMe && { color: C.cyan }, ownTarget && { opacity: .45 }]}>↗  Relay{reposts.count ? `  ${reposts.count}` : ''}</Text></Pressable><Text style={styles.action}>⌁</Text></View></View>;
}
function FriendRow({ pub }: { pub: string }) {
  const profile = useProfile(pub);
  const name = profile?.name ?? '…';
  const unfollow = () => Alert.alert('Unfollow', `Stop following @${profile?.username ?? shortFingerprint(pub)}?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Unfollow', style: 'destructive', onPress: () => { getDb().social.unfollow(pub).catch(() => {}); } }]);
  return <Pressable onLongPress={unfollow} style={styles.friendRow}><View style={[styles.friendAvatar,{backgroundColor:profile?.accent ?? C.violet}]}><AvatarFace avatar={profile?.avatar} name={name} textStyle={styles.friendLetter} /></View><View style={{flex:1}}><Text style={styles.friendName}>{name}</Text><Text style={styles.friendStatus}>@{profile?.username ?? shortFingerprint(pub)}{profile?.bio ? `  ·  ${profile.bio}` : ''}</Text></View><View style={styles.messageBtn}><Text style={styles.messageBtnText}>↗</Text></View></Pressable>;
}

export default function App() {
  const { ready: dbReady, error: dbError } = useLainDb();
  const session = useSession();
  const [authMode, setAuthMode] = useState<'create' | 'signin'>('create');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [settings, updateSettings] = useSettings();
  const discovery = useDiscoveryFeed();
  const following = useFollowing();
  const safety = useSafety();
  const myProfile = useProfile(session?.pub ?? null);
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState<Page>('home');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const compactLainLayout = page === 'lain' && keyboardVisible;
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PreparedMedia[]>([]);
  const [markSensitive, setMarkSensitive] = useState(false);
  const [posting, setPosting] = useState(false);
  // Preferences live in the encrypted, synced settings document on Gun.
  const saveSetting = (patch: Parameters<typeof updateSettings>[0]) => { updateSettings(patch).catch((error) => Alert.alert('Settings', error instanceof Error ? error.message : 'Could not save.')); };
  const privateMode = settings?.privatePresence ?? true;
  const setPrivateMode = (value: boolean) => saveSetting({ privatePresence: value });
  const quietMode = settings?.quietMode ?? false;
  const setQuietMode = (value: boolean) => saveSetting({ quietMode: value });
  const showActivity = settings?.showActivity ?? true;
  const setShowActivity = (value: boolean) => saveSetting({ showActivity: value });
  const selectedModel = (settings?.selectedModel ?? 'lain-000') as 'lain-000' | 'gemma-4-e2b';
  const setSelectedModel = (value: 'lain-000' | 'gemma-4-e2b') => saveSetting({ selectedModel: value });
  const lainStyle = settings?.lainStyle ?? 'vaporwave';
  const setLainStyle = (value: 'vaporwave' | 'wired') => saveSetting({ lainStyle: value });
  const chooseProfilePhoto = async () => {
    try { await pickAvatar(getDb()); }
    catch (error) { Alert.alert('Profile picture not updated', error instanceof Error ? error.message : 'Please try another photo.'); }
  };
  const showSensitiveMedia = settings?.showSensitiveMedia ?? false;
  const setShowSensitiveMedia = (value: boolean) => {
    if (!value) { saveSetting({ showSensitiveMedia: false }); return; }
    Alert.alert('Show sensitive media?', 'Photos and videos flagged as adult content will show without blur. You must be 18 or older.', [{ text: 'Cancel', style: 'cancel' }, { text: 'I’m 18 or older', onPress: () => saveSetting({ showSensitiveMedia: true }) }]);
  };
  const [lainStatus, setLainStatus] = useState<LainStatus>(LainAi ? 'missing' : 'error');
  const [lainMessages, setLainMessages] = useState<LainMessage[]>([]);
  const [lainDraft, setLainDraft] = useState('');
  const [lainProgress, setLainProgress] = useState(0);
  const [lainError, setLainError] = useState('');
  const lainStatusRef = React.useRef(lainStatus);
  lainStatusRef.current = lainStatus;
  const now = useMemo(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), []);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const sendLainMessage = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt || !LainAi || !['ready', 'listening', 'processing'].includes(lainStatusRef.current)) return;
    setLainMessages((current) => [...current, { id: `${Date.now()}-user`, role: 'you', text: prompt }]);
    setLainDraft('');
    setLainError('');
    setLainStatus('thinking');
    lainStatusRef.current = 'thinking';
    try {
      const answer = await LainAi.generate(prompt);
      if (!answer) throw new Error('Lain returned an empty response. Try a shorter message.');
      setLainMessages((current) => [...current, { id: `${Date.now()}-lain`, role: 'lain', text: answer }]);
      setLainStatus('speaking');
      lainStatusRef.current = 'speaking';
      await LainAi.speak(answer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Lain could not answer right now.';
      setLainError(message.slice(0, 180));
      setLainStatus('error');
    }
  }, []);
  useEffect(() => {
    if (!LainAi) return;
    const stored = LainAi.getModelStatus();
    if (stored.downloaded) setLainStatus('downloaded');
  }, []);
  useEffect(() => {
    if (!LainAi) return;
    const progressSub = LainAi.addListener('onModelDownloadProgress', ({ downloadedBytes, totalBytes }) => {
      setLainProgress(totalBytes > 0 ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) : 0);
    });
    const speechSub = LainAi.addListener('onSpeechResult', ({ text }) => { if (text?.trim()) { lainStatusRef.current = 'ready'; setLainStatus('ready'); void sendLainMessage(text); } });
    const errorSub = LainAi.addListener('onSpeechError', ({ message }) => { setLainError(message || 'Speech recognition stopped.'); });
    const stateSub = LainAi.addListener('onSpeechState', ({ state }) => {
      if (state === 'idle') setLainStatus((current) => { const next = current === 'speaking' ? 'ready' : current === 'processing' ? 'processing' : current === 'listening' ? 'ready' : current; lainStatusRef.current = next; return next; });
      else if (state === 'listening' || state === 'processing' || state === 'speaking') { lainStatusRef.current = state; setLainStatus(state); }
    });
    const doneSub = LainAi.addListener('onSpeechDone', () => { lainStatusRef.current = 'ready'; setLainStatus('ready'); });
    return () => { progressSub.remove(); speechSub.remove(); errorSub.remove(); stateSub.remove(); doneSub.remove(); };
  }, [sendLainMessage]);
  const submitAuth = async () => {
    const nameError = validateUsername(usernameDraft);
    if (nameError) { setUsernameError(nameError); return; }
    if (authMode === 'create') { const pwError = checkPassword(passwordDraft, usernameDraft); if (pwError) { setUsernameError(pwError); return; } }
    else if (!passwordDraft) { setUsernameError('Enter your password.'); return; }
    setAuthBusy(true);
    setUsernameError('');
    try {
      const db = getDb();
      if (authMode === 'create') {
        const result = await db.signUp({ username: usernameDraft, password: passwordDraft, email: emailDraft.trim() || undefined });
        if (result.recoveryCode) Alert.alert('Save your recovery code', `${result.recoveryCode}\n\n${result.emailSent ? 'We also emailed it to you.' : 'Email delivery isn’t available, so write it down now.'} You need it if you forget your password.`);
      } else {
        await db.signIn({ username: usernameDraft, password: passwordDraft });
      }
      setPasswordDraft('');
      setEmailDraft('');
      setPage('home');
    } catch (failure) {
      setUsernameError(failure instanceof Error ? failure.message : 'Something went wrong. Try again.');
    } finally {
      setAuthBusy(false);
    }
  };
  const signOut = () => Alert.alert('Sign out', 'You can sign back in with your username and password on any device.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign out', style: 'destructive', onPress: () => { getDb().signOut().catch(() => {}); setPage('home'); } },
  ]);
  const followPerson = async () => {
    const name = normalizeUsername(searchDraft);
    if (!name) return;
    try {
      const db = getDb();
      const pub = await db.usernames.resolve(name, { fresh: true });
      if (!pub) { Alert.alert('Not found', `No one is called @${name} yet.`); return; }
      if (pub === db.session?.pub) { Alert.alert('That’s you', 'Search for someone else.'); return; }
      await db.social.follow(pub);
      setSearchDraft('');
    } catch (failure) {
      Alert.alert('Follow failed', failure instanceof Error ? failure.message : 'Try again.');
    }
  };

  const prepareLain = async () => {
    if (!LainAi) {
      setLainError('Expo Go cannot run the local model. From the Lain IO folder, run “npm run android” to build and install the Android version, then open Lain IO (not Expo Go).');
      setLainStatus('error');
      return;
    }
    try {
      setLainError('');
      let stored = LainAi.getModelStatus();
      if (!stored.downloaded) {
        setLainStatus('downloading');
        setLainProgress(0);
        stored = { ...stored, path: await LainAi.downloadModel(GEMMA_MODEL_URL), downloaded: true, bytes: 0 };
      }
      setLainStatus('loading');
      const loaded = await LainAi.loadModel(stored.path);
      setLainStatus('ready');
      Alert.alert('Lain is connected', `Gemma 4 E2B is ready on the ${loaded.backend}. You can chat offline.`);
    } catch (error) {
      console.error('[Lain AI] Model download or initialization failed', error);
      const message = error instanceof Error ? error.message : 'The model could not be prepared.';
      setLainError(message.slice(0, 180));
      setLainStatus('error');
    }
  };

  const startLainListening = async () => {
    if (!LainAi) return;
    if (lainStatus === 'listening') {
      await LainAi.stopListening();
      return;
    }
    if (lainStatus !== 'ready') return;
    const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
      setLainError('Microphone permission is needed for voice chat. You can still type to Lain.');
      return;
    }
    try {
      setLainError('');
      await LainAi.startListening();
    } catch (error) {
      setLainError(error instanceof Error ? error.message : 'On-device speech recognition is unavailable.');
    }
  };

  if (!dbReady) return <SafeAreaView style={[styles.safe, styles.centered]}><StatusBar barStyle="light-content" />{dbError ? <Text style={[styles.usernameErrorText, { paddingHorizontal: 26 }]}>{dbError.message}</Text> : <ActivityIndicator color={C.cyan} />}</SafeAreaView>;
  if (!session) return <SafeAreaView style={styles.safe}><StatusBar barStyle="light-content" /><KeyboardAvoidingView behavior="padding" style={styles.keyboardAvoider}><ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
    <View pointerEvents="none" style={styles.ambientPink} /><View pointerEvents="none" style={styles.ambientBlue} />
    <Brand /><View style={styles.loginSpacer} /><Eyebrow>WELCOME TO THE WIRED</Eyebrow><Text style={styles.loginTitle}>Are you{ '\n' }connected?</Text>
    <Text style={styles.loginCopy}>A quieter corner of the network.{ '\n' }Your signal begins here.</Text>
    <View style={styles.signalCard}><View style={styles.signalTop}><View style={styles.pulse} /><Text style={styles.signalLabel}>NETWORK STATUS</Text><Text style={styles.signalLive}>● LIVE</Text></View><View style={styles.wave}>{[20,36,28,48,30,42,18,34,50,27,39,22].map((height, index)=><View key={index} style={[styles.waveBar,{height,backgroundColor:index%3===0?C.cyan:index%3===1?C.pink:C.violet}]} />)}</View><Text style={styles.signalFoot}>“No matter where you go, everyone is connected.”</Text></View>
    <Eyebrow>{authMode === 'create' ? 'CREATE YOUR ACCOUNT' : 'SIGN IN'}</Eyebrow>
    <View style={[styles.usernameField, usernameError ? styles.usernameFieldError : null]}><Text style={styles.usernameAt}>@</Text><TextInput value={usernameDraft} onChangeText={(text) => { setUsernameDraft(text); if (usernameError) setUsernameError(''); }} placeholder="username" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" maxLength={21} returnKeyType="next" accessibilityLabel="Username" style={styles.usernameInput} /></View>
    <View style={[styles.usernameField, usernameError ? styles.usernameFieldError : null]}><TextInput value={passwordDraft} onChangeText={(text) => { setPasswordDraft(text); if (usernameError) setUsernameError(''); }} onSubmitEditing={() => { if (authMode === 'signin') void submitAuth(); }} placeholder={authMode === 'create' ? 'password (12+ characters)' : 'password'} placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={authMode === 'create' ? 'new-password' : 'current-password'} textContentType={authMode === 'create' ? 'newPassword' : 'password'} returnKeyType={authMode === 'create' ? 'next' : 'go'} accessibilityLabel="Password" style={styles.usernameInput} /></View>
    {authMode === 'create' && <View style={styles.usernameField}><TextInput value={emailDraft} onChangeText={setEmailDraft} onSubmitEditing={() => void submitAuth()} placeholder="email for recovery (optional)" placeholderTextColor={C.muted} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" returnKeyType="go" accessibilityLabel="Recovery email (optional)" style={styles.usernameInput} /></View>}
    <Text style={usernameError ? styles.usernameErrorText : styles.usernameHint}>{usernameError || (authMode === 'create' ? USERNAME_RULE : 'Use the username and password you created.')}</Text>
    <Button title={authMode === 'create' ? 'Enter the Wired  →' : 'Sign in  →'} busy={authBusy} onPress={() => void submitAuth()} />
    <Pressable onPress={() => { setAuthMode(authMode === 'create' ? 'signin' : 'create'); setUsernameError(''); }} style={styles.authSwitch}><Text style={styles.authSwitchText}>{authMode === 'create' ? 'ALREADY CONNECTED? SIGN IN' : 'NEW HERE? CREATE AN ACCOUNT'}</Text><Text style={styles.authSwitchArrow}>→</Text></Pressable>
    <Text style={styles.legal}>Email is only used to recover your account. By continuing, you agree to our Terms of Service and Privacy Policy.</Text>
  </ScrollView></KeyboardAvoidingView></SafeAreaView>;

  const attachMedia = async () => {
    try { const picked = await pickPostMedia({ already: attachments.length }); if (picked.length) setAttachments((prev) => [...prev, ...picked]); }
    catch (error) { Alert.alert('Can’t attach', error instanceof Error ? error.message : 'Try another file.'); }
  };
  const submitPost = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || posting) return;
    setPosting(true);
    try {
      const db = getDb();
      const media = await uploadPrepared(db, attachments.map((item) => ({ ...item, sensitive: item.sensitive || markSensitive })));
      const url = findLink(text);
      const link = url ? await db.media.linkPreview(url) : undefined;
      await db.social.createPost(text, { media, link });
      setDraft(''); setAttachments([]); setMarkSensitive(false);
    } catch (error) { Alert.alert('Not transmitted', error instanceof Error ? error.message : 'Try again.'); }
    finally { setPosting(false); }
  };

  const Header = () => <View style={styles.header}><Brand /><Pressable style={styles.avatarSmall} onPress={() => setPage('settings')} accessibilityLabel="Open profile settings"><AvatarFace avatar={myProfile?.avatar} name={myProfile?.name ?? session.username} textStyle={styles.avatarSmallText} /></Pressable></View>;
  const Feed = () => <><View style={styles.greeting}><Eyebrow>FRIDAY, NOVEMBER 6</Eyebrow><Text style={styles.pageTitle}>The Wired<Text style={{color:C.pink}}>.</Text></Text><Text style={styles.pageSub}>A place to exist together.</Text></View>
    <View style={styles.composer}><View style={styles.composeRow}><View style={[styles.avatarSmall,{backgroundColor:'#422052'}]}><AvatarFace avatar={myProfile?.avatar} name={myProfile?.name ?? session.username} textStyle={styles.avatarSmallText} /></View><TextInput value={draft} onChangeText={setDraft} placeholder="What’s on your mind?" placeholderTextColor={C.muted} multiline style={styles.input} /></View>{attachments.length ? <View style={styles.attachRow}>{attachments.map((item, index) => <View key={item.uri} style={styles.attachChip}><Image source={{ uri: item.kind === 'video' ? (item.thumb ?? item.uri) : item.uri }} style={StyleSheet.absoluteFill} />{item.kind === 'video' ? <Text style={styles.attachVideo}>▶</Text> : null}<Pressable onPress={() => setAttachments((prev) => prev.filter((_, i) => i !== index))} hitSlop={8} style={styles.attachRemove}><Text style={styles.attachRemoveText}>✕</Text></Pressable></View>)}<Pressable onPress={() => setMarkSensitive(!markSensitive)} style={[styles.sensitiveChip, markSensitive && styles.sensitiveChipOn]}><Text style={[styles.sensitiveChipText, markSensitive && { color: C.pink }]}>18+</Text></Pressable></View> : null}<View style={styles.composeFoot}><Pressable onPress={() => void attachMedia()} hitSlop={10} disabled={posting}><Text style={styles.composeHint}>▣  PHOTO / VIDEO</Text></Pressable><Pressable onPress={() => void submitPost()} disabled={posting} style={[styles.postBtn, posting && { opacity: .6 }]}>{posting ? <ActivityIndicator color={C.ink} /> : <Text style={styles.postBtnText}>Transmit  ↑</Text>}</Pressable></View></View>
    <View style={styles.sectionHead}><Eyebrow>RECENT SIGNALS</Eyebrow><Text style={styles.liveCount}>◉  2.4k online</Text></View>
    {discovery.items.map((post) => <PostCard key={post.ref} post={post} showSensitive={showSensitiveMedia} me={session.pub} />)}
    {discovery.items.length === 0 && <View style={styles.postCard}>{discovery.loading ? <ActivityIndicator color={C.cyan} /> : <Text style={styles.emptyText}>No signals yet. Transmit the first one.</Text>}</View>}
  </>;

  const Lain = () => <><View style={[styles.modelFrame, compactLainLayout && styles.compactModelFrame, lainStyle==='wired'&&styles.wiredModelFrame]}><View style={styles.modelMeta}><Text style={styles.modelTag}>3D ARCHIVE</Text><Text style={styles.modelStatus}>● {lainStatus === 'listening' ? 'LISTENING' : lainStatus === 'thinking' ? 'THINKING' : lainStatus === 'speaking' ? 'SPEAKING' : 'RENDERING'}</Text></View><AvatarScene animationState={lainStatus} fill={compactLainLayout} visualStyle={lainStyle} /><View style={styles.modelCaption}><Text style={styles.modelName}>Lain</Text></View></View><View style={[styles.aiCard, compactLainLayout && styles.compactAiCard]}><View style={[styles.aiCardHead, compactLainLayout && styles.compactAiCardHead]}><View style={{flex:1}}><Eyebrow>LOCAL INTELLIGENCE</Eyebrow><Text style={styles.aiTitle}>Talk to Lain</Text><Text style={styles.aiCopy}>Gemma 4 E2B runs on this device. Your conversation stays here.</Text></View><View style={styles.aiPulse}><Text style={styles.aiPulseText}>✳</Text></View></View>{lainStatus !== 'ready' && !['thinking','listening','processing','speaking'].includes(lainStatus) ? <Pressable onPress={prepareLain} disabled={lainStatus === 'downloading' || lainStatus === 'loading'} style={styles.aiPrepare}>{lainStatus === 'downloading' || lainStatus === 'loading' ? <ActivityIndicator color={C.cyan} /> : <Text style={styles.aiPrepareIcon}>↓</Text>}<View style={{flex:1}}><Text style={styles.aiPrepareTitle}>{lainStatus === 'downloading' ? `Downloading model · ${lainProgress}%` : lainStatus === 'loading' ? 'Loading Gemma into memory…' : lainStatus === 'downloaded' ? 'Load model into memory' : lainStatus === 'error' ? (!LainAi ? 'Android development build required' : 'Retry local model setup') : 'Download Gemma 4 E2B'}</Text><Text style={styles.aiPrepareDetail}>{lainStatus === 'downloading' ? 'About 2.6 GB · downloaded once' : 'Model download once · speech needs offline voices'}</Text></View><Text style={styles.aiChevron}>›</Text></Pressable> : <><View style={[styles.aiStatus, compactLainLayout && styles.compactAiStatus]}><View style={[styles.aiStatusDot,{backgroundColor:lainStatus==='listening'?C.pink:lainStatus==='thinking'?C.violet:lainStatus==='speaking'?C.cyan:C.green}]} /><Text style={styles.aiStatusText}>{lainStatus === 'listening' ? 'Listening on device' : lainStatus === 'processing' ? 'Transcribing locally…' : lainStatus === 'thinking' ? 'Lain is thinking…' : lainStatus === 'speaking' ? 'Lain is speaking' : 'READY · ON DEVICE'}</Text><Pressable onPress={() => void startLainListening()} style={styles.micButton}><Text style={styles.micText}>{lainStatus === 'listening' ? '■' : '⌁'}</Text></Pressable></View>{lainMessages.slice(compactLainLayout ? -2 : -4).map((message)=><View key={message.id} style={[styles.chatBubble,compactLainLayout&&styles.compactChatBubble,message.role==='you'?styles.chatUser:styles.chatLain]}><Text style={styles.chatRole}>{message.role==='you'?'YOU':'LAIN'}</Text><Text style={[styles.chatText,compactLainLayout&&styles.compactChatText]}>{message.text}</Text></View>)}</>}{lainError ? <Text style={styles.aiError}>{lainError}</Text> : null}</View><View style={[styles.postCard,compactLainLayout&&styles.compactAbout]}><Eyebrow>ABOUT</Eyebrow><Text style={[styles.postBody,{marginTop:12}]}>A quiet student with a presence that reaches far beyond the boundary between the real world and the network.</Text></View></>;

  const Friends = () => <><View style={styles.greeting}><Eyebrow>YOUR NETWORK</Eyebrow><Text style={styles.pageTitle}>Connections</Text><Text style={styles.pageSub}>People across the boundary.</Text></View><View style={styles.search}><Text style={styles.searchIcon}>⌕</Text><TextInput value={searchDraft} onChangeText={setSearchDraft} onSubmitEditing={() => void followPerson()} placeholder="Follow a username, e.g. bob" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={styles.searchInput} /></View><View style={styles.friendSummary}><Text style={styles.friendCount}>{String(following.items.length).padStart(2, '0')} <Text style={styles.friendCountLabel}>FOLLOWING</Text></Text><Text style={styles.liveCount}>LONG-PRESS TO UNFOLLOW</Text></View>{following.items.map((pub) => <FriendRow key={pub} pub={pub} />)}{following.items.length === 0 && !following.loading && <Text style={[styles.emptyText, { marginVertical: 18 }]}>You’re not following anyone yet. Search a username above.</Text>}<Button title="＋  Follow" secondary onPress={() => void followPerson()} /></>;

  const Settings = () => <><View style={styles.greeting}><Eyebrow>PREFERENCES</Eyebrow><Text style={styles.pageTitle}>Settings</Text><Text style={styles.pageSub}>Tune your presence in the Wired.</Text></View><Pressable style={styles.settingsProfile} onPress={() => void chooseProfilePhoto()} accessibilityRole='button' accessibilityLabel='Choose profile picture'><View style={[styles.friendAvatar,{backgroundColor:'#542567',width:54,height:54}]}><AvatarFace avatar={myProfile?.avatar} name={myProfile?.name ?? session.username} textStyle={styles.friendLetter} /><View style={styles.photoBadge}><Text style={styles.photoBadgeText}>✎</Text></View></View><View style={{flex:1}}><Text style={styles.friendName}>{myProfile?.name ?? session.username}</Text><Text style={styles.friendStatus}>@{session.username}  ·  {shortFingerprint(session.pub)}</Text><Text style={styles.photoHint}>TAP TO CHANGE · PUBLIC PROFILE</Text></View><Text style={styles.chevron}>›</Text></Pressable><Eyebrow>LAIN'S MIND</Eyebrow><Text style={styles.sectionHint}>Choose the model profile for your Lain.</Text><View style={styles.choiceGroup}>{([{id:'lain-000',name:'lain-000',tag:'PERSONAL BASELINE',detail:'A fresh Lain profile, designed to become more personal over time.'},{id:'gemma-4-e2b',name:'Gemma 4 E2B',tag:'ON-DEVICE ENGINE',detail:'Runs locally on this device. Private and offline.'}] as const).map((model)=><Pressable key={model.id} accessibilityRole="radio" accessibilityState={{selected:selectedModel===model.id}} onPress={()=>setSelectedModel(model.id)} style={[styles.modelChoice,selectedModel===model.id&&styles.modelChoiceSelected]}><View style={styles.choiceTop}><Text style={styles.choiceName}>{model.name}</Text><View style={[styles.radioOuter,selectedModel===model.id&&styles.radioSelected]}>{selectedModel===model.id&&<View style={styles.radioInner}/>}</View></View><Text style={styles.choiceTag}>{model.tag}</Text><Text style={styles.choiceDetail}>{model.detail}</Text></Pressable>)}</View><View style={styles.learningNote}><Text style={styles.learningGlyph}>✳</Text><Text style={styles.learningCopy}>Personalization is a future feature. This preview does not learn from or save your behavior yet; local chat still uses Gemma 4 E2B.</Text></View><Eyebrow>LAIN'S APPEARANCE</Eyebrow><Text style={styles.sectionHint}>Choose how Lain looks in your space.</Text><View style={styles.styleChoices}>{([{id:'vaporwave',icon:'🌆',name:'Vaporwave',sub:'NEON · DREAMLIKE'},{id:'wired',icon:'◈',name:'The Wired',sub:'COOL · MINIMAL'}] as const).map((style)=><Pressable key={style.id} accessibilityRole="radio" accessibilityState={{selected:lainStyle===style.id}} onPress={()=>setLainStyle(style.id)} style={[styles.styleChoice,lainStyle===style.id&&styles.styleChoiceSelected]}><Text style={styles.styleEmoji}>{style.icon}</Text><Text style={styles.styleName}>{style.name}</Text><Text style={styles.styleSub}>{style.sub}</Text>{lainStyle===style.id&&<Text style={styles.styleActive}>ACTIVE</Text>}</Pressable>)}</View><Eyebrow>PRIVACY & PRESENCE</Eyebrow><View style={styles.settingGroup}><SettingRow label="Private presence" detail="Only connections can see when you’re online" value={privateMode} onChange={setPrivateMode}/><SettingRow label="Quiet mode" detail="Pause notifications and mentions" value={quietMode} onChange={setQuietMode}/><SettingRow label="Show activity status" detail="Let others see when you’re active" value={showActivity} onChange={setShowActivity}/><SettingRow label="Show sensitive media" detail="Photos and videos flagged as adult content stay blurred until you tap them" value={showSensitiveMedia} onChange={setShowSensitiveMedia}/></View><Eyebrow>ACCOUNT</Eyebrow><View style={styles.settingGroup}><SettingLink label="Username" value={`@${session.username}`}/><SettingLink label="Sync & storage" value={`GunDB · ${(getDb().ctx.config.peers[0] ?? 'no relay').replace(/^\w+:\/\//, '').replace(/\/gun$/, '')}`}/><SettingLink label="Blocked connections" value={String(Object.keys(safety?.blocked ?? {}).length)}/><SettingLink label="About Lain IO" value="Version 1.0.0"/></View><Pressable style={styles.signout} onPress={signOut}><Text style={styles.signoutText}>Sign out</Text></Pressable><Text style={styles.settingsFoot}>LAIN INPUT / OUTPUT  ·  {now}</Text></>;

  // These page renderers are closure-based and contain no hooks. Invoke them
  // directly so their enclosing App render does not replace their component
  // type on each keystroke or download-progress update.
  const content = page === 'home' ? Feed() : page === 'lain' ? Lain() : page === 'friends' ? Friends() : Settings();
  // Android runs edge-to-edge (gradle.properties), so adjustResize no longer shrinks the
  // window for the keyboard; pad the content ourselves on both platforms instead.
  return <SafeAreaView style={styles.safe}><StatusBar barStyle="light-content" /><KeyboardAvoidingView behavior="padding" style={styles.keyboardAvoider}>{!compactLainLayout&&<Header/>}<ScrollView key={page} style={styles.mainScroll} contentContainerStyle={[styles.scrollContent,compactLainLayout&&styles.keyboardScrollContent]} scrollEnabled={!compactLainLayout} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{content}</ScrollView>{page==='lain'&&<View style={[styles.lainComposerDock,compactLainLayout&&styles.keyboardLainComposerDock]}><TextInput value={lainDraft} onChangeText={setLainDraft} placeholder={lainStatus==='ready'?"Message Lain…":"Download Gemma to start chatting"} placeholderTextColor={C.muted} multiline style={styles.lainDockInput} editable={lainStatus==='ready'} onSubmitEditing={()=>void sendLainMessage(lainDraft)} /><Pressable onPress={()=>void sendLainMessage(lainDraft)} disabled={!lainDraft.trim()||lainStatus!=='ready'} style={[styles.aiSend,(!lainDraft.trim()||lainStatus!=='ready')&&styles.aiSendDisabled]}><Text style={styles.aiSendText}>↑</Text></Pressable></View>}<View style={[styles.tabBar,compactLainLayout&&styles.hiddenWhileTyping]}>{([{id:'home',icon:'📰',label:'Feed'},{id:'lain',icon:'🌀',label:'Lain'},{id:'friends',icon:'👥',label:'Friends'},{id:'settings',icon:'⚙️',label:'Settings'}] as {id:Page;icon:string;label:string}[]).map(tab=><Pressable key={tab.id} onPress={()=>setPage(tab.id)} style={styles.tab}><Text style={[styles.tabIcon,page===tab.id&&styles.tabActive]}>{tab.icon}</Text><Text style={[styles.tabLabel,page===tab.id&&styles.tabLabelActive]}>{tab.label}</Text>{page===tab.id&&<View style={styles.tabIndicator}/>}</Pressable>)}</View></KeyboardAvoidingView></SafeAreaView>;
}

function SettingRow({ label, detail, value, onChange }: {label:string;detail:string;value:boolean;onChange:(value:boolean)=>void}) { return <Pressable style={styles.settingRow} onPress={()=>onChange(!value)}><View style={{flex:1,paddingRight:14}}><Text style={styles.settingLabel}>{label}</Text><Text style={styles.settingDetail}>{detail}</Text></View><View style={[styles.toggle,value&&styles.toggleOn]}><View style={[styles.toggleKnob,value&&styles.toggleKnobOn]}/></View></Pressable>; }
function SettingLink({label,value}:{label:string;value:string}) { return <Pressable style={styles.settingRow}><View style={{flex:1}}><Text style={styles.settingLabel}>{label}</Text></View><Text style={styles.settingValue}>{value}</Text><Text style={styles.chevron}>›</Text></Pressable>; }

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:C.bg,paddingTop:Platform.OS==='android'?StatusBar.currentHeight:0},
  loginWrap:{flexGrow:1,paddingHorizontal:26,paddingTop:28,paddingBottom:28},
  ambientPink:{position:'absolute',width:230,height:230,borderRadius:120,backgroundColor:'#28103e',top:115,right:-145},
  ambientBlue:{position:'absolute',width:190,height:190,borderRadius:100,backgroundColor:'#111d3c',top:430,left:-140},
  brand:{flexDirection:'row',alignItems:'center',gap:11},brandMark:{width:38,height:38,borderRadius:12,backgroundColor:C.pink,alignItems:'center',justifyContent:'center',shadowColor:C.pink,shadowOpacity:.5,shadowRadius:14},brandGlyph:{fontSize:23,fontWeight:'800',color:'#fff'},brandName:{color:C.ink,fontSize:15,fontWeight:'800',letterSpacing:2.1},brandSub:{color:C.muted,fontSize:8,letterSpacing:1.7,marginTop:3},loginSpacer:{height:62},eyebrow:{color:C.violet,fontSize:9,fontWeight:'700',letterSpacing:1.8},loginTitle:{color:C.ink,fontSize:48,lineHeight:50,fontWeight:'700',letterSpacing:-2,marginTop:13,textShadowColor:'#e850e0',textShadowRadius:18},loginCopy:{fontSize:14,lineHeight:22,color:'#c8b8df',marginTop:14},
  signalCard:{borderRadius:18,backgroundColor:C.panel,borderWidth:1,borderColor:'#754c94',padding:16,marginTop:27,marginBottom:23,shadowColor:C.violet,shadowOpacity:.16,shadowRadius:16},signalTop:{flexDirection:'row',alignItems:'center'},pulse:{width:7,height:7,borderRadius:5,backgroundColor:C.pink,marginRight:8,shadowColor:C.pink,shadowOpacity:1,shadowRadius:8},signalLabel:{color:C.muted,fontSize:9,letterSpacing:1.5,fontWeight:'700',flex:1},signalLive:{color:C.green,fontSize:9,fontWeight:'700'},wave:{height:58,flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginVertical:9,paddingHorizontal:4},waveBar:{width:3,borderRadius:4,backgroundColor:C.pink,opacity:.9},signalFoot:{color:'#c6b7d6',fontSize:10,fontStyle:'italic'},
  button:{height:52,borderRadius:13,backgroundColor:C.pink,alignItems:'center',justifyContent:'center',marginBottom:10,shadowColor:C.pink,shadowOpacity:.25,shadowRadius:12},buttonSecondary:{backgroundColor:'#211536',borderWidth:1,borderColor:'#5b3b78'},buttonText:{fontSize:14,fontWeight:'700',color:'#190d24'},buttonTextSecondary:{color:C.ink},usernameField:{height:52,flexDirection:'row',alignItems:'center',borderRadius:13,backgroundColor:C.panel,borderWidth:1,borderColor:'#5b3b78',paddingHorizontal:14,marginTop:10},usernameFieldError:{borderColor:'#ff9cd7'},usernameAt:{color:C.cyan,fontSize:16,fontWeight:'700',marginRight:4},usernameInput:{flex:1,color:C.ink,fontSize:15},usernameHint:{color:C.muted,fontSize:9,marginTop:7,marginBottom:14},centered:{alignItems:'center',justifyContent:'center'},authSwitch:{height:48,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10},authSwitchText:{fontSize:10,fontWeight:'700',letterSpacing:1.4,color:'#d8c9ea'},authSwitchArrow:{color:C.cyan,fontSize:16},emptyText:{color:C.muted,fontSize:12,textAlign:'center'},usernameErrorText:{color:'#ff9cd7',fontSize:9,marginTop:7,marginBottom:14},legal:{textAlign:'center',fontSize:9,color:'#82728f',lineHeight:15,marginTop:8},
  header:{height:66,paddingHorizontal:22,borderBottomWidth:1,borderBottomColor:C.line,backgroundColor:'#100a1b',flexDirection:'row',alignItems:'center',justifyContent:'space-between'},avatarSmall:{width:34,height:34,borderRadius:12,backgroundColor:'#542567',borderWidth:1,borderColor:C.pink,alignItems:'center',justifyContent:'center',overflow:'hidden'},avatarSmallText:{color:'#fff',fontWeight:'700'},avatarImage:{...StyleSheet.absoluteFill,borderRadius:12},scrollContent:{paddingHorizontal:20,paddingTop:21,paddingBottom:28},greeting:{marginBottom:20},pageTitle:{color:C.ink,fontSize:31,fontWeight:'700',letterSpacing:-.8,marginTop:8},pageSub:{color:'#bcaed0',fontSize:12,marginTop:5},
  composer:{padding:14,borderRadius:16,backgroundColor:C.panel,borderWidth:1,borderColor:'#50346c',marginBottom:25},composeRow:{flexDirection:'row',gap:11,alignItems:'flex-start'},input:{color:C.ink,minHeight:47,flex:1,fontSize:13,paddingTop:8,textAlignVertical:'top'},composeFoot:{borderTopWidth:1,borderColor:C.line,marginTop:8,paddingTop:11,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},composeHint:{fontSize:8,letterSpacing:1.2,color:C.cyan,fontWeight:'700'},postBtn:{backgroundColor:'#49204f',borderRadius:9,paddingVertical:8,paddingHorizontal:12},postBtnText:{color:C.pink,fontSize:10,fontWeight:'700'},sectionHead:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12},liveCount:{fontSize:9,color:C.green,fontWeight:'600'},
  mediaGrid:{marginTop:12,borderRadius:12,overflow:'hidden'},mediaGridMulti:{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',rowGap:6,borderRadius:0},mediaTile:{borderRadius:12,overflow:'hidden',backgroundColor:'#211536'},mediaOverlay:{position:'absolute',top:0,left:0,right:0,bottom:0,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(12,7,23,.35)'},mediaOverlayTitle:{color:C.ink,fontSize:10,letterSpacing:2,fontWeight:'800'},mediaOverlayText:{color:C.muted,fontSize:10,marginTop:4},playGlyph:{color:C.ink,fontSize:30},
  linkCard:{marginTop:12,borderRadius:12,borderWidth:1,borderColor:C.line,overflow:'hidden',backgroundColor:'#120b1e'},linkThumb:{width:'100%',aspectRatio:16/9},linkPlay:{position:'absolute',alignSelf:'center',top:'38%',color:C.ink,fontSize:28},linkMeta:{padding:11},linkProvider:{color:C.cyan,fontSize:8,letterSpacing:1.6,fontWeight:'800'},linkTitle:{color:C.ink,fontSize:13,fontWeight:'700',marginTop:4},linkAuthor:{color:C.muted,fontSize:11,marginTop:2},
  repostLabel:{color:C.cyan,fontSize:8,letterSpacing:1.6,fontWeight:'800',marginTop:10},repostBox:{marginTop:10,borderRadius:12,borderWidth:1,borderColor:C.line,padding:11},repostAuthor:{color:C.ink,fontSize:12,fontWeight:'700'},
  attachRow:{flexDirection:'row',gap:8,marginTop:12,alignItems:'center',flexWrap:'wrap'},attachChip:{width:58,height:58,borderRadius:10,overflow:'hidden',backgroundColor:'#211536',borderWidth:1,borderColor:C.line},attachVideo:{position:'absolute',alignSelf:'center',top:16,color:C.ink,fontSize:18},attachRemove:{position:'absolute',top:3,right:3,width:18,height:18,borderRadius:9,backgroundColor:'rgba(12,7,23,.8)',alignItems:'center',justifyContent:'center'},attachRemoveText:{color:C.ink,fontSize:9},sensitiveChip:{height:30,paddingHorizontal:10,borderRadius:15,borderWidth:1,borderColor:C.line,justifyContent:'center'},sensitiveChipOn:{borderColor:C.pink},sensitiveChipText:{color:C.muted,fontSize:10,fontWeight:'800',letterSpacing:1},
  postCard:{backgroundColor:C.panel,borderRadius:16,borderWidth:1,borderColor:C.line,padding:15,marginBottom:11},postHead:{flexDirection:'row',alignItems:'center',gap:10},postAvatar:{width:37,height:37,borderRadius:13,borderWidth:1,backgroundColor:'#211536',alignItems:'center',justifyContent:'center',overflow:'hidden'},postAvatarText:{fontSize:15,fontWeight:'800'},postAuthor:{color:C.ink,fontSize:12,fontWeight:'700'},handle:{fontSize:9,color:C.muted,marginTop:3},more:{color:C.violet,fontSize:19,marginTop:-8},postBody:{color:'#e6daf2',fontSize:13,lineHeight:21,marginTop:14},postActions:{borderTopWidth:1,borderColor:C.line,marginTop:15,paddingTop:12,flexDirection:'row',justifyContent:'space-between'},action:{fontSize:10,color:C.muted},quoteCard:{borderRadius:16,backgroundColor:'#211333',padding:18,marginTop:7,borderLeftWidth:2,borderLeftColor:C.cyan},quoteMark:{color:C.pink,fontSize:35,lineHeight:36},quote:{color:'#f0e4fc',fontSize:16,lineHeight:23,fontStyle:'italic',marginTop:-5},quoteBy:{fontSize:8,color:C.violet,letterSpacing:1.4,marginTop:13},
  modelFrame:{borderRadius:18,overflow:'hidden',backgroundColor:'#10091e',borderWidth:1,borderColor:'#75509a',shadowColor:C.violet,shadowOpacity:.2,shadowRadius:16},wiredModelFrame:{backgroundColor:'#07121c',borderColor:'#3b7180'},modelMeta:{position:'absolute',zIndex:2,left:14,right:14,top:14,flexDirection:'row',justifyContent:'space-between'},modelTag:{color:C.cyan,fontSize:8,letterSpacing:1.4,fontWeight:'700'},modelStatus:{color:C.green,fontSize:8,fontWeight:'700'},modelCaption:{position:'absolute',zIndex:2,bottom:12,left:14,right:14,flexDirection:'row',alignItems:'flex-end',justifyContent:'space-between'},modelName:{color:'#fff',fontSize:20,fontWeight:'700',textShadowColor:C.pink,textShadowRadius:12},modelHint:{color:'#bd9ee8',fontSize:7,letterSpacing:1.2},
  aiCard:{backgroundColor:'#171025',borderWidth:1,borderColor:'#604179',borderRadius:17,padding:15,marginBottom:13,shadowColor:C.violet,shadowOpacity:.12,shadowRadius:12},aiCardHead:{flexDirection:'row',alignItems:'center'},aiTitle:{color:C.ink,fontSize:18,fontWeight:'700',marginTop:6},aiCopy:{color:C.muted,fontSize:10,lineHeight:15,marginTop:5,maxWidth:245},aiPulse:{width:38,height:38,borderRadius:13,backgroundColor:'#302044',borderWidth:1,borderColor:'#65427c',alignItems:'center',justifyContent:'center'},aiPulseText:{fontSize:22,color:C.pink},aiPrepare:{minHeight:58,backgroundColor:'#211536',borderWidth:1,borderColor:'#52366a',borderRadius:12,marginTop:15,paddingHorizontal:13,flexDirection:'row',alignItems:'center',gap:11},aiPrepareIcon:{color:C.cyan,fontSize:20,fontWeight:'700'},aiPrepareTitle:{color:C.ink,fontSize:11,fontWeight:'700'},aiPrepareDetail:{color:C.muted,fontSize:8,marginTop:4},aiChevron:{color:C.cyan,fontSize:23},aiStatus:{height:38,flexDirection:'row',alignItems:'center',gap:7,marginTop:14,borderTopWidth:1,borderColor:C.line,paddingTop:11},aiStatusDot:{width:7,height:7,borderRadius:5},aiStatusText:{color:C.muted,fontSize:8,fontWeight:'700',letterSpacing:1,flex:1},micButton:{height:32,width:32,borderRadius:10,backgroundColor:'#422047',borderWidth:1,borderColor:C.pink,alignItems:'center',justifyContent:'center'},micText:{color:C.pink,fontSize:21},chatBubble:{maxWidth:'92%',padding:11,borderRadius:12,marginTop:9},chatUser:{alignSelf:'flex-end',backgroundColor:'#342044',borderWidth:1,borderColor:'#664378'},chatLain:{alignSelf:'flex-start',backgroundColor:'#111a2c',borderWidth:1,borderColor:'#31505f'},chatRole:{color:C.cyan,fontSize:7,letterSpacing:1.2,fontWeight:'800',marginBottom:5},chatText:{color:C.ink,fontSize:11,lineHeight:17},aiCompose:{flexDirection:'row',alignItems:'flex-end',gap:8,marginTop:12},aiInput:{minHeight:42,maxHeight:100,flex:1,color:C.ink,fontSize:11,backgroundColor:'#100a1b',borderWidth:1,borderColor:C.line,borderRadius:11,paddingHorizontal:11,paddingVertical:9,textAlignVertical:'top'},aiSend:{height:40,width:40,borderRadius:11,backgroundColor:C.pink,alignItems:'center',justifyContent:'center'},aiSendDisabled:{opacity:.4},aiSendText:{fontSize:21,color:'#190d24',fontWeight:'800'},aiError:{color:'#ff9cd7',fontSize:9,lineHeight:14,marginTop:9},
  search:{height:45,borderRadius:12,backgroundColor:C.panel,borderWidth:1,borderColor:'#50346c',flexDirection:'row',alignItems:'center',paddingHorizontal:13,marginBottom:18},searchIcon:{fontSize:22,color:C.cyan,marginRight:8},searchInput:{color:C.ink,fontSize:12,flex:1},friendSummary:{flexDirection:'row',alignItems:'baseline',justifyContent:'space-between',marginBottom:13},friendCount:{color:C.ink,fontSize:19,fontWeight:'700'},friendCountLabel:{fontSize:8,color:C.violet,letterSpacing:1.2},friendRow:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:13,borderBottomWidth:1,borderColor:C.line},friendAvatar:{width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center',overflow:'hidden'},friendLetter:{color:'#fff',fontWeight:'800',fontSize:16},onlineDot:{position:'absolute',width:9,height:9,borderRadius:5,borderWidth:2,borderColor:C.bg,bottom:0,right:0},friendName:{color:C.ink,fontSize:12,fontWeight:'700'},friendStatus:{color:C.muted,fontSize:9,marginTop:4},messageBtn:{width:32,height:32,borderRadius:10,borderWidth:1,borderColor:'#5b3b78',alignItems:'center',justifyContent:'center'},messageBtnText:{color:C.cyan},
  settingsProfile:{flexDirection:'row',alignItems:'center',gap:12,padding:14,backgroundColor:C.panel,borderRadius:15,borderWidth:1,borderColor:'#50346c',marginBottom:24},photoBadge:{position:'absolute',right:-2,bottom:-2,width:20,height:20,borderRadius:10,backgroundColor:C.pink,alignItems:'center',justifyContent:'center',borderWidth:2,borderColor:C.panel},photoBadgeText:{color:'#190d24',fontSize:11,fontWeight:'800'},photoHint:{fontSize:7,color:C.cyan,letterSpacing:1,marginTop:5},edit:{color:C.cyan,fontSize:8,fontWeight:'800',letterSpacing:1},sectionHint:{fontSize:10,color:C.muted,marginTop:6,marginBottom:10},choiceGroup:{gap:9,marginBottom:14},modelChoice:{padding:13,borderRadius:13,backgroundColor:C.panel,borderWidth:1,borderColor:C.line},modelChoiceSelected:{borderColor:C.pink,backgroundColor:'#21132e'},choiceTop:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},choiceName:{fontSize:13,color:C.ink,fontWeight:'700'},choiceTag:{fontSize:7,color:C.cyan,letterSpacing:1.3,fontWeight:'800',marginTop:5},choiceDetail:{fontSize:9,lineHeight:14,color:C.muted,marginTop:6,paddingRight:20},radioOuter:{height:18,width:18,borderRadius:9,borderWidth:1.5,borderColor:'#756288',alignItems:'center',justifyContent:'center'},radioSelected:{borderColor:C.pink},radioInner:{height:8,width:8,borderRadius:4,backgroundColor:C.pink},learningNote:{flexDirection:'row',alignItems:'flex-start',gap:9,padding:12,marginBottom:24,borderRadius:12,backgroundColor:'#131125',borderWidth:1,borderColor:'#38305d'},learningGlyph:{fontSize:15,color:C.cyan},learningCopy:{flex:1,fontSize:9,lineHeight:14,color:'#c3b6d8'},styleChoices:{flexDirection:'row',gap:9,marginBottom:25},styleChoice:{flex:1,minHeight:104,padding:11,borderRadius:13,backgroundColor:C.panel,borderWidth:1,borderColor:C.line},styleChoiceSelected:{borderColor:C.cyan,backgroundColor:'#16182b'},styleEmoji:{fontSize:19,marginBottom:7,color:C.violet},styleName:{fontSize:11,color:C.ink,fontWeight:'700'},styleSub:{fontSize:6.5,color:C.muted,letterSpacing:.8,marginTop:4},styleActive:{fontSize:7,color:C.cyan,fontWeight:'800',letterSpacing:1,marginTop:8},settingGroup:{backgroundColor:C.panel,borderRadius:14,borderWidth:1,borderColor:C.line,marginTop:11,marginBottom:23,overflow:'hidden'},settingRow:{minHeight:58,flexDirection:'row',alignItems:'center',paddingHorizontal:14,borderBottomWidth:1,borderColor:C.line},settingLabel:{fontSize:11,color:C.ink,fontWeight:'600'},settingDetail:{fontSize:9,color:C.muted,marginTop:4},toggle:{width:36,height:21,borderRadius:12,backgroundColor:'#41334f',justifyContent:'center',padding:2},toggleOn:{backgroundColor:'#8b2f88'},toggleKnob:{width:17,height:17,borderRadius:9,backgroundColor:'#b9a8cb'},toggleKnobOn:{alignSelf:'flex-end',backgroundColor:C.cyan},settingValue:{fontSize:9,color:C.muted},chevron:{fontSize:19,color:C.violet,marginLeft:10},signout:{height:44,alignItems:'center',justifyContent:'center',borderRadius:12,borderWidth:1,borderColor:'#823d87',marginTop:3},signoutText:{color:C.pink,fontSize:11,fontWeight:'600'},settingsFoot:{textAlign:'center',color:'#82728f',fontSize:8,letterSpacing:1.4,marginTop:20},
  tabBar:{height:66,marginBottom:40,borderTopWidth:1,borderColor:C.line,backgroundColor:'#100a1b',flexDirection:'row',paddingBottom:4},tab:{flex:1,alignItems:'center',justifyContent:'center',gap:3,position:'relative'},tabIcon:{fontSize:20,color:'#82728f'},tabActive:{color:C.cyan,textShadowColor:C.cyan,textShadowRadius:10},tabLabel:{fontSize:8,color:'#82728f'},tabLabelActive:{color:C.ink},tabIndicator:{position:'absolute',top:0,width:22,height:2,borderRadius:2,backgroundColor:C.pink,shadowColor:C.pink,shadowOpacity:.9,shadowRadius:7},
  keyboardAvoider:{flex:1},
  keyboardScrollContent:{flexGrow:1,paddingHorizontal:0,paddingTop:0,paddingBottom:0},
  compactModelFrame:{flex:1,width:'100%',minHeight:0,marginBottom:0,borderRadius:0,borderWidth:0},compactAiCard:{display:'none'},compactAiCardHead:{display:'none'},compactAiStatus:{height:28,marginTop:0,paddingTop:0,borderTopWidth:0},compactChatBubble:{maxWidth:'100%',padding:7,marginTop:5},compactChatText:{fontSize:10,lineHeight:13},compactAiCompose:{gap:5,marginTop:6},compactAiInput:{minHeight:38,maxHeight:70,paddingHorizontal:8,paddingVertical:6,fontSize:10},compactAiSend:{height:34,width:34},compactAbout:{display:'none'},hiddenWhileTyping:{display:'none'},
  mainScroll:{flex:1},
  lainComposerDock:{minHeight:54,flexDirection:'row',alignItems:'flex-end',gap:8,marginHorizontal:14,marginTop:7,marginBottom:8,padding:7,backgroundColor:C.panel,borderWidth:1,borderColor:'#604179',borderRadius:16},
  keyboardLainComposerDock:{marginHorizontal:8,marginTop:6,marginBottom:6,padding:6},
  lainDockInput:{minHeight:40,maxHeight:92,flex:1,color:C.ink,fontSize:12,backgroundColor:'#100a1b',borderWidth:1,borderColor:C.line,borderRadius:12,paddingHorizontal:11,paddingVertical:8,textAlignVertical:'top'},
});
