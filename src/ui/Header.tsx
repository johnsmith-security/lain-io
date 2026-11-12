import { themedStyles } from '../theme/themedStyles';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useProfile, useSession } from '../db/hooks';
import { useNavigation } from '../app/navigation';
import { C } from '../theme/colors';
import { common } from '../theme/common';
import { AvatarFace } from './AvatarFace';
import { Brand } from './Brand';

export function Header() {
  const session = useSession();
  const profile = useProfile(session?.pub ?? null);
  const { go } = useNavigation();
  return (
    <View style={styles.header}>
      <Brand />
      <Pressable style={common.avatarSmall} onPress={() => go('settings')} accessibilityLabel="Open profile settings">
        <AvatarFace avatar={profile?.avatar} name={profile?.name ?? session?.username ?? '?'} textStyle={common.avatarSmallText} />
      </Pressable>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  header: { height: 66, paddingHorizontal: 22, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panelDeep, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
}));
