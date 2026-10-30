import { posix } from 'node:path'
import { unzipOffice } from './office-zip.ts'
import { attr, children, descendants, localName, parseXml, xmlText, type OfficeXml } from './office-xml.ts'

const MAX_TEXT = 200000
const spreadsheetText = (value: string) => value.replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
const cellText = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
function* table(rows: string[][], rowNumbers?: number[]): Generator<string> {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (!width) return
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => cellText(row[index] ?? '')).join(' | ')} |`
  const firstAtOne = !rowNumbers || rowNumbers[0] === 1
  yield line(firstAtOne ? rows[0]! : []) + '\n'; yield line(Array(width).fill('---')) + '\n'
  let position = 1
  for (let index = firstAtOne ? 1 : 0; index < rows.length; index++) {
    const next = rowNumbers?.[index] ?? position + 1
    while (++position < next) yield line([]) + '\n'
    yield line(rows[index]!) + '\n'
  }
}
function part(entries: Map<string, Buffer>, path: string): OfficeXml {
  const data = entries.get(path)
  if (!data) throw new Error(`Office 文件缺少部件：${path}`)
  return parseXml(data)
}
function relationships(entries: Map<string, Buffer>, source: string): Map<string, string> {
  const path = posix.join(posix.dirname(source), '_rels', `${posix.basename(source)}.rels`)
  const result = new Map<string, string>()
  if (!entries.has(path)) return result
  for (const relation of descendants(part(entries, path), 'Relationship')) {
    if (attr(relation, 'TargetMode') === 'External') continue
    const id = attr(relation, 'Id'), target = attr(relation, 'Target')
    if (id && target) result.set(id, posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(source), target)))
  }
  return result
}
function textRuns(node: OfficeXml): string {
  return node.children.map(child => {
    if (typeof child === 'string') return ''
    const name = localName(child.name)
    return name === 't' ? xmlText(child) : name === 'tab' ? '\t' : name === 'br' || name === 'cr' ? '\n' : textRuns(child)
  }).join('')
}
function* docx(entries: Map<string, Buffer>): Generator<string> {
  const styles = new Map<string, string>()
  if (entries.has('word/styles.xml')) for (const style of descendants(part(entries, 'word/styles.xml'), 'style')) {
    styles.set(attr(style, 'styleId') ?? '', attr(children(style, 'name')[0], 'val') ?? '')
  }
  const body = descendants(part(entries, 'word/document.xml'), 'body')[0]
  if (!body) throw new Error('Word 文档缺少正文')
  function* blocks(node: OfficeXml): Generator<string> {
    for (const block of children(node)) {
      if (localName(block.name) === 'p') {
        const styleId = attr(descendants(block, 'pStyle')[0], 'val') ?? ''
        const heading = /^(?:heading|标题)\s*([1-9])$/i.exec(styles.get(styleId) ?? styleId) ?? /^Heading([1-9])$/i.exec(styleId)
        yield `${heading ? '#'.repeat(Number(heading[1])) + ' ' : ''}${textRuns(block)}\n\n`
      } else if (localName(block.name) === 'tbl') {
        yield* table(children(block, 'tr').map(row => children(row, 'tc').map(cell => descendants(cell, 'p').map(textRuns).join('\n'))))
        yield '\n'
      } else yield* blocks(block)
    }
  }
  yield* blocks(body)
}
function column(reference: string): number {
  const letters = /^([A-Z]+)[1-9]\d*$/.exec(reference)?.[1]
  if (!letters) throw new Error('Excel 单元格地址无效')
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  if (value > 16384) throw new Error('Excel 列超出范围')
  return value - 1
}
function* xlsx(entries: Map<string, Buffer>): Generator<string> {
  const workbook = part(entries, 'xl/workbook.xml'), links = relationships(entries, 'xl/workbook.xml')
  const shared = entries.has('xl/sharedStrings.xml') ? descendants(part(entries, 'xl/sharedStrings.xml'), 'si').map(node => spreadsheetText(descendants(node, 't').map(xmlText).join(''))) : []
  yield '注：日期/时间单元格按原始数值输出，未转换为日历日期。\n\n'
  for (const sheet of descendants(workbook, 'sheet')) {
    yield `## ${spreadsheetText(attr(sheet, 'name') ?? '工作表')}\n\n`
    const path = links.get(attr(sheet, 'id') ?? '')
    if (!path) throw new Error('Excel 工作表关系缺失')
    const data = descendants(part(entries, path), 'sheetData')[0]
    if (!data) continue
    const rows: string[][] = [], rowNumbers: number[] = []
    for (const row of children(data, 'row')) {
      const rowNumber = Number(attr(row, 'r') ?? (rowNumbers.at(-1) ?? 0) + 1)
      if (!Number.isInteger(rowNumber) || rowNumber <= (rowNumbers.at(-1) ?? 0) || rowNumber > 1048576) throw new Error('Excel 行号无效或未按顺序排列')
      const values: string[] = []
      for (const cell of children(row, 'c')) {
        const position = attr(cell, 'r') ? column(attr(cell, 'r')!) : values.length
        const type = attr(cell, 't'), value = xmlText(children(cell, 'v')[0] ?? { name: '', attrs: {}, children: [] })
        values[position] = type === 's' ? shared[Number(value)] ?? '' : type === 'inlineStr' ? spreadsheetText(descendants(cell, 't').map(xmlText).join('')) : type === 'b' ? value === '1' ? 'TRUE' : 'FALSE' : type === 'str' ? spreadsheetText(value) : value
      }
      rows.push(values)
      rowNumbers.push(rowNumber)
    }
    if (rows.length) {
      yield* table(rows, rowNumbers)
      yield '\n'
    }
  }
}
function* pptx(entries: Map<string, Buffer>): Generator<string> {
  const presentation = part(entries, 'ppt/presentation.xml'), links = relationships(entries, 'ppt/presentation.xml')
  let page = 0
  for (const slide of descendants(presentation, 'sldId')) {
    // The unqualified id is numeric; r:id points to the slide relationship.
    const path = links.get(Object.entries(slide.attrs).find(([key]) => key.includes(':') && localName(key) === 'id')?.[1] ?? '')
    if (!path) throw new Error('PowerPoint 幻灯片关系缺失')
    yield `## 第 ${++page} 页\n\n`
    for (const paragraph of descendants(part(entries, path), 'p')) yield textRuns(paragraph) + '\n'
    yield '\n'
  }
}
export function readOffice(data: Buffer, format: string): { text: string; truncated: boolean } {
  const entries = unzipOffice(data)
  const reader = format === 'docx' ? docx : format === 'xlsx' ? xlsx : format === 'pptx' ? pptx : undefined
  if (!reader) throw new Error('只支持读取 docx、xlsx、pptx；不支持 PDF')
  let text = ''
  for (const block of reader(entries)) {
    if (text.length + block.length > MAX_TEXT) return { text: (text + block).slice(0, MAX_TEXT), truncated: true }
    text += block
  }
  return { text: text.trimEnd(), truncated: false }
}
