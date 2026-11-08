import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export type ModelDownloadProgress = { downloadedBytes: number; totalBytes: number };
export type NativeSpeechState = { state: 'idle' | 'listening' | 'processing' | 'speaking' };

type LainAiNative = {
  getModelStatus(): { downloaded: boolean; path: string; bytes: number };
  downloadModel(url: string): Promise<string>;
  loadModel(path: string): Promise<{ ready: boolean; backend: 'GPU' | 'CPU' }>;
  generate(prompt: string): Promise<string>;
  unloadModel(): Promise<boolean>;
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
  speak(text: string): Promise<boolean>;
  addListener(event: string, listener: (event: any) => void): EventSubscription;
};

const nativeModule = requireOptionalNativeModule<LainAiNative>('LainAi');
export const GEMMA_MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm?download=true';
export const LainAi = nativeModule;
