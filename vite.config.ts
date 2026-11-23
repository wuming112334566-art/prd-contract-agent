import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiMiddleware } from './server/handler'
import { resolveConfig } from './server/config'

export default defineConfig(({ mode }) => {
  const config = resolveConfig(loadEnv(mode, process.cwd(), ''))
  const api = (): Plugin => ({
    name: 'contract-agent-api',
    configureServer(server) {
      server.middlewares.use('/api', createApiMiddleware(config))
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api', createApiMiddleware(config))
    },
  })

  return {
    plugins: [react(), api()],
    // 编辑器原子写会产出 .tmpdir 临时目录，被文件监听抓到会 EBUSY 崩溃
    server: { port: 5180, watch: { ignored: ['**/*.tmpdir/**'] } },
    preview: { port: 5180 },
  }
})
