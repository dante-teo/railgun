import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "./theme.js";
import { selectedItemStyle, unselectedItemColor } from "./toolLineStyle.js";

interface SuggestionsProps {
  readonly items: readonly string[];
  readonly selectedIndex: number;
  readonly theme: Theme;
}

export const Suggestions = ({
  items,
  selectedIndex,
  theme,
}: SuggestionsProps): React.ReactElement | null => {
  if (items.length === 0) return null;

  const selected = selectedItemStyle(theme);

  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((item, i) => (
        <Text
          key={item}
          color={i === selectedIndex ? selected.color : unselectedItemColor(theme)}
          {...(i === selectedIndex ? { backgroundColor: selected.backgroundColor } : {})}
          bold={i === selectedIndex}
        >
          {item}
        </Text>
      ))}
    </Box>
  );
};
