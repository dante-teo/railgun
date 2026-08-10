const tokenFormatter = new Intl.NumberFormat('en-US')

export interface ContextUsageValues {
  contextWindow: number
  usedTokens: number | null
}

export interface ContextUsagePresentation {
  accessibilityText: string
  detailText: string
  percentage: number | null
  visualPercentage: number
}

export function contextUsagePresentation({
  contextWindow,
  usedTokens
}: ContextUsageValues): ContextUsagePresentation {
  if (usedTokens === null || contextWindow <= 0) {
    return {
      accessibilityText: 'Context usage not measured yet',
      detailText: 'Not measured yet',
      percentage: null,
      visualPercentage: 0
    }
  }

  const percentage = Math.floor((usedTokens * 100) / contextWindow)
  return {
    accessibilityText: `Latest provider-reported input plus output tokens: ${tokenFormatter.format(usedTokens)} of ${tokenFormatter.format(contextWindow)} tokens, ${percentage} percent`,
    detailText: `${tokenFormatter.format(usedTokens)} of ${tokenFormatter.format(contextWindow)}`,
    percentage,
    visualPercentage: Math.min((usedTokens * 100) / contextWindow, 100)
  }
}
