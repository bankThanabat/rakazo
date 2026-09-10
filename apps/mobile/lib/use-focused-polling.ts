import { usePolling } from "@rakazo/chat-ui/async-state";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

export function useFocusedPolling<T>(load: () => Promise<T>, key: string, interval: number) {
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return usePolling(load, focused ? key : null, interval);
}
