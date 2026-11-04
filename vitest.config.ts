import { defineConfig } from 'vitest/config'

// 前端单测：纯逻辑（定位、TOC 树、设置持久化），不启动 WebView。
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
