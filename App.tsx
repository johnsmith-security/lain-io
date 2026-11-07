import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import AvatarScene from './src/AvatarScene';
import { FeedPost, followFeed, publishPost } from './src/gun';

type Page = 'home' | 'lain' | 'friends' | 'settings';
const C = { bg: '#0c0717', panel: '#171025', ink: '#fbf3ff', muted: '#aa9bbf', pink: '#ff4fd8', cyan: '#59f3ff', violet: '#ab7bff', sun: '#ffd36b', line: '#34244b', green: '#79fbd2' };
const initialPosts: FeedPost[] = [
  { id: 'post-1', author: 'Lain Iwakura', handle: '@lain', body: 'I feel like I am always connected to everyone, everywhere. Even when I am alone.', time: '2 min ago', likes: 248, accent: C.pink },
  { id: 'post-2', author: 'Chisa Yomoda', handle: '@chisa', body: 'No matter where you go, everyone is connected.', time: '18 min ago', likes: 93, accent: C.cyan },
];
WebBrowser.maybeCompleteAuthSession();

function Eyebrow({ children }: { children: React.ReactNode }) { return <Text style={styles.eyebrow}>{children}</Text>; }
function Brand() { return <View style={styles.brand}><View style={styles.brandMark}><Text style={styles.brandGlyph}>L</Text></View><View><Text style={styles.brandName}>LAIN <Text style={{ color: C.cyan }}>IO</Text></Text><Text style={styles.brandSub}>LAIN INPUT / OUTPUT</Text></View></View>; }
function Button({ title, onPress, secondary = false }: { title: string; onPress: () => void; secondary?: boolean }) { return <Pressable onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary]}><Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{title}</Text></Pressable>; }

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [page, setPage] = useState<Page>('home');
  const [posts, setPosts] = useState(initialPosts);
  const [draft, setDraft] = useState('');
  const [privateMode, setPrivateMode] = useState(true);
  const [quietMode, setQuietMode] = useState(false);
  const googleClientIdConfigured = Platform.OS === 'ios'
    ? Boolean(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID)
    : Platform.OS === 'android'
      ? Boolean(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID)
      : Boolean(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);
  const [googleRequest, googleResponse, googlePromptAsync] = Google.useAuthRequest({
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || 'not-configured',
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || 'not-configured',
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || 'not-configured',
  });
  const now = useMemo(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), []);
  useEffect(() => {
    if (googleResponse?.type === 'success') setSignedIn(true);
  }, [googleResponse]);
  useEffect(() => {
    if (!signedIn) return;
    const unsubscribe = followFeed((post) => setPosts((current) => current.some((item) => item.id === post.id) ? current : [post, ...current]));
    return () => { unsubscribe(); };
  }, [signedIn]);
  const signInGoogle = () => {
    if (!googleClientIdConfigured) {
      Alert.alert('Google sign-in setup', 'Add the Google OAuth client IDs listed in .env.example, then restart Expo.');
      return;
    }
    if (!googleRequest) return;
    void googlePromptAsync();
  };
  const signInApple = async () => {
    if (Platform.OS !== 'ios') {
      Alert.alert('Apple sign-in', 'Native Apple sign-in is available on iOS.');
      return;
    }
    try {
      const credential = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL, AppleAuthentication.AppleAuthenticationScope.FULL_NAME] });
      if (credential.identityToken) setSignedIn(true);
    } catch (error: any) {
      if (error?.code !== 'ERR_REQUEST_CANCELED') Alert.alert('Apple sign-in', 'Sign-in could not be completed. Check the Apple capability in your development build.');
    }
  };

  if (!signedIn) return <SafeAreaView style={styles.safe}><StatusBar barStyle="light-content" /><ScrollView contentContainerStyle={styles.loginWrap}>
    <View pointerEvents="none" style={styles.ambientPink} /><View pointerEvents="none" style={styles.ambientBlue} />
    <Brand /><View style={styles.loginSpacer} /><Eyebrow>WELCOME TO THE WIRED</Eyebrow><Text style={styles.loginTitle}>Are you{ '\n' }connected?</Text>
    <Text style={styles.loginCopy}>A quieter corner of the network.{ '\n' }Your signal begins here.</Text>
    <View style={styles.signalCard}><View style={styles.signalTop}><View style={styles.pulse} /><Text style={styles.signalLabel}>NETWORK STATUS</Text><Text style={styles.signalLive}>● LIVE</Text></View><View style={styles.wave}>{[20,36,28,48,30,42,18,34,50,27,39,22].map((height, index)=><View key={index} style={[styles.waveBar,{height,backgroundColor:index%3===0?C.cyan:index%3===1?C.pink:C.violet}]} />)}</View><Text style={styles.signalFoot}>“No matter where you go, everyone is connected.”</Text></View>
    <Button title="Continue with Google  ↗" onPress={signInGoogle} /><Button title="Continue with Apple  " secondary onPress={signInApple} />
    <Pressable onPress={() => setSignedIn(true)} style={styles.guest}><Text style={styles.guestText}>ENTER THE WIRED AS A GUEST</Text><Text style={styles.guestArrow}>→</Text></Pressable>
    <Text style={styles.legal}>By continuing, you agree to our Terms of Service and Privacy Policy.</Text>
  </ScrollView></SafeAreaView>;

  const submitPost = () => {
    if (!draft.trim()) return;
    const post: FeedPost = { id: `post-${Date.now()}`, author: 'You', handle: '@wired_guest', body: draft.trim(), time: now, likes: 0, accent: C.pink };
    setPosts((current) => [post, ...current]); publishPost(post); setDraft('');
  };

  const Header = () => <View style={styles.header}><Brand /><Pressable style={styles.avatarSmall} onPress={() => setPage('settings')}><Text style={styles.avatarSmallText}>L</Text></Pressable></View>;
  const Feed = () => <><View style={styles.greeting}><Eyebrow>FRIDAY, NOVEMBER 6</Eyebrow><Text style={styles.pageTitle}>The Wired<Text style={{color:C.pink}}>.</Text></Text><Text style={styles.pageSub}>A place to exist together.</Text></View>
    <View style={styles.composer}><View style={styles.composeRow}><View style={[styles.avatarSmall,{backgroundColor:'#422052'}]}><Text style={styles.avatarSmallText}>Y</Text></View><TextInput value={draft} onChangeText={setDraft} placeholder="What’s on your mind?" placeholderTextColor={C.muted} multiline style={styles.input} /></View><View style={styles.composeFoot}><Text style={styles.composeHint}>↗  POST TO THE WIRED</Text><Pressable onPress={submitPost} style={styles.postBtn}><Text style={styles.postBtnText}>Transmit  ↑</Text></Pressable></View></View>
    <View style={styles.sectionHead}><Eyebrow>RECENT SIGNALS</Eyebrow><Text style={styles.liveCount}>◉  2.4k online</Text></View>
    {posts.map((post) => <View key={post.id} style={styles.postCard}><View style={styles.postHead}><View style={[styles.postAvatar,{borderColor:post.accent}]}><Text style={[styles.postAvatarText,{color:post.accent}]}>{post.author[0]}</Text></View><View style={{flex:1}}><Text style={styles.postAuthor}>{post.author}</Text><Text style={styles.handle}>{post.handle}  ·  {post.time}</Text></View><Text style={styles.more}>···</Text></View><Text style={styles.postBody}>{post.body}</Text><View style={styles.postActions}><Text style={styles.action}>♡  {post.likes}</Text><Text style={styles.action}>◌  18</Text><Text style={styles.action}>↗  Relay</Text><Text style={styles.action}>⌁</Text></View></View>)}
    <View style={styles.quoteCard}><Text style={styles.quoteMark}>“</Text><Text style={styles.quote}>The real world is just another layer of the Wired.</Text><Text style={styles.quoteBy}>— LAIN IWAKURA</Text></View>
  </>;

  const Lain = () => <><View style={styles.greeting}><Eyebrow>IDENTITY / 001</Eyebrow><Text style={styles.pageTitle}>Lain Iwakura</Text><Text style={styles.pageSub}>An observation from the Wired.</Text></View><View style={styles.modelFrame}><View style={styles.modelMeta}><Text style={styles.modelTag}>3D ARCHIVE</Text><Text style={styles.modelStatus}>● RENDERING</Text></View><AvatarScene /><View style={styles.modelCaption}><Text style={styles.modelName}>Lain</Text><Text style={styles.modelHint}>ROTATE · EXPLORE · CONNECT</Text></View></View><View style={styles.infoGrid}><View style={styles.infoCard}><Eyebrow>STATUS</Eyebrow><Text style={styles.infoValue}>Connected</Text></View><View style={styles.infoCard}><Eyebrow>LOCATION</Eyebrow><Text style={styles.infoValue}>The Wired</Text></View></View><View style={styles.postCard}><Eyebrow>ABOUT</Eyebrow><Text style={[styles.postBody,{marginTop:12}]}>A quiet student with a presence that reaches far beyond the boundary between the real world and the network.</Text></View></>;

  const Friends = () => <><View style={styles.greeting}><Eyebrow>YOUR NETWORK</Eyebrow><Text style={styles.pageTitle}>Connections</Text><Text style={styles.pageSub}>People across the boundary.</Text></View><View style={styles.search}><Text style={styles.searchIcon}>⌕</Text><TextInput placeholder="Search the Wired" placeholderTextColor={C.muted} style={styles.searchInput} /></View><View style={styles.friendSummary}><Text style={styles.friendCount}>08 <Text style={styles.friendCountLabel}>CONNECTIONS</Text></Text><Text style={styles.liveCount}>3 online now</Text></View>{[{name:'Lain Iwakura',handle:'@lain',status:'Exploring the Wired',online:true,letter:'L',color:C.pink},{name:'Arisu Mizuki',handle:'@alice',status:'The real world',online:true,letter:'A',color:C.violet},{name:'Chisa Yomoda',handle:'@chisa',status:'Last seen 2 hours ago',online:false,letter:'C',color:C.cyan},{name:'Taro',handle:'@taro',status:'Connected',online:true,letter:'T',color:'#7b82ff'},{name:'Reika Yamamoto',handle:'@reika',status:'Offline',online:false,letter:'R',color:C.sun},{name:'Myu Myu',handle:'@myumyu',status:'Away',online:false,letter:'M',color:'#da74ff'}].map(f=><View key={f.handle} style={styles.friendRow}><View style={[styles.friendAvatar,{backgroundColor:f.color}]}><Text style={styles.friendLetter}>{f.letter}</Text><View style={[styles.onlineDot,{backgroundColor:f.online?C.green:'#665b78'}]} /></View><View style={{flex:1}}><Text style={styles.friendName}>{f.name}</Text><Text style={styles.friendStatus}>{f.handle}  ·  {f.status}</Text></View><Pressable style={styles.messageBtn}><Text style={styles.messageBtnText}>↗</Text></Pressable></View>)}<Button title="＋  Find connections" secondary onPress={()=>Alert.alert('Discovery','Peer discovery will appear here when connected to a Gun relay.')} /></>;

  const Settings = () => <><View style={styles.greeting}><Eyebrow>PREFERENCES</Eyebrow><Text style={styles.pageTitle}>Settings</Text><Text style={styles.pageSub}>Tune your presence in the Wired.</Text></View><View style={styles.settingsProfile}><View style={[styles.friendAvatar,{backgroundColor:'#542567',width:54,height:54}]}><Text style={styles.friendLetter}>L</Text></View><View style={{flex:1}}><Text style={styles.friendName}>Wired Guest</Text><Text style={styles.friendStatus}>@wired_guest</Text></View><Text style={styles.edit}>EDIT  ↗</Text></View><Eyebrow>PRIVACY & PRESENCE</Eyebrow><View style={styles.settingGroup}><SettingRow label="Private presence" detail="Only connections can see when you’re online" value={privateMode} onChange={setPrivateMode}/><SettingRow label="Quiet mode" detail="Pause notifications and mentions" value={quietMode} onChange={setQuietMode}/><SettingRow label="Show activity status" detail="Let others see when you’re active" value={!quietMode} onChange={setQuietMode}/></View><Eyebrow>ACCOUNT</Eyebrow><View style={styles.settingGroup}><SettingLink label="Connected accounts" value="Not linked"/><SettingLink label="Sync & storage" value="GunDB · local peer"/><SettingLink label="Blocked connections" value="0"/><SettingLink label="About Lain IO" value="Version 1.0.0"/></View><Pressable style={styles.signout} onPress={()=>setSignedIn(false)}><Text style={styles.signoutText}>Sign out</Text></Pressable><Text style={styles.settingsFoot}>LAIN INPUT / OUTPUT  ·  {now}</Text></>;

  const content = page === 'home' ? <Feed/> : page === 'lain' ? <Lain/> : page === 'friends' ? <Friends/> : <Settings/>;
  return <SafeAreaView style={styles.safe}><StatusBar barStyle="light-content" /><Header/><ScrollView key={page} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>{content}</ScrollView><View style={styles.tabBar}>{([{id:'home',icon:'⌂',label:'Feed'},{id:'lain',icon:'◉',label:'Lain'},{id:'friends',icon:'◎',label:'Friends'},{id:'settings',icon:'⌘',label:'Settings'}] as {id:Page;icon:string;label:string}[]).map(tab=><Pressable key={tab.id} onPress={()=>setPage(tab.id)} style={styles.tab}><Text style={[styles.tabIcon,page===tab.id&&styles.tabActive]}>{tab.icon}</Text><Text style={[styles.tabLabel,page===tab.id&&styles.tabLabelActive]}>{tab.label}</Text>{page===tab.id&&<View style={styles.tabIndicator}/>}</Pressable>)}</View></SafeAreaView>;
}

function SettingRow({ label, detail, value, onChange }: {label:string;detail:string;value:boolean;onChange:(value:boolean)=>void}) { return <Pressable style={styles.settingRow} onPress={()=>onChange(!value)}><View style={{flex:1,paddingRight:14}}><Text style={styles.settingLabel}>{label}</Text><Text style={styles.settingDetail}>{detail}</Text></View><View style={[styles.toggle,value&&styles.toggleOn]}><View style={[styles.toggleKnob,value&&styles.toggleKnobOn]}/></View></Pressable>; }
function SettingLink({label,value}:{label:string;value:string}) { return <Pressable style={styles.settingRow}><View style={{flex:1}}><Text style={styles.settingLabel}>{label}</Text></View><Text style={styles.settingValue}>{value}</Text><Text style={styles.chevron}>›</Text></Pressable>; }

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:C.bg,paddingTop:Platform.OS==='android'?StatusBar.currentHeight:0},
  loginWrap:{flexGrow:1,paddingHorizontal:26,paddingTop:28,paddingBottom:28},
  ambientPink:{position:'absolute',width:230,height:230,borderRadius:120,backgroundColor:'#28103e',top:115,right:-145},
  ambientBlue:{position:'absolute',width:190,height:190,borderRadius:100,backgroundColor:'#111d3c',top:430,left:-140},
  brand:{flexDirection:'row',alignItems:'center',gap:11},brandMark:{width:38,height:38,borderRadius:12,backgroundColor:C.pink,alignItems:'center',justifyContent:'center',shadowColor:C.pink,shadowOpacity:.5,shadowRadius:14},brandGlyph:{fontSize:23,fontWeight:'800',color:'#fff'},brandName:{color:C.ink,fontSize:15,fontWeight:'800',letterSpacing:2.1},brandSub:{color:C.muted,fontSize:8,letterSpacing:1.7,marginTop:3},loginSpacer:{height:62},eyebrow:{color:C.violet,fontSize:9,fontWeight:'700',letterSpacing:1.8},loginTitle:{color:C.ink,fontSize:48,lineHeight:50,fontWeight:'700',letterSpacing:-2,marginTop:13,textShadowColor:'#e850e0',textShadowRadius:18},loginCopy:{fontSize:14,lineHeight:22,color:'#c8b8df',marginTop:14},
  signalCard:{borderRadius:18,backgroundColor:C.panel,borderWidth:1,borderColor:'#754c94',padding:16,marginTop:27,marginBottom:23,shadowColor:C.violet,shadowOpacity:.16,shadowRadius:16},signalTop:{flexDirection:'row',alignItems:'center'},pulse:{width:7,height:7,borderRadius:5,backgroundColor:C.pink,marginRight:8,shadowColor:C.pink,shadowOpacity:1,shadowRadius:8},signalLabel:{color:C.muted,fontSize:9,letterSpacing:1.5,fontWeight:'700',flex:1},signalLive:{color:C.green,fontSize:9,fontWeight:'700'},wave:{height:58,flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginVertical:9,paddingHorizontal:4},waveBar:{width:3,borderRadius:4,backgroundColor:C.pink,opacity:.9},signalFoot:{color:'#c6b7d6',fontSize:10,fontStyle:'italic'},
  button:{height:52,borderRadius:13,backgroundColor:C.pink,alignItems:'center',justifyContent:'center',marginBottom:10,shadowColor:C.pink,shadowOpacity:.25,shadowRadius:12},buttonSecondary:{backgroundColor:'#211536',borderWidth:1,borderColor:'#5b3b78'},buttonText:{fontSize:14,fontWeight:'700',color:'#190d24'},buttonTextSecondary:{color:C.ink},guest:{height:48,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10},guestText:{fontSize:10,fontWeight:'700',letterSpacing:1.4,color:'#d8c9ea'},guestArrow:{color:C.cyan,fontSize:16},legal:{textAlign:'center',fontSize:9,color:'#82728f',lineHeight:15,marginTop:8},
  header:{height:66,paddingHorizontal:22,borderBottomWidth:1,borderBottomColor:C.line,backgroundColor:'#100a1b',flexDirection:'row',alignItems:'center',justifyContent:'space-between'},avatarSmall:{width:34,height:34,borderRadius:12,backgroundColor:'#542567',borderWidth:1,borderColor:C.pink,alignItems:'center',justifyContent:'center'},avatarSmallText:{color:'#fff',fontWeight:'700'},scrollContent:{paddingHorizontal:20,paddingTop:21,paddingBottom:28},greeting:{marginBottom:20},pageTitle:{color:C.ink,fontSize:31,fontWeight:'700',letterSpacing:-.8,marginTop:8},pageSub:{color:'#bcaed0',fontSize:12,marginTop:5},
  composer:{padding:14,borderRadius:16,backgroundColor:C.panel,borderWidth:1,borderColor:'#50346c',marginBottom:25},composeRow:{flexDirection:'row',gap:11,alignItems:'flex-start'},input:{color:C.ink,minHeight:47,flex:1,fontSize:13,paddingTop:8,textAlignVertical:'top'},composeFoot:{borderTopWidth:1,borderColor:C.line,marginTop:8,paddingTop:11,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},composeHint:{fontSize:8,letterSpacing:1.2,color:C.cyan,fontWeight:'700'},postBtn:{backgroundColor:'#49204f',borderRadius:9,paddingVertical:8,paddingHorizontal:12},postBtnText:{color:C.pink,fontSize:10,fontWeight:'700'},sectionHead:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12},liveCount:{fontSize:9,color:C.green,fontWeight:'600'},
  postCard:{backgroundColor:C.panel,borderRadius:16,borderWidth:1,borderColor:C.line,padding:15,marginBottom:11},postHead:{flexDirection:'row',alignItems:'center',gap:10},postAvatar:{width:37,height:37,borderRadius:13,borderWidth:1,backgroundColor:'#211536',alignItems:'center',justifyContent:'center'},postAvatarText:{fontSize:15,fontWeight:'800'},postAuthor:{color:C.ink,fontSize:12,fontWeight:'700'},handle:{fontSize:9,color:C.muted,marginTop:3},more:{color:C.violet,fontSize:19,marginTop:-8},postBody:{color:'#e6daf2',fontSize:13,lineHeight:21,marginTop:14},postActions:{borderTopWidth:1,borderColor:C.line,marginTop:15,paddingTop:12,flexDirection:'row',justifyContent:'space-between'},action:{fontSize:10,color:C.muted},quoteCard:{borderRadius:16,backgroundColor:'#211333',padding:18,marginTop:7,borderLeftWidth:2,borderLeftColor:C.cyan},quoteMark:{color:C.pink,fontSize:35,lineHeight:36},quote:{color:'#f0e4fc',fontSize:16,lineHeight:23,fontStyle:'italic',marginTop:-5},quoteBy:{fontSize:8,color:C.violet,letterSpacing:1.4,marginTop:13},
  modelFrame:{borderRadius:18,overflow:'hidden',backgroundColor:'#10091e',borderWidth:1,borderColor:'#75509a',shadowColor:C.violet,shadowOpacity:.2,shadowRadius:16},modelMeta:{position:'absolute',zIndex:2,left:14,right:14,top:14,flexDirection:'row',justifyContent:'space-between'},modelTag:{color:C.cyan,fontSize:8,letterSpacing:1.4,fontWeight:'700'},modelStatus:{color:C.green,fontSize:8,fontWeight:'700'},modelCaption:{position:'absolute',zIndex:2,bottom:12,left:14,right:14,flexDirection:'row',alignItems:'flex-end',justifyContent:'space-between'},modelName:{color:'#fff',fontSize:20,fontWeight:'700',textShadowColor:C.pink,textShadowRadius:12},modelHint:{color:'#bd9ee8',fontSize:7,letterSpacing:1.2},infoGrid:{flexDirection:'row',gap:10,marginVertical:12},infoCard:{flex:1,backgroundColor:C.panel,borderWidth:1,borderColor:C.line,borderRadius:14,padding:13},infoValue:{color:C.cyan,fontSize:13,fontWeight:'600',marginTop:8},
  search:{height:45,borderRadius:12,backgroundColor:C.panel,borderWidth:1,borderColor:'#50346c',flexDirection:'row',alignItems:'center',paddingHorizontal:13,marginBottom:18},searchIcon:{fontSize:22,color:C.cyan,marginRight:8},searchInput:{color:C.ink,fontSize:12,flex:1},friendSummary:{flexDirection:'row',alignItems:'baseline',justifyContent:'space-between',marginBottom:13},friendCount:{color:C.ink,fontSize:19,fontWeight:'700'},friendCountLabel:{fontSize:8,color:C.violet,letterSpacing:1.2},friendRow:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:13,borderBottomWidth:1,borderColor:C.line},friendAvatar:{width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'},friendLetter:{color:'#fff',fontWeight:'800',fontSize:16},onlineDot:{position:'absolute',width:9,height:9,borderRadius:5,borderWidth:2,borderColor:C.bg,bottom:0,right:0},friendName:{color:C.ink,fontSize:12,fontWeight:'700'},friendStatus:{color:C.muted,fontSize:9,marginTop:4},messageBtn:{width:32,height:32,borderRadius:10,borderWidth:1,borderColor:'#5b3b78',alignItems:'center',justifyContent:'center'},messageBtnText:{color:C.cyan},
  settingsProfile:{flexDirection:'row',alignItems:'center',gap:12,padding:14,backgroundColor:C.panel,borderRadius:15,borderWidth:1,borderColor:'#50346c',marginBottom:24},edit:{color:C.cyan,fontSize:8,fontWeight:'800',letterSpacing:1},settingGroup:{backgroundColor:C.panel,borderRadius:14,borderWidth:1,borderColor:C.line,marginTop:11,marginBottom:23,overflow:'hidden'},settingRow:{minHeight:58,flexDirection:'row',alignItems:'center',paddingHorizontal:14,borderBottomWidth:1,borderColor:C.line},settingLabel:{fontSize:11,color:C.ink,fontWeight:'600'},settingDetail:{fontSize:9,color:C.muted,marginTop:4},toggle:{width:36,height:21,borderRadius:12,backgroundColor:'#41334f',justifyContent:'center',padding:2},toggleOn:{backgroundColor:'#8b2f88'},toggleKnob:{width:17,height:17,borderRadius:9,backgroundColor:'#b9a8cb'},toggleKnobOn:{alignSelf:'flex-end',backgroundColor:C.cyan},settingValue:{fontSize:9,color:C.muted},chevron:{fontSize:19,color:C.violet,marginLeft:10},signout:{height:44,alignItems:'center',justifyContent:'center',borderRadius:12,borderWidth:1,borderColor:'#823d87',marginTop:3},signoutText:{color:C.pink,fontSize:11,fontWeight:'600'},settingsFoot:{textAlign:'center',color:'#82728f',fontSize:8,letterSpacing:1.4,marginTop:20},
  tabBar:{height:66,marginBottom:40,borderTopWidth:1,borderColor:C.line,backgroundColor:'#100a1b',flexDirection:'row',paddingBottom:4},tab:{flex:1,alignItems:'center',justifyContent:'center',gap:3,position:'relative'},tabIcon:{fontSize:20,color:'#82728f'},tabActive:{color:C.cyan,textShadowColor:C.cyan,textShadowRadius:10},tabLabel:{fontSize:8,color:'#82728f'},tabLabelActive:{color:C.ink},tabIndicator:{position:'absolute',top:0,width:22,height:2,borderRadius:2,backgroundColor:C.pink,shadowColor:C.pink,shadowOpacity:.9,shadowRadius:7},
});
