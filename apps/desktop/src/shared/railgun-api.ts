import type { ActivityApi } from './activity-api'
import type { TaskApi } from './task-api'

export interface RailgunApi {
  activity: ActivityApi
  tasks: TaskApi
}
