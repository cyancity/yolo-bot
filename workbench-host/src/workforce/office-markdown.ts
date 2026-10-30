export type MarkdownBlock =
  | { kind: 'paragraph'; text: string; heading?: number }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'table'; rows: string[][] }

function cells(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  return value.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

function tableStart(lines: string[], index: number): boolean {
  return lines[index].includes('|') && !!lines[index + 1]?.includes('|')
    && cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell))
}

export function parseOfficeMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue }
    if (tableStart(lines, i)) {
      const rows = [cells(lines[i])]
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      blocks.push({ kind: 'table', rows })
      continue
    }
    const heading = lines[i].match(/^ {0,3}(#{1,3})\s+(.+)$/)
    if (heading) { blocks.push({ kind: 'paragraph', text: heading[2].replace(/\s+#+\s*$/, '').trimEnd(), heading: heading[1].length }); i++; continue }
    const list = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/)
    if (list) {
      const ordered = !!list[2]
      const block: MarkdownBlock = { kind: 'list', ordered, start: ordered ? Number(list[2]) : 1, items: [] }
      if (!Number.isSafeInteger(block.start) || block.start < 0 || block.start > 2147483647) throw new Error('列表起始编号超出范围')
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/)
        if (!item || !!item[2] !== ordered) break
        block.items.push(item[3]); i++
      }
      blocks.push(block)
      continue
    }
    const paragraph = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !tableStart(lines, i)
      && !/^ {0,3}#{1,3}\s/.test(lines[i]) && !/^\s*(?:[-+*]|\d+[.)])\s/.test(lines[i])) paragraph.push(lines[i++])
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}
