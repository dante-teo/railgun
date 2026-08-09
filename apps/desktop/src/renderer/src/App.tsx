import { Route, Routes } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { TasksPage } from '@/pages/TasksPage'

function App(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={350}>
      <Routes>
        <Route path="/" element={<TasksPage />} />
      </Routes>
    </TooltipProvider>
  )
}

export default App
