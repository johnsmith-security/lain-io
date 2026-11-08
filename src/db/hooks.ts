// React hooks over the database layer. Every hook subscribes on mount and
// unsubscribes on unmount, so screens can bind directly to live data.

import { useCallback, useEffect, useState } from 'react';
import { type LainDb, getDb, initDb } from './native';
import type {
  ChatMessage, Conversation, IdentityWarning, LainChatMessage, LainConsent, LainMemoryFact, Post, PostRef, Profile, Safety, Session, Settings, Unsubscribe,
} from './types';

/** Starts the database once. Render a splash screen until `ready`. */
export function useLainDb(): { db: LainDb | null; ready: boolean; error: Error | null } {
  const [db, setDb] = useState<LainDb | null>(() => { try { return getDb(); } catch { return null; } });
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (db) return;
    let alive = true;
    initDb().then((value) => { if (alive) setDb(value); }, (err) => { if (alive) setError(err instanceof Error ? err : new Error(String(err))); });
    return () => { alive = false; };
  }, [db]);
  return { db, ready: Boolean(db), error };
}

function useLive<T>(initial: T, subscribe: ((set: (value: T) => void) => Unsubscribe) | null, deps: unknown[]): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (!subscribe) { setValue(initial); return; }
    let alive = true;
    const stop = subscribe((next) => { if (alive) setValue(next); });
    return () => { alive = false; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

const dbOrNull = (): LainDb | null => { try { return getDb(); } catch { return null; } };

export function useSession(): Session | null {
  const db = dbOrNull();
  return useLive<Session | null>(db?.session ?? null, db ? (set) => db.onSession(set) : null, [db]);
}

/** Live list, plus `loading` until the first emission. */
function useLiveList<T>(subscribe: ((set: (value: T[]) => void) => Unsubscribe) | null, deps: unknown[]): { items: T[]; loading: boolean } {
  const [state, setState] = useState<{ items: T[]; loading: boolean }>({ items: [], loading: true });
  useEffect(() => {
    setState({ items: [], loading: Boolean(subscribe) });
    if (!subscribe) return;
    let alive = true;
    const stop = subscribe((items) => { if (alive) setState({ items, loading: false }); });
    return () => { alive = false; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function useDiscoveryFeed(days = 2) {
  const db = dbOrNull();
  return useLiveList<Post>(db ? (set) => db.social.subscribeDiscovery(set, { days }) : null, [db, days]);
}

export function useFollowingFeed() {
  const db = dbOrNull();
  const session = useSession();
  return useLiveList<Post>(db && session ? (set) => db.social.subscribeFollowingFeed(set) : null, [db, session?.pub]);
}

export function useUserPosts(pub: string | null) {
  const db = dbOrNull();
  return useLiveList<Post>(db && pub ? (set) => db.social.subscribeUserPosts(pub, set) : null, [db, pub]);
}

export function useReplies(ref: PostRef | null) {
  const db = dbOrNull();
  return useLiveList<Post>(db && ref ? (set) => db.social.subscribeReplies(ref, set) : null, [db, ref]);
}

export function useLikes(ref: PostRef) {
  const db = dbOrNull();
  const state = useLive({ count: 0, likedByMe: false, capped: false }, db ? (set) => db.social.subscribeLikes(ref, set) : null, [db, ref]);
  const toggle = useCallback(async () => {
    if (!db) return;
    if (state.likedByMe) await db.social.unlike(ref); else await db.social.like(ref);
  }, [db, ref, state.likedByMe]);
  return { ...state, toggle };
}

export function useProfile(pub: string | null): Profile | null {
  const db = dbOrNull();
  return useLive<Profile | null>(null, db && pub ? (set) => db.profiles.subscribe(pub, set) : null, [db, pub]);
}

export function useFollowing() {
  const db = dbOrNull();
  const session = useSession();
  return useLiveList<string>(db && session ? (set) => db.social.subscribeFollowing(set) : null, [db, session?.pub]);
}

export function useFollowers(pub: string | null) {
  const db = dbOrNull();
  return useLiveList<string>(db && pub ? (set) => db.social.subscribeFollowers(pub, set) : null, [db, pub]);
}

export function useSettings(): [Settings | null, (patch: Partial<Omit<Settings, 'updatedAt'>>) => Promise<Settings>] {
  const db = dbOrNull();
  const session = useSession();
  const settings = useLive<Settings | null>(null, db && session ? (set) => db.settings.subscribe(set) : null, [db, session?.pub]);
  const update = useCallback((patch: Partial<Omit<Settings, 'updatedAt'>>) => {
    if (!db) return Promise.reject(new Error('Database not ready.'));
    return db.settings.update(patch);
  }, [db]);
  return [settings, update];
}

export function useSafety(): Safety | null {
  const db = dbOrNull();
  const session = useSession();
  return useLive<Safety | null>(null, db && session ? (set) => db.safety.subscribe(set) : null, [db, session?.pub]);
}

export function useConversations(): Conversation[] {
  const db = dbOrNull();
  const session = useSession();
  return useLive<Conversation[]>([], db && session ? (set) => db.messages.subscribeConversations(set) : null, [db, session?.pub]);
}

export function useMessages(conversationId: string | null): ChatMessage[] {
  const db = dbOrNull();
  const session = useSession();
  return useLive<ChatMessage[]>([], db && session && conversationId ? (set) => db.messages.subscribeMessages(conversationId, set) : null, [db, session?.pub, conversationId]);
}

export function useIdentityWarnings(): IdentityWarning[] {
  const db = dbOrNull();
  const session = useSession();
  return useLive<IdentityWarning[]>([], db && session ? (set) => db.messages.subscribeIdentityWarnings(set) : null, [db, session?.pub]);
}

export function useLainMemory(): LainMemoryFact[] {
  const db = dbOrNull();
  const session = useSession();
  return useLive<LainMemoryFact[]>([], db && session ? (set) => db.lain.subscribeMemory(set) : null, [db, session?.pub]);
}

export function useLainConsent(): LainConsent | null {
  const db = dbOrNull();
  const session = useSession();
  return useLive<LainConsent | null>(null, db && session ? (set) => db.lain.subscribeConsent(set) : null, [db, session?.pub]);
}

export function useLainChat(chatId: string | null): LainChatMessage[] {
  const db = dbOrNull();
  const session = useSession();
  return useLive<LainChatMessage[]>([], db && session && chatId ? (set) => db.lain.subscribeChat(chatId, set) : null, [db, session?.pub, chatId]);
}
