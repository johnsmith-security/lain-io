import Gun from 'gun';

// Gun peers can be supplied as a comma-separated EXPO_PUBLIC_GUN_PEERS value.
// Keep this list explicit: mobile peers should connect to a reachable relay.
const configuredPeers = process.env.EXPO_PUBLIC_GUN_PEERS
  ?.split(',')
  .map((peer: string) => peer.trim())
  .filter(Boolean);

export const gun = Gun({ peers: configuredPeers?.length ? configuredPeers : undefined });
export const lainGraph = gun.get('lain-io');

export type FeedPost = {
  id: string;
  author: string;
  handle: string;
  body: string;
  time: string;
  likes: number;
  accent: string;
};

export function publishPost(post: FeedPost) {
  lainGraph.get('feed').get(post.id).put(post);
}

export function followFeed(onPost: (post: FeedPost) => void) {
  const handler = (data: FeedPost | undefined) => {
    if (data?.id && data.body) onPost(data);
  };
  lainGraph.get('feed').map().on(handler);
  return () => { lainGraph.get('feed').map().off(); };
}
