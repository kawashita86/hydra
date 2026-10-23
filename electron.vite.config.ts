import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const appVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // The daemon has no `app.getVersion()` and `npm_package_version` is unset in a packaged app.
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          daemon: resolve(__dirname, 'electron/daemon/index.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [react()]
  }
})
