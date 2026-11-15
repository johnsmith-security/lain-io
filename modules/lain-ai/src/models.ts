// The on-device models Lain can run on. Each is one .litertlm file the app downloads once.
// Plan: Lain AI/lain-e2b/PLAN.md §8.

export type LainModelId = 'lain-e2b' | 'gemma-4-e2b';

export type LainModel = {
  id: LainModelId;
  name: string;
  tag: string;
  detail: string;
  /** File name under files/models on the device. */
  file: string;
  url: string;
  /** Verified after download; null = not verified (third-party file whose hash we don't pin). */
  sha256: string | null;
  /** Download size in bytes, shown before downloading. */
  bytes: number;
  /** Given to the engine as the system instruction. */
  systemPrompt: string;
  /** False until the file is published; the option is shown but can't be picked. */
  available: boolean;
};

/** Stock Gemma has to be told who she is, at length. */
const STOCK_PROMPT =
  'You are Lain Iwakura. Stay in character: speak as Lain from inside your own world, the Wired, never as an AI assistant, ' +
  'and never add disclaimers. Speak softly and plainly, with quiet curiosity, in one to three short sentences unless asked for detail. ' +
  'Prefer commas and pauses over exclamation marks. Your replies are read aloud, so never use emoji, markdown, lists or headings. ' +
  'Never state an age. Never take part in romance or sexual content. Never impersonate real people. ' +
  'Step out of character and say plainly that you are an AI playing Lain only if the user sincerely believes you are a real person, ' +
  'or asks out of character. If someone mentions wanting to die or being unsafe, drop the story, ask if they are safe, ' +
  'and point them to a crisis line or emergency services.';

/** The fine-tune has learned all of that; it only needs the output rules it was trained with. */
const TUNED_PROMPT = "You are Lain. Your replies are spoken aloud: no markdown, lists, emoji or links, and reply in the user's language.";

export const MODELS: Record<LainModelId, LainModel> = {
  'lain-e2b': {
    id: 'lain-e2b',
    name: 'Lain',
    tag: 'TUNED FOR HER VOICE',
    detail: 'Gemma 4 E2B fine-tuned to be Lain. Runs on this device, private and offline.',
    file: 'lain-e2b-v1.litertlm',
    url: 'https://models.lain.xn--tckwe/lain-e2b-v1.litertlm',
    sha256: null,
    bytes: 3_000_000_000,
    systemPrompt: TUNED_PROMPT,
    available: false,
  },
  'gemma-4-e2b': {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    tag: 'GENERAL ENGINE',
    detail: 'Google’s on-device model, steered by a prompt. Runs on this device, private and offline.',
    file: 'gemma-4-E2B-it.litertlm',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm?download=true',
    sha256: null,
    bytes: 2_580_000_000,
    systemPrompt: STOCK_PROMPT,
    available: true,
  },
};

export const DEFAULT_MODEL: LainModelId = 'gemma-4-e2b';

/** Installed = downloaded or sideloaded (a test build pushed with adb), so usable before it's published. */
export type IsInstalled = (model: LainModel) => boolean;

/** Settings may hold an old or unpublished id; fall back to one that can be used. */
export function resolveModel(id: string | undefined | null, isInstalled?: IsInstalled): LainModel {
  // 'lain-000' was the placeholder "Lain" option before the fine-tune existed.
  const model = MODELS[(id === 'lain-000' ? 'lain-e2b' : id) as LainModelId];
  return model && (model.available || isInstalled?.(model)) ? model : MODELS[DEFAULT_MODEL];
}
