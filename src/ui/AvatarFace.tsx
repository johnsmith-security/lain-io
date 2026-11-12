import React from 'react';
import { Image, StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { getDb } from '../db/native';

/** Profile picture (resolved from a media: URI), or the first letter of the name. Fills its parent frame. */
export function AvatarFace({ avatar, name, textStyle }: { avatar?: string; name: string; textStyle: StyleProp<TextStyle> }) {
  const uri = avatar ? getDb().media.resolveUri(avatar) : '';
  if (uri) return <Image source={{ uri }} resizeMode="cover" style={styles.image} />;
  return <Text style={textStyle}>{name[0]?.toUpperCase() ?? '?'}</Text>;
}

const styles = StyleSheet.create({
  image: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 12 },
});
