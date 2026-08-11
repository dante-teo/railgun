import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // plist 5 is ESM-only. Bundle it into Electron's CommonJS main output instead of
      // externalizing it into a runtime require(), which its export map intentionally rejects.
      externalizeDeps: { exclude: ['plist'] }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
