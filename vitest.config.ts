import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
  },
})
