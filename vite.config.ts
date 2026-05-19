import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase'
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) return 'vendor-katex'
          if (/[\\/]node_modules[\\/]@sentry[\\/]/.test(id)) return 'vendor-sentry'
          return undefined
        },
      },
    },
  },
})
