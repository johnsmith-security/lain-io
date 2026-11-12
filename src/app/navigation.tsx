// Which tab is showing, and which chat is open. The app has no router: five
// screens, switched by the tab bar (chat opens from Friends).
import React, { createContext, useContext, useMemo, useState } from 'react';

export type Page = 'home' | 'lain' | 'friends' | 'dm' | 'settings';

type Navigation = {
  page: Page;
  go: (page: Page) => void;
  /** Conversation shown on the 'dm' page. */
  activeChatId: string | null;
  openChat: (conversationId: string) => void;
  closeChat: () => void;
};

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const [page, setPage] = useState<Page>('home');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const value = useMemo<Navigation>(() => ({
    page,
    go: setPage,
    activeChatId,
    openChat: (id) => { setActiveChatId(id); setPage('dm'); },
    closeChat: () => { setActiveChatId(null); setPage('friends'); },
  }), [page, activeChatId]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext);
  if (!nav) throw new Error('useNavigation must be used inside <NavigationProvider>.');
  return nav;
}
