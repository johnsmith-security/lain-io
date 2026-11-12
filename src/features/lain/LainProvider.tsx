// On-device Lain: Gemma 4 E2B through the native lain-ai module (download, load,
// generate, speech in/out). Lives above the screens so the loaded model and the
// conversation survive switching tabs.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Alert, PermissionsAndroid, TextInput } from 'react-native';

type TextInputHandle = ComponentRef<typeof TextInput>;
import { GEMMA_MODEL_URL, LAIN_VOICE_URL, LainAi, type VoiceEffect } from '../../../modules/lain-ai/src';
import { useKeyboard } from '../../app/keyboard';
import { errorMessage } from '../../lib/alerts';
import { MouthTrack } from './mouth';

export type LainStatus = 'missing' | 'downloaded' | 'downloading' | 'loading' | 'ready' | 'thinking' | 'listening' | 'processing' | 'speaking' | 'error';
/** Lain's own neural voice: not downloaded yet, downloading, or installed. */
export type VoiceStatus = 'missing' | 'downloading' | 'ready';
export type LainMessage = { id: string; role: 'you' | 'lain'; text: string };

type LainState = {
  /** False in Expo Go / without the native module. */
  available: boolean;
  status: LainStatus;
  messages: LainMessage[];
  error: string;
  /** Model download progress, 0–100. */
  progress: number;
  draft: string;
  setDraft: (text: string) => void;
  composerRef: React.RefObject<TextInputHandle | null>;
  send: (text: string, keepKeyboard?: boolean) => Promise<void>;
  prepare: (options?: { quiet?: boolean }) => Promise<void>;
  voice: VoiceStatus;
  /** Voice download progress, 0–100. */
  voiceProgress: number;
  downloadVoice: () => Promise<void>;
  setVoiceEffect: (effect: VoiceEffect) => void;
  /** Where her mouth is while she speaks; read by the avatar every frame (never re-renders). */
  mouth: MouthTrack;
  toggleListening: () => Promise<void>;
};

/** Statuses in which the model is loaded and busy or idle. */
export const ACTIVE_STATUSES: LainStatus[] = ['thinking', 'listening', 'processing', 'speaking'];

const LainContext = createContext<LainState | null>(null);

export function LainProvider({ children }: { children: React.ReactNode }) {
  const keyboard = useKeyboard();
  const [status, setStatusState] = useState<LainStatus>(LainAi ? 'missing' : 'error');
  const [messages, setMessages] = useState<LainMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const composerRef = useRef<TextInputHandle | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>(() => (LainAi?.getVoiceStatus?.().installed ? 'ready' : 'missing'));
  const [voiceProgress, setVoiceProgress] = useState(0);
  const mouth = useRef(new MouthTrack()).current;
  mouth.driven = voice === 'ready';
  // Native callbacks need the current status synchronously.
  const statusRef = useRef(status);
  const setStatus = useCallback((next: LainStatus) => { statusRef.current = next; setStatusState(next); }, []);

  const send = useCallback(async (text: string, keepKeyboard = false) => {
    const prompt = text.trim();
    if (!prompt || !LainAi || !['ready', 'listening', 'processing'].includes(statusRef.current)) return;
    if (keepKeyboard) {
      keyboard.setVisible(true);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
    setMessages((current) => [...current, { id: `${Date.now()}-user`, role: 'you', text: prompt }]);
    setDraft('');
    setError('');
    setStatus('thinking');
    try {
      const answer = await LainAi.generate(prompt);
      if (!answer) throw new Error('Lain returned an empty response. Try a shorter message.');
      setMessages((current) => [...current, { id: `${Date.now()}-lain`, role: 'lain', text: answer }]);
      setStatus('speaking');
      await LainAi.speak(answer);
    } catch (failure) {
      setError(errorMessage(failure, 'Lain could not answer right now.').slice(0, 180));
      setStatus('error');
    }
  }, [keyboard, setStatus]);

  useEffect(() => {
    if (!LainAi) return;
    const subs = [
      LainAi.addListener('onModelDownloadProgress', ({ downloadedBytes, totalBytes }) => {
        setProgress(totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : 0);
      }),
      LainAi.addListener('onVoiceDownloadProgress', ({ downloadedBytes, totalBytes }) => {
        setVoiceProgress(totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : 0);
      }),
      LainAi.addListener('onSpeechResult', ({ text }) => { if (text?.trim()) { setStatus('ready'); void send(text); } }),
      LainAi.addListener('onSpeechError', ({ message }) => {
        setError(message || 'Speech recognition stopped.');
        // Damaged voice files are removed natively; offer the download again.
        if (LainAi?.getVoiceStatus && !LainAi.getVoiceStatus().installed) setVoice('missing');
      }),
      LainAi.addListener('onSpeechState', ({ state }) => {
        if (state === 'idle') {
          const current = statusRef.current;
          setStatus(current === 'speaking' || current === 'listening' ? 'ready' : current);
        } else if (state === 'listening' || state === 'processing' || state === 'speaking') setStatus(state);
      }),
      LainAi.addListener('onVoiceMouth', ({ at, step, open }) => { mouth.push(at, step, open); }),
      LainAi.addListener('onSpeechDone', () => { mouth.clear(); setStatus('ready'); }),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [send, setStatus, mouth]);

  const preparing = useRef(false);
  /** Download (first time) and load the model. `quiet` skips the "connected" popup, for auto-load at launch. */
  const prepare = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (preparing.current) return;
    if (!LainAi) {
      setError('Expo Go cannot run the local model. From the Lain IO folder, run “npm run android” to build and install the Android version, then open Lain IO (not Expo Go).');
      setStatus('error');
      return;
    }
    preparing.current = true;
    try {
      setError('');
      let stored = LainAi.getModelStatus();
      if (!stored.downloaded) {
        setStatus('downloading');
        setProgress(0);
        stored = { ...stored, path: await LainAi.downloadModel(GEMMA_MODEL_URL), downloaded: true, bytes: 0 };
      }
      setStatus('loading');
      const loaded = await LainAi.loadModel(stored.path);
      setStatus('ready');
      if (!quiet) Alert.alert('Lain is connected', `Gemma 4 E2B is ready on the ${loaded.backend}. You can chat offline.`);
    } catch (failure) {
      console.error('[Lain AI] Model download or initialization failed', failure);
      setError(errorMessage(failure, 'The model could not be prepared.').slice(0, 180));
      setStatus('error');
    } finally {
      preparing.current = false;
    }
  }, [setStatus]);

  // Once the user has loaded Lain, keep her loaded: reuse an engine that is already in
  // memory, otherwise load it again quietly whenever the app opens.
  useEffect(() => {
    const stored = LainAi?.getModelStatus();
    if (!stored?.downloaded) return;
    if (stored.loaded) setStatus('ready');
    else if (stored.autoLoad) void prepare({ quiet: true });
    else setStatus('downloaded');
  }, [prepare, setStatus]);

  const toggleListening = useCallback(async () => {
    if (!LainAi) return;
    if (statusRef.current === 'listening') { await LainAi.stopListening(); return; }
    if (statusRef.current === 'speaking') { await LainAi.stopSpeaking?.(); return; }
    if (statusRef.current !== 'ready') return;
    const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
      setError('Microphone permission is needed for voice chat. You can still type to Lain.');
      return;
    }
    try {
      setError('');
      await LainAi.startListening();
    } catch (failure) {
      setError(errorMessage(failure, 'On-device speech recognition is unavailable.'));
    }
  }, []);

  const downloadVoice = useCallback(async () => {
    if (!LainAi || voice === 'ready') return;
    if (!LainAi.downloadVoice) { setError('Rebuild the app (npm run android) to add Lain’s voice.'); return; }
    setVoice('downloading');
    setVoiceProgress(0);
    try {
      await LainAi.downloadVoice(LAIN_VOICE_URL);
      setVoice('ready');
    } catch (failure) {
      setVoice('missing');
      setError(errorMessage(failure, 'Lain’s voice could not be downloaded.').slice(0, 180));
    }
  }, [voice]);

  // After a JS reload mid-install, show the install that is still running and wait for it.
  useEffect(() => {
    if (LainAi?.getVoiceStatus?.().installing) void downloadVoice();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Optional calls: a JS bundle newer than the installed native build must not crash the app.
  const setVoiceEffect = useCallback((effect: VoiceEffect) => { LainAi?.setVoiceEffect?.(effect); }, []);

  const value = useMemo<LainState>(() => ({
    available: Boolean(LainAi), status, messages, error, progress, draft, setDraft, composerRef, send, prepare, toggleListening,
    voice, voiceProgress, downloadVoice, setVoiceEffect, mouth,
  }), [status, messages, error, progress, draft, send, prepare, toggleListening, voice, voiceProgress, downloadVoice, setVoiceEffect, mouth]);
  return <LainContext.Provider value={value}>{children}</LainContext.Provider>;
}

export function useLain(): LainState {
  const lain = useContext(LainContext);
  if (!lain) throw new Error('useLain must be used inside <LainProvider>.');
  return lain;
}
