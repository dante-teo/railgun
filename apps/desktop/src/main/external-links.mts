const maximumExternalUrlLength = 4_096
const permittedExternalProtocols = new Set(['http:', 'https:'])

export function validateExternalUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maximumExternalUrlLength ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    return undefined
  }

  try {
    const url = new URL(value)
    return permittedExternalProtocols.has(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

export function handleExternalWindowOpen(
  openExternal: (url: string) => Promise<unknown>,
  value: unknown
): { readonly action: 'deny' } {
  const externalUrl = validateExternalUrl(value)
  if (externalUrl) {
    void openExternal(externalUrl).catch(() => undefined)
  }
  return { action: 'deny' }
}
