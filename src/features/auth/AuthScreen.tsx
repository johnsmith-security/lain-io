import { themedStyles } from '../../theme/themedStyles';
// Sign up (username + password, optional recovery email) or sign in.
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { USERNAME_RULE, checkPassword, getDb, validateUsername } from '../../db/native';
import { errorMessage } from '../../lib/alerts';
import { C } from '../../theme/colors';
import { Brand } from '../../ui/Brand';
import { Button } from '../../ui/Button';
import { Eyebrow } from '../../ui/Eyebrow';
import { SignalCard } from './SignalCard';

type Mode = 'create' | 'signin';

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = mode === 'create';

  const submit = async () => {
    const nameError = validateUsername(username);
    if (nameError) { setError(nameError); return; }
    if (creating) { const pwError = checkPassword(password, username); if (pwError) { setError(pwError); return; } }
    else if (!password) { setError('Enter your password.'); return; }
    setBusy(true);
    setError('');
    try {
      const db = getDb();
      if (creating) {
        const result = await db.signUp({ username, password, email: email.trim() || undefined });
        if (result.recoveryCode) {
          Alert.alert('Save your recovery code', `${result.recoveryCode}\n\n${result.emailSent ? 'We also emailed it to you.' : 'Email delivery isn’t available, so write it down now.'} You need it if you forget your password.`);
        }
      } else {
        await db.signIn({ username, password });
      }
      setPassword('');
      setEmail('');
    } catch (failure) {
      setError(errorMessage(failure, 'Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  const edit = (setter: (value: string) => void) => (text: string) => { setter(text); if (error) setError(''); };

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View pointerEvents="none" style={styles.ambientPink} />
      <View pointerEvents="none" style={styles.ambientBlue} />
      <Brand />
      <View style={styles.spacer} />
      <Eyebrow>WELCOME TO THE WIRED</Eyebrow>
      <Text style={styles.title}>Are you{'\n'}connected?</Text>
      <Text style={styles.copy}>A quieter corner of the network.{'\n'}Your signal begins here.</Text>
      <SignalCard />

      <Eyebrow>{creating ? 'CREATE YOUR ACCOUNT' : 'SIGN IN'}</Eyebrow>
      <View style={[styles.field, error ? styles.fieldError : null]}>
        <Text style={styles.at}>@</Text>
        <TextInput value={username} onChangeText={edit(setUsername)} placeholder="username" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" maxLength={21} returnKeyType="next" accessibilityLabel="Username" style={styles.input} />
      </View>
      <View style={[styles.field, error ? styles.fieldError : null]}>
        <TextInput value={password} onChangeText={edit(setPassword)} onSubmitEditing={() => { if (!creating) void submit(); }} placeholder={creating ? 'password (12+ characters)' : 'password'} placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={creating ? 'new-password' : 'current-password'} textContentType={creating ? 'newPassword' : 'password'} returnKeyType={creating ? 'next' : 'go'} accessibilityLabel="Password" style={styles.input} />
      </View>
      {creating && (
        <View style={styles.field}>
          <TextInput value={email} onChangeText={setEmail} onSubmitEditing={() => void submit()} placeholder="email for recovery (optional)" placeholderTextColor={C.muted} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" returnKeyType="go" accessibilityLabel="Recovery email (optional)" style={styles.input} />
        </View>
      )}
      <Text style={error ? styles.error : styles.hint}>{error || (creating ? USERNAME_RULE : 'Use the username and password you created.')}</Text>
      <Button title={creating ? 'Enter the Wired  →' : 'Sign in  →'} busy={busy} onPress={() => void submit()} />
      <Pressable onPress={() => { setMode(creating ? 'signin' : 'create'); setError(''); }} style={styles.switch}>
        <Text style={styles.switchText}>{creating ? 'ALREADY CONNECTED? SIGN IN' : 'NEW HERE? CREATE AN ACCOUNT'}</Text>
        <Text style={styles.switchArrow}>→</Text>
      </Pressable>
      <Text style={styles.legal}>Email is only used to recover your account. By continuing, you agree to our Terms of Service and Privacy Policy.</Text>
    </ScrollView>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  wrap: { flexGrow: 1, paddingHorizontal: 26, paddingTop: 28, paddingBottom: 28 },
  ambientPink: { position: 'absolute', width: 230, height: 230, borderRadius: 120, backgroundColor: C.panelRaised, top: 115, right: -145 },
  ambientBlue: { position: 'absolute', width: 190, height: 190, borderRadius: 100, backgroundColor: C.panelDeep, top: 430, left: -140 },
  spacer: { height: 62 },
  title: { color: C.ink, fontSize: 48, lineHeight: 50, fontWeight: '700', letterSpacing: -2, marginTop: 13, textShadowColor: C.pink, textShadowRadius: 18 },
  copy: { fontSize: 14, lineHeight: 22, color: C.muted, marginTop: 14 },
  field: { height: 52, flexDirection: 'row', alignItems: 'center', borderRadius: 13, backgroundColor: C.panel, borderWidth: 1, borderColor: C.lineStrong, paddingHorizontal: 14, marginTop: 10 },
  fieldError: { borderColor: C.danger },
  at: { color: C.cyan, fontSize: 16, fontWeight: '700', marginRight: 4 },
  input: { flex: 1, color: C.ink, fontSize: 15 },
  hint: { color: C.muted, fontSize: 9, marginTop: 7, marginBottom: 14 },
  error: { color: C.danger, fontSize: 9, marginTop: 7, marginBottom: 14 },
  switch: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  switchText: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: C.ink },
  switchArrow: { color: C.cyan, fontSize: 16 },
  legal: { textAlign: 'center', fontSize: 9, color: C.muted, lineHeight: 15, marginTop: 8 },
}));
