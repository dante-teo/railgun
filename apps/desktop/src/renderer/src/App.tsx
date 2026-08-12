import { Navigate, Route, Routes } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ScheduledPage } from '@/pages/ScheduledPage'
import { TasksPage } from '@/pages/TasksPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ThemeProvider } from '@/lib/theme'

function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={350}>
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/scheduled" element={<ScheduledPage />} />
          <Route path="/settings" element={<Navigate replace to="/settings/general" />} />
          <Route path="/settings/:category" element={<SettingsPage />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App
