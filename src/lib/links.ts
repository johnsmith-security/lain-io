// Public pages on lain.コム (Infrastructure/cloudflare/workers/lain-site). Store listings and the
// app link here for policies, support and account deletion.
import { Linking } from 'react-native';

export const SITE = 'https://lain.xn--tckwe';
export const LINKS = {
  guidelines: `${SITE}/community-guidelines`,
  childSafety: `${SITE}/child-safety`,
  privacy: `${SITE}/privacy`,
  terms: `${SITE}/terms`,
  support: `${SITE}/support`,
  deleteAccount: `${SITE}/delete-account`,
} as const;

/** Minimum age (store rating 17+ / Mature, plan A8). */
export const MIN_AGE = 17;

export function openLink(url: string) { Linking.openURL(url).catch(() => {}); }
