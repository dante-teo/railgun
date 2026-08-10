import type { RailgunApi } from '../shared/railgun-api'

declare global {
  interface Window {
    railgun: RailgunApi
  }
}

export {}
