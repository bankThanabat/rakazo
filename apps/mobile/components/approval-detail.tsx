import { useRef } from "react";
import type { TextProps } from "react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ApprovalDetail({
  detail,
  textProps,
  plain = false,
}: {
  detail: string;
  plain?: boolean;
  textProps?: Pick<TextProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">;
}) {
  const scroll = useRef<ScrollView>(null);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View>
      {detail.length > 2000 && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap" }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => scroll.current?.scrollTo({ y: 0, animated: false })}
            style={styles.navigationButton}
          >
            <Text style={{ color: tokens.foreground }}>{t("Beginning")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => scroll.current?.scrollToEnd({ animated: false })}
            style={styles.navigationButton}
          >
            <Text style={{ color: tokens.foreground }}>{t("End")}</Text>
          </Pressable>
        </View>
      )}
      <ScrollView ref={scroll} nestedScrollEnabled style={{ maxHeight: 280 }}>
        {/* iOS cannot paint a single text view containing a full large document. */}
        {detail.match(/.{1,2000}/gsu)?.map((part, index) => (
          <Text
            key={index}
            selectable
            {...textProps}
            style={{
              color: plain ? tokens.foreground : tokens.mutedForeground,
              fontSize: plain ? 14 : 12.5,
              fontFamily: plain ? undefined : "Menlo",
              lineHeight: 20,
            }}
          >
            {part}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  navigationButton: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 8,
    justifyContent: "center",
  },
});
