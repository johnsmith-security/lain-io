// Device side of media: pick, prepare, upload. App only (uses Expo modules).
//
//   const items = await pickPostMedia();                 // [] when cancelled
//   const media = await uploadPrepared(getDb(), items);   // MediaRef[] for createPost
//
// Photos are re-encoded as JPEG (longest edge ≤ 2048 px). Re-encoding drops
// EXIF, so GPS location and camera details never leave the phone. GIFs are sent
// as-is to keep their animation (GIF has no EXIF block).
// Videos are sent as picked (≤ 60 s, ≤ 25 MB). On iOS the picker re-exports them
// at 720p; on Android the original file is sent, and its container can still
// hold a location tag. Stripping that needs a video transcoder (not yet).

import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import type { LainDb } from './index';
import { MEDIA_LIMITS, MediaError } from './media';
import type { MediaRef, PrivateMediaRef } from './types';

export type PreparedMedia = {
  kind: 'image' | 'video';
  /** Local file to preview in the composer. */
  uri: string;
  mime: string;
  width?: number;
  height?: number;
  duration?: number;
  thumb?: string;
  size: number;
  /** The uploader marked it as adult content. */
  sensitive?: boolean;
};

async function ensureLibraryAccess() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new MediaError('Allow access to your photos to attach them.');
}

/** ≈24 px JPEG as a data URL, shown blurred while the real file loads or after it expired. */
async function tinyThumb(uri: string): Promise<string | undefined> {
  try {
    const image = await ImageManipulator.manipulate(uri).resize({ width: 24 }).renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.5, base64: true });
    return saved.base64 ? `data:image/jpeg;base64,${saved.base64}` : undefined;
  } catch {
    return undefined;
  }
}

async function prepareImage(asset: ImagePicker.ImagePickerAsset): Promise<PreparedMedia> {
  const thumb = await tinyThumb(asset.uri);
  if (asset.mimeType === 'image/gif') {
    const size = new File(asset.uri).size ?? asset.fileSize ?? 0;
    if (size > MEDIA_LIMITS.imageBytes) throw new MediaError('This GIF is too large (max 6 MB).');
    return { kind: 'image', uri: asset.uri, mime: 'image/gif', width: asset.width, height: asset.height, thumb, size };
  }
  const longest = Math.max(asset.width, asset.height);
  let context = ImageManipulator.manipulate(asset.uri);
  if (longest > MEDIA_LIMITS.imageMaxEdge) {
    context = asset.width >= asset.height ? context.resize({ width: MEDIA_LIMITS.imageMaxEdge }) : context.resize({ height: MEDIA_LIMITS.imageMaxEdge });
  }
  const rendered = await context.renderAsync();
  let saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.82 });
  let size = new File(saved.uri).size ?? 0;
  if (size > MEDIA_LIMITS.imageBytes) {
    saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.6 });
    size = new File(saved.uri).size ?? 0;
  }
  return { kind: 'image', uri: saved.uri, mime: 'image/jpeg', width: saved.width, height: saved.height, thumb, size };
}

async function prepareVideo(asset: ImagePicker.ImagePickerAsset): Promise<PreparedMedia> {
  const seconds = asset.duration ? asset.duration / 1000 : undefined;
  if (seconds && seconds > MEDIA_LIMITS.videoSeconds + 1) throw new MediaError(`Videos can be up to ${MEDIA_LIMITS.videoSeconds} seconds. Share longer ones as a YouTube or PeerTube link.`);
  const size = new File(asset.uri).size ?? asset.fileSize ?? 0;
  if (size > MEDIA_LIMITS.videoBytes) throw new MediaError('This video is too large (max 25 MB). Trim it, or share it as a YouTube or PeerTube link.');
  const mime = asset.mimeType === 'video/quicktime' || /\.mov$/i.test(asset.uri) ? 'video/quicktime' : asset.mimeType === 'video/webm' ? 'video/webm' : 'video/mp4';
  let thumb: string | undefined;
  try {
    const frame = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 0, quality: 0.5 });
    thumb = await tinyThumb(frame.uri);
  } catch { thumb = undefined; }
  return { kind: 'video', uri: asset.uri, mime, width: asset.width, height: asset.height, duration: seconds ? Math.round(seconds) : undefined, thumb, size };
}

/** Pick up to 4 photos, or 1 video, and prepare them for upload. Returns [] when cancelled. */
export async function pickPostMedia(options: { already?: number } = {}): Promise<PreparedMedia[]> {
  await ensureLibraryAccess();
  const room = MEDIA_LIMITS.imagesPerPost - (options.already ?? 0);
  if (room <= 0) throw new MediaError(`Attach up to ${MEDIA_LIMITS.imagesPerPost} photos, or 1 video.`);
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: room > 1,
    selectionLimit: room,
    quality: 1,
    exif: false,
    videoMaxDuration: MEDIA_LIMITS.videoSeconds,
    videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
  });
  if (result.canceled) return [];
  const videos = result.assets.filter((a) => a.type === 'video');
  if (videos.length && (result.assets.length > 1 || (options.already ?? 0) > 0)) throw new MediaError('A post can have up to 4 photos, or 1 video on its own.');
  const out: PreparedMedia[] = [];
  for (const asset of result.assets) out.push(asset.type === 'video' ? await prepareVideo(asset) : await prepareImage(asset));
  return out;
}

/** Upload prepared items in order. */
export async function uploadPrepared(db: LainDb, items: PreparedMedia[]): Promise<MediaRef[]> {
  const refs: MediaRef[] = [];
  for (const item of items) {
    const bytes = await new File(item.uri).bytes();
    refs.push(await db.media.upload(bytes, {
      mime: item.mime, width: item.width, height: item.height, duration: item.duration, thumb: item.thumb, sensitive: item.sensitive,
    }));
  }
  return refs;
}

/**
 * Encrypt prepared items on the device (AES-256-GCM, fresh key per file) and upload the
 * ciphertext. Pass the refs to db.messages.send(conversationId, text, { media }); the keys
 * travel only inside the Signal message. The relay keeps the ciphertext 30 days.
 */
export async function uploadPrivatePrepared(db: LainDb, items: PreparedMedia[]): Promise<PrivateMediaRef[]> {
  const refs: PrivateMediaRef[] = [];
  for (const item of items) {
    const bytes = await new File(item.uri).bytes();
    refs.push(await db.media.uploadPrivate(bytes, item.mime, { width: item.width, height: item.height, duration: item.duration, thumb: item.thumb }));
  }
  return refs;
}

/** Pick, crop square, shrink to 512 px, upload, and set as the profile picture. Returns false when cancelled. */
export async function pickAvatar(db: LainDb): Promise<boolean> {
  await ensureLibraryAccess();
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1, exif: false });
  if (result.canceled || !result.assets[0]) return false;
  const rendered = await ImageManipulator.manipulate(result.assets[0].uri).resize({ width: 512, height: 512 }).renderAsync();
  let saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  if ((new File(saved.uri).size ?? 0) > MEDIA_LIMITS.avatarBytes) saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.5 });
  const bytes = await new File(saved.uri).bytes();
  const session = db.session;
  if (!session) throw new MediaError('Sign in first.');
  const previous = (await db.profiles.get(session.pub))?.avatar;
  await db.media.setAvatar(bytes, 'image/jpeg', (avatar) => db.profiles.updateMine({ avatar }), previous);
  return true;
}

/** Decrypt a DM attachment into the app cache and return a local URI to show it. */
export async function openPrivateMedia(db: LainDb, ref: PrivateMediaRef): Promise<string> {
  const ext = ref.plainMime.split('/')[1]?.replace('quicktime', 'mov').replace('jpeg', 'jpg') ?? 'bin';
  const file = new File(Paths.cache, `lain-${ref.sha.slice(0, 24)}.${ext}`);
  if (file.exists) return file.uri;
  file.write(await db.media.downloadPrivate(ref));
  return file.uri;
}
