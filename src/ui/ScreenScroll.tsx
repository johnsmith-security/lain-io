import React, { forwardRef, type ComponentRef } from 'react';
import { ScrollView, StyleSheet, type ScrollViewProps } from 'react-native';
import { C } from '../theme/colors';
import { themedStyles } from '../theme/themedStyles';

/**
 * The scrolling body of a tab. Taps keep the keyboard open (composers are
 * docked below the scroll view), and nested scroll views work (Lain's log).
 */
export type ScrollHandle = ComponentRef<typeof ScrollView>;

export const ScreenScroll = forwardRef<ScrollHandle, ScrollViewProps>(function ScreenScroll({ contentContainerStyle, ...props }, ref) {
  return (
    <ScrollView
      ref={ref}
      style={styles.scroll}
      contentContainerStyle={[styles.content, contentContainerStyle]}
      nestedScrollEnabled
      keyboardShouldPersistTaps="always"
      keyboardDismissMode="none"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      {...props}
    />
  );
});

/** True when a scroll event is (nearly) at the bottom: keep following new messages. */
export const isAtBottom = ({ layoutMeasurement, contentOffset, contentSize }: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } }) =>
  layoutMeasurement.height + contentOffset.y >= contentSize.height - 28;

const styles = themedStyles(() => StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 20, paddingTop: 21, paddingBottom: 28 },
}));
