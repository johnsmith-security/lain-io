import { themedStyles } from '../theme/themedStyles';
// Root component: waits for the database, then shows sign-in or the app.
//
//   NavigationProvider   current tab / open chat
//   KeyboardProvider     compact layouts while typing
//   LainProvider         on-device model + Lain chat (kept across tabs and sign-out)
//     AuthScreen | AppShell
import React, { useEffect } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, SafeAreaView, StatusBar, StyleSheet, Text } from 'react-native';
import { useLainDb, useSession } from '../db/hooks';
import { getDb } from '../db/native';
import { AuthScreen } from '../features/auth/AuthScreen';
import { LainProvider } from '../features/lain/LainProvider';
import { C } from '../theme/colors';
import { common } from '../theme/common';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';
import { clearDrafts } from './drafts';
import { KeyboardProvider } from './keyboard';
import { NavigationProvider, useNavigation } from './navigation';

export default function App() {
  const { ready, error } = useLainDb();

  // Back from the background: relay sockets often die while the app is suspended.
  // wake() replaces dead ones, refetches what we missed and resends the outbox.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') { try { getDb().wake(); } catch { /* database not ready yet */ } }
    });
    return () => sub.remove();
  }, []);

  if (!ready) {
    return (
      <SafeAreaView style={[styles.safe, styles.centered, { backgroundColor: C.bg }]}>
        <StatusBar barStyle="light-content" />
        {error ? <Text style={[common.errorText, { paddingHorizontal: 26 }]}>{error.message}</Text> : <ActivityIndicator color={C.cyan} />}
      </SafeAreaView>
    );
  }
  return (
    <NavigationProvider>
      <KeyboardProvider>
        <LainProvider>
          <ThemeProvider>
            <SafeAreaView style={styles.safe}>
              {/* Android runs edge-to-edge (gradle.properties), so adjustResize no longer shrinks
                  the window for the keyboard; pad the content ourselves on both platforms. */}
              <KeyboardAvoidingView behavior="padding" style={styles.fill}>
                <SessionGate />
              </KeyboardAvoidingView>
            </SafeAreaView>
          </ThemeProvider>
        </LainProvider>
      </KeyboardProvider>
    </NavigationProvider>
  );
}

function SessionGate() {
  const session = useSession();
  const { go } = useNavigation();
  // Every sign-in starts on the feed with empty drafts.
  useEffect(() => { go('home'); if (!session) clearDrafts(); }, [session?.pub]); // eslint-disable-line react-hooks/exhaustive-deps
  return session ? <AppShell /> : <AuthScreen />;
}

const styles = themedStyles(() => StyleSheet.create({
  safe: { flex: 1, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
}));
