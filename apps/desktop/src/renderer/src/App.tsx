import { Route, Routes } from 'react-router'

import { EmptyPage } from '@/pages/EmptyPage'

function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<EmptyPage />} />
    </Routes>
  )
}

export default App
