// Signed-in layout: header, the active screen, tab bar.
// Each screen renders its own <ScreenScroll> and, if it has one, its docked composer.
import React from 'react';
import { View } from 'react-native';
import { useConversations } from '../db/hooks';
import { ChatScreen } from '../features/messages/ChatScreen';
import { FeedScreen } from '../features/feed/FeedScreen';
import { FriendsScreen } from '../features/friends/FriendsScreen';
import { LainScreen } from '../features/lain/LainScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { Header } from '../ui/Header';
import { TabBar } from '../ui/TabBar';
import { useAppTheme } from '../theme/ThemeProvider';
import { useKeyboard } from './keyboard';
import { useNavigation } from './navigation';

export function AppShell() {
  const { theme } = useAppTheme();
  const { page, go } = useNavigation();
  const keyboard = useKeyboard();
  const conversations = useConversations();
  const unread = conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
  // While typing to Lain or in a chat, give the screen the whole height.
  const compact = keyboard.visible && (page === 'lain' || page === 'dm');
  return (
    <View style={{ flex: 1, backgroundColor: theme.palette.bg }}>
      {!(compact && page === 'lain') && <Header />}
      {page === 'home' ? <FeedScreen />
        : page === 'lain' ? <LainScreen />
        : page === 'friends' ? <FriendsScreen />
        : page === 'dm' ? <ChatScreen />
        : <SettingsScreen />}
      <TabBar page={page === 'dm' ? 'friends' : page} onSelect={go} badges={{ friends: unread }} hidden={compact} />
    </View>
  );
}
