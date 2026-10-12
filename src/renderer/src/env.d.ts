/// <reference types="vite/client" />
import type { DsApi } from '@shared/ipc'

declare global {
  interface Window {
    dsh: DsApi
  }
}

export {}
