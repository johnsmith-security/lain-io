// Public types for the Lain IO database layer. GUI code should import from
// `src/db` (index.ts), never from Gun directly.
import type { ThemeId } from '../theme/themes';

export type SEAPair = { pub: string; priv: string; epub: string; epriv: string };

export type Session = {
  pub: string;
  epub: string;
  username: string;
  deviceId: number;
};

export type AuthResult = {
  session: Session;
  /** Present when a recovery code was created (sign-up with email, or setRecoveryEmail). Show it once. */
  recoveryCode?: string;
  /** True when the recovery service accepted the email for delivery. */
  emailSent?: boolean;
};

export type Profile = {
  pub: string;
  username: string;
  name: string;
  bio: string;
  /** Public image URL or compact data URL, synced with the profile; empty when unset. */
  avatar: string;
  accent: string;
  updatedAt: number;
  /** True when the username registry maps `username` back to this pub. False means possible impersonation. */
  verified?: boolean;
};

/** A post reference: `<authorPub>/<postId>`. Stable across edits. */
export type PostRef = string;


/**
 * An uploaded image or video. Gun stores only this; the bytes live on the main
 * relay's media store (IPFS) under `sha` (SHA-256 hex of the file).
 * Show it with `db.media.url(sha)`; while it loads, or after it expires, show `thumb` blurred.
 */
export type MediaRef = {
  sha: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** Video length in seconds. */
  duration?: number;
  /** Tiny JPEG data URL (≈24 px wide) for the blurred placeholder. */
  thumb?: string;
  /** IPFS CID, so any IPFS gateway that still has the file can serve it. */
  cid?: string;
  /** Adult content: flagged by the relay's scanner or by the uploader. Blurred unless settings.showSensitiveMedia. */
  sensitive?: boolean;
};

/** An encrypted attachment for direct messages. The key travels only inside the Signal message. */
export type PrivateMediaRef = MediaRef & { key: string; iv: string; plainMime: string };

export type MediaStatus = 'live' | 'expired' | 'deleted' | 'banned' | 'missing';
export type MediaInfo = { sha: string; status: MediaStatus; size?: number; mime?: string; cid?: string; expiresAt?: number | null; kept?: boolean };

/** Preview of an external video link (YouTube, PeerTube) or plain link, captured when posting. */
export type LinkPreview = { url: string; provider: 'youtube' | 'peertube' | 'link'; title: string; author?: string; thumbnail?: string };

export type Post = {
  ref: PostRef;
  id: string;
  author: string;
  /** May be empty when the post has media, a link, or is a repost. */
  body: string;
  createdAt: number;
  editedAt?: number;
  replyTo?: PostRef;
  /** Up to 4 images, or 1 video. Banned files are already removed. */
  media?: MediaRef[];
  link?: LinkPreview;
  /** Set on reposts: the original post. Show it with `usePost(post.repostOf)`. */
  repostOf?: PostRef;
};

export type Settings = {
  appTheme: ThemeId;
  lainStyle: 'vaporwave' | 'wired';
  /** How Lain's voice sounds: through the Wired (filtered, a little static) or clean. */
  lainVoice: 'wired' | 'clean';
  selectedModel: string;
  privatePresence: boolean;
  quietMode: boolean;
  showActivity: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
  /** Show media flagged as adult content without blurring. Off by default; the GUI should confirm 18+ before enabling. */
  showSensitiveMedia: boolean;
  /** Extra relay URLs added by the user (merged with the configured peers). */
  relays: string[];
  updatedAt: number;
};

export type Safety = {
  blocked: Record<string, number>;
  mutedWords: string[];
};

export type ConversationKind = 'direct' | 'group';

export type Conversation = {
  id: string;
  kind: ConversationKind;
  /** Account pubs in the conversation, including yourself. */
  members: string[];
  /** Group name; empty for direct conversations. */
  name: string;
  owner?: string;
  lastMessageAt: number;
  lastMessagePreview: string;
  unread: number;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  from: string;
  text: string;
  sentAt: number;
  receivedAt: number;
  replyTo?: string;
  /** Encrypted attachments (photos or one video). The key travels only inside the Signal message. */
  media?: PrivateMediaRef[];
  /**
   * Your messages: 'sending' → 'sent' (relay acked the envelope) → 'delivered' (a recipient
   * device decrypted it) → 'read' (only if the recipient has read receipts on).
   * 'failed' messages stay in the outbox and are retried on reconnect for 24 h.
   * Received messages: 'received'.
   */
  status: MessageStatus;
  /** Received messages: when you read it (also synced from your other devices). */
  readAt?: number;
  /** Deleted for everyone by its sender: text and media are gone, a tombstone remains. */
  deleted?: boolean;
};

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'received' | 'failed';

export type IdentityWarning = { pub: string; deviceId: number; at: number };

export type ReportKind = 'post' | 'profile' | 'message' | 'lain-reply';

export type Report = {
  kind: ReportKind;
  /** Post ref, account pub, message id, or Lain message id. */
  target: string;
  reason: 'spam' | 'harassment' | 'hate' | 'sexual' | 'minor-safety' | 'self-harm' | 'violence' | 'illegal' | 'other';
  details?: string;
  /** For DM reports: the decrypted messages the reporter chooses to share. */
  evidence?: Array<{ from: string; text: string; sentAt: number }>;
};

export type LainChatMessage = { id: string; chatId: string; role: 'you' | 'lain'; text: string; at: number; rating?: 1 | -1 };

export type LainMemoryFact = {
  id: string;
  text: string;
  source: 'chat' | 'post' | 'like' | 'follow' | 'explicit' | 'summary';
  confidence: number;
  createdAt: number;
  updatedAt: number;
};

export type LainConsent = { learnLocal: boolean; trainRemote: boolean; at: number };

export type ActiveModel = { version: string; adapterHash?: string; at: number };

export type ModelRelease = {
  version: string;
  url: string;
  sha256: string;
  size: number;
  minAppVersion: string;
  notes: string;
  createdAt: number;
};

export type RelayInfo = { id: string; url: string; region: string; operator: string };

export type SignalEvent = {
  id: string;
  kind: 'post' | 'like' | 'follow' | 'dwell' | 'lain-chat' | 'rating' | 'interest' | 'dm-topic';
  /** Short text or topic list. Never another person's words. */
  data: string;
  weight?: number;
  at: number;
};

export type Unsubscribe = () => void;
