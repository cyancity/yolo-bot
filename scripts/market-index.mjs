// 把两个包的当前版本写进 DSH 插件市场索引 market/index.json，并用官方校验器检查格式。
// 用法：发版前 `pnpm market`；索引发布地址见 INDEX_URL，DSH 设置里添加一次后即可在发现页看到更新。
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexFile = path.join(repo, 'market', 'index.json')
export const INDEX_URL = 'https://raw.githubusercontent.com/cyancity/yolo-bot/main/market/index.json'

const plugins = [
  {
    dir: 'workbench-host',
    title: { en: 'YOLO Bot', zh: 'YOLO Bot' },
    description: {
      en: 'Bot collaboration backend: channels, employees, lead dispatch, deliverables, memory and skills. Install together with YOLO Bot UI of the same version.',
      zh: 'Bot 协作后端：频道、员工、负责人派工、成果、记忆与技能。需与同版本的 YOLO Bot UI 一起安装。',
    },
  },
  {
    dir: 'workbench-ui',
    title: { en: 'YOLO Bot UI', zh: 'YOLO Bot 界面' },
    description: {
      en: 'Web UI for YOLO Bot: channels, direct messages, employees and the task hall. Install together with YOLO Bot of the same version.',
      zh: 'YOLO Bot 的网页界面：频道、私信、员工与任务大厅。需与同版本的 YOLO Bot 一起安装。',
    },
  },
]

const index = JSON.parse(await readFile(indexFile, 'utf8').catch(() => 'null')) ?? {
  format: 1,
  title: { en: 'YOLO Bot', zh: 'YOLO Bot' },
  description: { en: 'Official index of YOLO Bot plugins.', zh: 'YOLO Bot 官方插件索引。' },
  plugins: [],
}
const now = Math.floor(Date.now() / 1000)
const versions = new Set()
for (const plugin of plugins) {
  const manifest = JSON.parse(await readFile(path.join(repo, plugin.dir, 'package.json'), 'utf8'))
  if (typeof manifest.engines?.dsh !== 'string') throw new Error(`${manifest.name} 缺少 engines.dsh`)
  versions.add(manifest.version)
  let entry = index.plugins.find(item => item.name === manifest.name)
  if (entry === undefined) {
    entry = { name: manifest.name, versions: [] }
    index.plugins.push(entry)
  }
  Object.assign(entry, {
    title: plugin.title,
    description: plugin.description,
    author: 'cyancity',
    homepage: 'https://github.com/cyancity/yolo-bot',
    repository: { url: 'https://github.com/cyancity/yolo-bot', directory: plugin.dir },
    metadata: { keywords: ['bot', 'agents', 'workbench'] },
  })
  const previous = entry.versions.find(item => item.version === manifest.version)
  const version = {
    version: manifest.version,
    publishTimestamp: previous?.publishTimestamp ?? now,
    source: { type: 'npm' },
    engines: { dsh: manifest.engines.dsh },
  }
  entry.versions = [version, ...entry.versions.filter(item => item.version !== manifest.version)]
}
// 后端与界面必须同版本发布，否则市场会给出无法配对的组合。
if (versions.size !== 1) throw new Error(`两个包版本不一致：${[...versions].join('、')}`)

// 官方校验器报错即中止；版本按它给出的 SemVer 降序写回。
const parsed = parseMarketIndex(index, INDEX_URL)
for (const plugin of index.plugins) {
  const order = parsed.plugins.find(item => item.name === plugin.name).versions.map(item => item.version)
  plugin.versions.sort((a, b) => order.indexOf(a.version) - order.indexOf(b.version))
}
await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n')
console.log(`market/index.json 已写入 ${[...versions][0]}`)
