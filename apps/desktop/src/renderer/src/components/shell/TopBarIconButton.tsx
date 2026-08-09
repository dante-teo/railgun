import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type TopBarIconButtonProps = Omit<
  ComponentProps<typeof Button>,
  'aria-label' | 'size' | 'type' | 'variant'
> & {
  'aria-label': string
}

export function TopBarIconButton({
  className,
  ...props
}: TopBarIconButtonProps): React.JSX.Element {
  return (
    <Button
      {...props}
      className={cn('window-no-drag', className)}
      size="icon-sm"
      type="button"
      variant="topbar"
    />
  )
}
