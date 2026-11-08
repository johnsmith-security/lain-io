// Public types for the Lain IO database layer. GUI code should import from
// `src/db` (index.ts), never from Gun directly.

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
  /** URL or content hash of the avatar image; empty when unset. */
  avatar: string;
  accent: string;
  updatedAt: number;
  /** True when the username registry maps `username` back to this pub. False means possible impersonation. */
  verified?: boolean;
};

/** A post reference: `<authorPub>/<postId>`. Stable across edits. */
export type PostRef = string;

export type Post = {
  ref: PostRef;
  id: string;
  author: string;
  body: string;
  createdAt: number;
  editedAt?: number;
  replyTo?: PostRef;
};

export type Settings = {
  lainStyle: 'vaporwave' | 'wired';
  selectedModel: string;
  privatePresence: boolean;
  quietMode: boolean;
  showActivity: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
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
  /** 'sending' until at least one recipient device got an envelope written; 'sent' after. */
  status: 'sending' | 'sent' | 'received' | 'failed';
};

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
