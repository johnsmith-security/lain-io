// Terminal-style transcript shown beside the 3D Lain while the keyboard is open.
import React, { useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { C, MONO } from '../../theme/colors';
import { themedStyles } from '../../theme/themedStyles';
import { isAtBottom, type ScrollHandle } from '../../ui/ScreenScroll';
import { useLain } from './LainProvider';

export function LainLog({ hidden }: { hidden: boolean }) {
  const { messages, status, error } = useLain();
  const scrollRef = useRef<ScrollHandle>(null);
  const atBottom = useRef(true);
  return (
    <View style={[styles.column, hidden && { display: 'none' }]}>
      <Text style={styles.heading}>MESSAGES</Text>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator={false}
        onScroll={(event) => { atBottom.current = isAtBottom(event.nativeEvent); }}
        scrollEventThrottle={16}
        onContentSizeChange={() => { if (atBottom.current) scrollRef.current?.scrollToEnd({ animated: true }); }}
      >
        {messages.map((message) => (
          <View key={message.id} style={styles.message}>
            <Text style={[styles.role, message.role === 'lain' ? styles.roleLain : styles.roleYou]}>{message.role === 'lain' ? 'LAIN  >' : 'YOU   >'}</Text>
            <Text style={[styles.text, message.role === 'lain' ? styles.textLain : styles.textYou]}>{message.text}</Text>
          </View>
        ))}
        {status === 'thinking' && <Text style={styles.thinking}>LAIN IS THINKING…</Text>}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  column: { width: '43%', height: '100%', maxHeight: '100%', minWidth: 0, flexShrink: 0, alignSelf: 'stretch', paddingHorizontal: 9, paddingTop: 12, paddingBottom: 8, borderRightWidth: 1, borderColor: C.lineStrong },
  heading: { fontSize: 8, color: C.cyan, letterSpacing: 1.5, fontWeight: '800', marginBottom: 8 },
  scroll: { flex: 1, height: 0, minHeight: 0 },
  content: { flexGrow: 1, paddingBottom: 14 },
  message: { marginBottom: 12 },
  role: { fontSize: 7, fontWeight: '800', letterSpacing: 1.1, marginBottom: 3 },
  roleLain: { color: C.cyan },
  roleYou: { color: C.muted },
  text: { fontFamily: MONO, fontSize: 9, lineHeight: 14 },
  textLain: { color: C.ink, textShadowColor: C.cyan, textShadowRadius: 4 },
  textYou: { color: C.muted },
  thinking: { fontSize: 8, color: C.cyan, marginTop: 8 },
  error: { fontSize: 8, lineHeight: 12, color: C.danger, marginTop: 8 },
}));
