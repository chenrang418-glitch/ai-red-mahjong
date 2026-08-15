import { defineConfig } from 'vite'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const configDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: resolve(configDirectory, 'dist'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: resolve(configDirectory, 'worker.ts'),
      formats: ['es'],
      fileName: 'worker',
    },
  },
})
