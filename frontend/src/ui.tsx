import { createContext, useContext, useEffect, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { StyleProp, TextInputProps, TextStyle, ViewStyle } from 'react-native';
import { Moon, ShoppingBag, Sun, X } from './icons';
import type { LucideIcon } from './icons';
import type { Participant } from './model';

const light = {
  background: '#FAF9F7', surface: '#FFFFFF', text: '#252331', muted: '#686473',
  border: '#EAE6E2', soft: '#F5F3F0', accent: '#5C428D', tint: '#F3EDF9',
  action: '#35264D', inverse: '#FFFFFF', danger: '#A53346', green: '#31766B',
};
const dark = {
  background: '#1C1923', surface: '#26222F', text: '#F9F5FD', muted: '#BEB4CA',
  border: '#3C3448', soft: '#2E2939', accent: '#CEB7F8', tint: '#352A49',
  action: '#D5C0F7', inverse: '#2B213A', danger: '#FFA9B9', green: '#92D4C7',
};
const ThemeContext = createContext({ colors: light, darkMode: false, toggle() {} });

export function ThemeProvider({ children }: PropsWithChildren) {
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    try { setDarkMode(window.localStorage.getItem('split-theme') === 'dark'); } catch {}
  }, []);
  function toggle() {
    const next = !darkMode;
    setDarkMode(next);
    try { window.localStorage.setItem('split-theme', next ? 'dark' : 'light'); } catch {}
  }
  return <ThemeContext.Provider value={{ colors: darkMode ? dark : light, darkMode, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

export function Copy({ children, size = 15, weight = '400', muted = false, color, style, heading = false }: PropsWithChildren<{
  size?: number; weight?: TextStyle['fontWeight']; muted?: boolean; color?: string;
  style?: StyleProp<TextStyle>; heading?: boolean;
}>) {
  const { colors } = useTheme();
  return (
    <Text accessibilityRole={heading ? 'header' : undefined} style={[{
      color: color ?? (muted ? colors.muted : colors.text),
      fontFamily: Platform.OS === 'web' ? 'Inter Variable, system-ui, -apple-system, sans-serif' : undefined,
      fontSize: size, fontWeight: weight, lineHeight: Math.round(size * 1.28),
    }, style]}>{children}</Text>
  );
}

export function Price({ children, size = 15, color, weight = '700' }: PropsWithChildren<{
  size?: number; color?: string; weight?: TextStyle['fontWeight'];
}>) {
  return <Copy size={size} color={color} weight={weight} style={{ fontVariant: ['tabular-nums'], letterSpacing: -size / 45 }}>{children}</Copy>;
}

export function Button({ label, onPress, variant = 'primary', icon: Icon, disabled, busy, compact, style }: {
  label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: LucideIcon; disabled?: boolean; busy?: boolean; compact?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const color = variant === 'primary' ? colors.inverse : variant === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled || busy}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [{
        backgroundColor: variant === 'primary' ? colors.action : variant === 'secondary' ? colors.surface : 'transparent',
        borderColor: variant === 'secondary' ? colors.border : 'transparent', borderWidth: 1,
        borderRadius: 12, minHeight: compact ? 36 : 46, paddingHorizontal: compact ? 12 : 17,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        opacity: disabled ? 0.45 : pressed ? 0.75 : hovered ? 0.88 : 1,
      }, style]}>
      {busy ? <ActivityIndicator size="small" color={color} /> : Icon && <Icon color={color} size={17} strokeWidth={1.8} />}
      <Copy size={compact ? 13 : 14} color={color} weight="600">{label}</Copy>
    </Pressable>
  );
}

export function IconButton({ label, icon: Icon, onPress, disabled, size = 36 }: {
  label: string; icon: LucideIcon; onPress: () => void; disabled?: boolean; size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        width: size, height: size, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
        backgroundColor: pressed || hovered ? colors.soft : 'transparent',
        opacity: disabled ? 0.35 : 1,
      })}><Icon size={17} color={colors.muted} strokeWidth={1.8} /></Pressable>
  );
}

export function Avatar({ person, size = 30 }: { person: Participant; size?: number }) {
  return (
    <View accessibilityLabel={person.name} style={{
      width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
      backgroundColor: person.color,
    }}>
      <Copy color="#352842" size={Math.round(size * 0.4)} weight="700">{person.name[0]}</Copy>
    </View>
  );
}

export function AvatarStack({ people, size = 30 }: { people: Participant[]; size?: number }) {
  const { colors } = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 2 }}>
    {people.map((person, index) =>
      <View key={person.id} style={{ marginLeft: index === 0 ? 0 : -size / 5, borderRadius: size, borderWidth: 2, borderColor: colors.surface }}>
        <Avatar person={person} size={size} />
      </View>)}
  </View>;
}

export function Panel({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { colors } = useTheme();
  return <View style={[{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20 }, style]}>{children}</View>;
}

export function Brand({ onPress }: { onPress?: () => void }) {
  const { colors } = useTheme();
  return <Pressable disabled={!onPress} accessibilityRole={onPress ? 'link' : undefined} accessibilityLabel="Split home"
    onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
    <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#D5C3F3', alignItems: 'center', justifyContent: 'center' }}>
      <ShoppingBag color="#3F2B5E" size={17} strokeWidth={1.8} />
    </View>
    <Copy size={27} weight="800" color={colors.text} style={{ letterSpacing: -1.6 }}>split.</Copy>
  </Pressable>;
}

export function ThemeButton() {
  const { darkMode, toggle } = useTheme();
  return <IconButton label={darkMode ? 'Use light mode' : 'Use dark mode'} icon={darkMode ? Sun : Moon} onPress={toggle} />;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { colors } = useTheme();
  return <View style={{ gap: 7 }}>
    <Copy weight="600" size={14}>{label}</Copy>
    <TextInput {...props} accessibilityLabel={label} placeholderTextColor={colors.muted} style={[{
      minHeight: 46, paddingHorizontal: 13, paddingVertical: 9, borderWidth: 1, borderColor: colors.border,
      borderRadius: 10, backgroundColor: colors.background, color: colors.text, fontSize: 16,
    }, props.style]} />
  </View>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { colors } = useTheme();
  return <Modal transparent visible animationType="none" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: '#1C152763', justifyContent: 'center', alignItems: 'center', padding: 14 }}>
      <Pressable onPress={onClose} accessible={false} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <View accessibilityViewIsModal style={{
        width: '100%', maxWidth: 490, maxHeight: '94%', backgroundColor: colors.surface,
        borderRadius: 22, borderWidth: 1, borderColor: colors.border,
      }}>
        <View style={{ paddingTop: 16, paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Copy size={23} weight="700" heading>{title}</Copy>
          <IconButton label="Close dialog" icon={X} onPress={onClose} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20, gap: 16 }}>
          {children}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

export function Notice({ children }: PropsWithChildren) {
  const { colors } = useTheme();
  return <View accessibilityRole="alert" style={{ padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 9 }}>
    <Copy color={colors.danger}>{children}</Copy>
  </View>;
}

