// Whether the software keyboard is up. Lain and chat switch to a compact
// layout while typing (header / tab bar hidden), so several components read it.
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

type KeyboardState = { visible: boolean; setVisible: (visible: boolean) => void };

const KeyboardContext = createContext<KeyboardState>({ visible: false, setVisible: () => {} });

export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
}

export const useKeyboard = () => useContext(KeyboardContext);
