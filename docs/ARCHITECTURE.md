# Lain IO app: code map

```
index.js                         entry: crypto polyfill, then registers src/app/App
app.json · metro.config.js       Expo config (glb assets enabled in Metro)
assets/models/lain.glb           the 3D Lain
modules/lain-ai/                 native Expo module: Gemma 4 E2B (LiteRT-LM), speech input, Lain's voice
                                 (Kokoro via sherpa-onnx, LainVoice.kt + WiredFx.kt; system TTS fallback)
relay/                           Gun relay + registrar + moderation + media service (Node)
tests/db.e2e.ts                  end-to-end test of src/db against a real relay (npm run test:db)
tools/wired-bot.ts               "bob", a bot account to talk to (npm run bot)
docs/                            DB-LAYER.md (API guide), PLAN-gundb-and-lain-000.md, this file

src/
  app/                           wiring, no UI of its own
    App.tsx                      root: waits for the db, providers, AuthScreen or AppShell
    AppShell.tsx                 header + active screen + tab bar; compact layout while typing
    navigation.tsx               current tab and open chat (useNavigation)
    keyboard.tsx                 keyboard visibility (useKeyboard)
    drafts.ts                    unsent text that survives tab switches (useDraft)

  features/                      one folder per screen; each owns its components and styles
    auth/       AuthScreen, SignalCard
    feed/       FeedScreen, Composer, PostCard, MediaGrid, LinkCard
    lain/       LainScreen, LainProvider (model + chat state), LainLog, AvatarScene (Three.js)
    friends/    FriendsScreen, ConversationRow, FriendRow
    messages/   ChatScreen, ChatComposer, MessageBubble, DmMediaTile, useChatActions (menus)
    settings/   SettingsScreen, SettingRows, LainPreferences

  ui/                            shared building blocks, no data access except AvatarFace
    Brand, Button, Eyebrow, Header, TabBar, ScreenTitle, ScreenScroll, SendButton, AvatarFace
    media/      InlineVideo, AttachmentChip, mediaStyles

  theme/        colors.ts (palette C, MONO font), common.ts (styles used by several features)
  lib/          time.ts (timeAgo, clockTime…), alerts.ts (showError, errorMessage)

  db/                            database layer: the only code that talks to Gun (see DB-LAYER.md)
    index.ts                     LainDb: sessions, wiring, keep-alive
    native.ts                    what the app imports (initDb/getDb + device media helpers)
    hooks.ts                     React hooks (useSession, useMessages, …)
    graph.ts                     Gun wrapper: reads, writes, subscriptions, connection health
    auth.ts usernames.ts profiles.ts settings.ts social.ts media.ts nativeMedia.ts
    moderation.ts registry.ts lain.ts types.ts config.ts encoding.ts platform.ts …
    messages/                    Signal protocol messenger (messenger.ts, signalStore.ts)
```

## Rules

- **Screens only talk to `src/db`** (through `hooks.ts` and `getDb()` from `db/native`), never to Gun.
- **A feature folder owns its UI and styles.** Something used by two features moves to `src/ui` (components) or `src/theme/common.ts` (styles). Features don't import each other, except `app/` importing screens.
- **State that must outlive a screen** goes in a provider: navigation, keyboard, Lain's model and chat. Everything else is local state or a `useDraft`.
- **No new screens for small things**: menus are native alerts (see `features/messages/useChatActions.ts`).
- Colours always come from `theme/colors.ts`.

## Adding a screen

1. `src/features/<name>/<Name>Screen.tsx`, rendering a `<ScreenScroll>` (plus a docked composer if it has one).
2. Add the page id to `Page` in `app/navigation.tsx`, render it in `app/AppShell.tsx`, and add a tab in `ui/TabBar.tsx` if it needs one.
