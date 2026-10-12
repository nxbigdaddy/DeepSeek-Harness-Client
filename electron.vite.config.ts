import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Anchored to this config file, not process.cwd() — `resolve('src/...')`
// breaks when electron-vite is invoked from another directory.
const src = (p: string): string => fileURLToPath(new URL(`./src/${p}`, import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': src('shared'),
        '@core': src('core')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': src('shared')
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': src('shared')
      }
    }
  }
})
