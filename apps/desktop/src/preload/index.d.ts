import type { RailgunApi } from '../shared/task-api'

declare global {
  interface Window {
    railgun: RailgunApi
  }
}

export {}
