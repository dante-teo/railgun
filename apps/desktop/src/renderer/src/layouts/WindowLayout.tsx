import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

const titleBarVariants = cva('window-drag-region fixed inset-x-0 top-0 z-50', {
  variants: {
    titleBarSize: {
      compact: 'h-10',
      default: 'h-12',
      spacious: 'h-14'
    }
  },
  defaultVariants: {
    titleBarSize: 'default'
  }
})

const contentVariants = cva('min-h-svh', {
  variants: {
    titleBarSize: {
      compact: 'pt-10',
      default: 'pt-12',
      spacious: 'pt-14'
    }
  },
  defaultVariants: {
    titleBarSize: 'default'
  }
})

interface WindowLayoutProps extends VariantProps<typeof titleBarVariants> {
  children?: ReactNode
}

export function WindowLayout({ children, titleBarSize }: WindowLayoutProps): React.JSX.Element {
  return (
    <main className="min-h-svh bg-background">
      <div aria-hidden="true" className={titleBarVariants({ titleBarSize })} />
      <div className={contentVariants({ titleBarSize })}>{children}</div>
    </main>
  )
}
