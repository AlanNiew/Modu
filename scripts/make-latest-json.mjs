#!/usr/bin/env node
/**
 * 生成 Tauri updater 需要的 latest.json。
 *
 * 用法：
 *   node scripts/make-latest-json.mjs \
 *     --version 0.3.1 \
 *     --exe "src-tauri/target/release/bundle/nsis/墨读_0.3.1_x64-setup.exe" \
 *     --sig "src-tauri/target/release/bundle/nsis/墨读_0.3.1_x64-setup.exe.sig" \
 *     --notes docs/release-notes/v0.3.1.md \
 *     --out src-tauri/target/release/bundle/nsis/latest.json
 *
 * latest.json 会被上传到 GitHub Release，endpoint 固定为
 * https://github.com/AlanNiew/Modu/releases/latest/download/latest.json
 * —— 因此文件名必须是 latest.json 且挂在「最新」那份 release 上。
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${key} 缺少值`)
    }
    args[key.slice(2)] = value
    i += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const repo = args.repo ?? 'AlanNiew/Modu'
const version = args.version
const exePath = args.exe ? resolve(args.exe) : ''
const sigPath = args.sig ? resolve(args.sig) : ''
const notesPath = args.notes ? resolve(args.notes) : ''
const outPath = args.out ? resolve(args.out) : ''

if (!version || !exePath || !sigPath || !outPath) {
  throw new Error(
    '用法: node scripts/make-latest-json.mjs --version <ver> --exe <安装包> --sig <安装包.sig> [--notes <md>] --out <latest.json>',
  )
}

const exeStat = statSync(exePath)
if (exeStat.size <= 0) throw new Error(`安装包为空: ${exePath}`)
const signature = readFileSync(sigPath, 'utf8').trim()
if (!signature) throw new Error(`签名为空: ${sigPath}`)

let notes = `墨读 v${version}`
if (notesPath) {
  notes = readFileSync(notesPath, 'utf8')
    .replace(/^#\s+.*(\r?\n)+/, '') // 去掉 Markdown 一级标题（Release 标题另填）
    .trim()
}

const fileName = basename(exePath)
const url = `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(fileName)}`

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'windows-x86_64': { signature, url },
  },
}

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`已生成 ${outPath}`)
console.log(`  版本: ${version}`)
console.log(`  安装包: ${fileName} (${(exeStat.size / 1024 / 1024).toFixed(2)} MiB)`)
console.log(`  下载地址: ${url}`)
