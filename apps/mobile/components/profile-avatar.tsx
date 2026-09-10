import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export function ProfileAvatar({ url, size = 40 }: { url: string | null; size?: number }) {
  const tokens = useMobileTokens();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <View
      accessible={false}
      style={[styles.avatar, { width: size, height: size, backgroundColor: tokens.muted }]}
    >
      {url && url !== failedUrl ? (
        <Image
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <NativeSymbol ios="person" android="person-outline" size={size * 0.45} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: 999,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
});
