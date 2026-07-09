import React from "react";
import { Box, Text } from "ink";
import type { SkinConfig } from "../skins.js";
import { selectedItemStyle, unselectedItemColor } from "./toolLineStyle.js";

interface SuggestionsProps {
  readonly items: readonly string[];
  readonly selectedIndex: number;
  readonly skin: SkinConfig;
}

export const Suggestions = ({
  items,
  selectedIndex,
  skin,
}: SuggestionsProps): React.ReactElement | null => {
  if (items.length === 0) return null;

  const selected = selectedItemStyle(skin);

  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((item, i) => (
        <Text
          key={item}
          color={i === selectedIndex ? selected.color : unselectedItemColor(skin)}
          {...(i === selectedIndex ? { backgroundColor: selected.backgroundColor } : {})}
          bold={i === selectedIndex}
        >
          {item}
        </Text>
      ))}
    </Box>
  );
};
