import React from "react";
import { Box, Text } from "ink";

interface SuggestionsProps {
  readonly items: readonly string[];
  readonly selectedIndex: number;
}

export const Suggestions = ({
  items,
  selectedIndex,
}: SuggestionsProps): React.ReactElement | null => {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((item, i) => (
        <Text
          key={item}
          color={i === selectedIndex ? "black" : "gray"}
          {...(i === selectedIndex ? { backgroundColor: "cyan" } : {})}
          bold={i === selectedIndex}
        >
          {item}
        </Text>
      ))}
    </Box>
  );
};
