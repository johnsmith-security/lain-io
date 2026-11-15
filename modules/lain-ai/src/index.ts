import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

/** One spoken sentence's mouth track: `open` is comma-separated 0–100 values, one per `step` ms from `at` (epoch ms, when it is heard). */
export type VoiceMouth = { at: number; step: number; open: string };
export type ModelDownloadProgress = { downloadedBytes: number; totalBytes: number };
/** 'wired': phone-line tone, small room, faint static. 'clean': the voice alone. */
export type VoiceEffect = 'wired' | 'clean';
export type NativeSpeechState = { state: 'idle' | 'listening' | 'processing' | 'speaking' };

type LainAiNative = {
  /** `fileName` picks the model (see models.ts); omitted = stock Gemma. */
  getModelStatus(fileName?: string): {
    downloaded: boolean; path: string; bytes: number;
    /** This model's engine is already in memory (e.g. the JS reloaded but the process didn't). */
    loaded: boolean; loadedPath: string | null; backend: 'GPU' | 'CPU' | null;
    /** The user loaded the model before, so load it whenever the app opens. */
    autoLoad: boolean;
  };
  /** Resumable; with `sha256`, a damaged download is deleted and rejected. Optional args need a native build from 2026-11-15. */
  downloadModel(url: string, fileName?: string, sha256?: string, label?: string): Promise<string>;
  deleteModel?(fileName: string): Promise<boolean>;
  loadModel(path: string, systemPrompt?: string): Promise<{ ready: boolean; backend: 'GPU' | 'CPU' }>;
  generate(prompt: string): Promise<string>;
  unloadModel(): Promise<boolean>;
  /** Lain's neural voice (Kokoro, ~103 MB). Until it is installed, speak() uses the Android system voice. */
  /** `installing`: a download or unpack is running (e.g. started before a JS reload). */
  getVoiceStatus(): { installed: boolean; installing: boolean; effect: VoiceEffect };
  downloadVoice(url: string): Promise<boolean>;
  setVoiceEffect(effect: VoiceEffect): boolean;
  stopSpeaking(): Promise<boolean>;
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
  speak(text: string): Promise<boolean>;
  addListener(event: string, listener: (event: any) => void): EventSubscription;
};

const nativeModule = requireOptionalNativeModule<LainAiNative>('LainAi');
export const GEMMA_MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm?download=true';
/** Kokoro-82M int8, English, packaged for sherpa-onnx (Apache-2.0). */
export const LAIN_VOICE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2';
export const LainAi = nativeModule;
export * from './models';
import type { LainModel } from './models';
/** True when the model's file is on the device (downloaded or sideloaded). */
export const isInstalled = (model: LainModel): boolean => {
  try { return Boolean(nativeModule?.getModelStatus(model.file).downloaded); } catch { return false; }
};
