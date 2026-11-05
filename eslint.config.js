import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 构建产物、第三方内核、Tauri 生成文件都不参与 lint
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/**',
      'src/renderer/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 本项目的 foliate 内核要求在同一个 effect 里长期持有回调/设置的最新值，
      // 「渲染期写 ref / effect 里同步 setState」这两条是刻意为之（且已有两端验证），
      // 关掉以免每次改动都要拆掉这套 ref 转发。
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // Radix / 自定义元素会让 compiler 分析直接跳过，这条只报「跳过」不报问题
      'react-hooks/incompatible-library': 'off',
      // 中文项目里「未使用」多为有意保留的解构占位（如迁移时剔除旧字段）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 阅读器内核是 JS 互操作，个别地方确实需要 any
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
