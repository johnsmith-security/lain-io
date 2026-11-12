import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export type ModelDownloadProgress = { downloadedBytes: number; totalBytes: number };
/** 'wired': phone-line tone, small room, faint static. 'clean': the voice alone. */
export type VoiceEffect = 'wired' | 'clean';
export type NativeSpeechState = { state: 'idle' | 'listening' | 'processing' | 'speaking' };

type LainAiNative = {
  getModelStatus(): {
    downloaded: boolean; path: string; bytes: number;
    /** The engine is already in memory (e.g. the JS reloaded but the process didn't). */
    loaded: boolean; backend: 'GPU' | 'CPU' | null;
    /** The user loaded the model before, so load it whenever the app opens. */
    autoLoad: boolean;
  };
  downloadModel(url: string): Promise<string>;
  loadModel(path: string): Promise<{ ready: boolean; backend: 'GPU' | 'CPU' }>;
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
