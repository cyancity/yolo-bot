import { zipOffice } from './office-zip.ts'
import { parseOfficeMarkdown } from './office-markdown.ts'

type Cell = string | number | boolean | null
interface Sheet { name: string; rows: Cell[][] }
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const contentType = 'application/vnd.openxmlformats-officedocument.'
const spreadsheetLiteral = (text: string) => text.replace(/_x[0-9a-f]{4}_/gi, match => `_x005F_${match.slice(1)}`)

function escapeXml(text: string): string {
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text)) throw new Error('内容含 XML 不支持的控制字符或无效 Unicode')
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function packageBase(main: string, parts: Record<string, string>): Record<string, string> {
  return {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(parts).map(([name, type]) => `<Override PartName="/${name}" ContentType="${contentType}${type}"/>`).join('')}</Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="${main}"/></Relationships>`,
  }
}

function runs(text: string, bold = false, italic = false): string {
  const pattern = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*)/g
  const run = (value: string, b: boolean, i: boolean) => `<w:r>${b || i ? `<w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}</w:rPr>` : ''}${value.split('\n').map(line => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('<w:br/>')}</w:r>`
  let output = '', offset = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) output += run(text.slice(offset, match.index), bold, italic)
    output += run(match[2] ?? match[3] ?? match[4], bold || !!match[2] || !!match[3], italic || !!match[2] || !!match[4])
    offset = match.index + match[0].length
  }
  return output + run(text.slice(offset), bold, italic)
}

function paragraph(text: string, properties = '', bold = false): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${runs(text, bold)}</w:p>`
}

function writeDocx(content: string): Buffer {
  const blocks = parseOfficeMarkdown(content)
  const numbering: string[] = []
  const body = blocks.map(block => {
    if (block.kind === 'paragraph') return paragraph(block.text, block.heading ? `<w:pStyle w:val="Heading${block.heading}"/>` : '')
    if (block.kind === 'list') {
      const id = numbering.length + 1
      numbering.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${block.ordered ? 1 : 0}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${block.start}"/></w:lvlOverride></w:num>`)
      return block.items.map(item => paragraph(item, `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`)).join('')
    }
    const width = block.rows.reduce((max, row) => Math.max(max, row.length), 0)
    if (width > 63) throw new Error('Word 表格最多支持 63 列')
    const colWidth = Math.floor(9000 / width)
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge => `<w:${edge} w:val="single" w:sz="4" w:color="B0B0B0"/>`).join('')
    return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: width }, () => `<w:gridCol w:w="${colWidth}"/>`).join('')}</w:tblGrid>${block.rows.map((row, index) => `<w:tr>${index === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: width }, (_, column) => `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>${paragraph(row[column] ?? '', '', index === 0)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
  }).join('')
  const abstracts = [false, true].map((ordered, id) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? '%1.' : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`).join('')
  return zipOffice({
    ...packageBase('word/document.xml', { 'word/document.xml': 'wordprocessingml.document.main+xml', 'word/styles.xml': 'wordprocessingml.styles+xml', 'word/numbering.xml': 'wordprocessingml.numbering+xml' }),
    'word/document.xml': `${XML}<w:document xmlns:w="${W}"><w:body>${body || '<w:p/>'}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/styles.xml': `${XML}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>${[1, 2, 3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - level * 4}"/></w:rPr></w:style>`).join('')}</w:styles>`,
    'word/numbering.xml': `${XML}<w:numbering xmlns:w="${W}">${abstracts}${numbering.join('')}</w:numbering>`,
  })
}

function markdownCell(text: string): Cell {
  const value = text.trim()
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) return Number(value)
  return value
}

function sheetsFrom(content: string): Sheet[] {
  let sheets: unknown
  if (/^\s*[{[]/.test(content)) {
    const parsed: unknown = JSON.parse(content)
    sheets = parsed && typeof parsed === 'object' && 'sheets' in parsed ? parsed.sheets : undefined
  } else {
    sheets = parseOfficeMarkdown(content).filter(block => block.kind === 'table')
      .map((table, i) => ({ name: `Sheet${i + 1}`, rows: table.rows.map(row => row.map(markdownCell)) }))
  }
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 256) throw new Error('xlsx 需要 1 到 256 个工作表：JSON sheets 数组或 Markdown 管道表格')
  const names = new Set<string>()
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== 'object' || typeof sheet.name !== 'string' || !sheet.name.trim()
      || sheet.name.length > 31 || /[\\/\[\]:*?]/.test(sheet.name) || /^'|'$/.test(sheet.name)) throw new Error('工作表名称必须为 1 到 31 字，不能含 \\ / [ ] : * ?，不能以单引号开头或结尾')
    escapeXml(sheet.name)
    const name = sheet.name.toLowerCase()
    if (names.has(name)) throw new Error('工作表名称不能重复（不区分大小写）')
    names.add(name)
    if (!Array.isArray(sheet.rows) || sheet.rows.length > 1048576) throw new Error('rows 必须为数组，最多 1048576 行')
    for (const row of sheet.rows) {
      if (!Array.isArray(row) || row.length > 16384) throw new Error('每行必须为数组，最多 16384 列')
      for (const cell of row) {
        if (cell === null || typeof cell === 'boolean') continue
        if (typeof cell === 'number' && Number.isFinite(cell)) continue
        if (typeof cell === 'string' && cell.length <= 32767) { escapeXml(cell); continue }
        throw new Error('单元格只支持字符串（最多 32767 字）、有限数字、布尔或 null')
      }
    }
  }
  return sheets as Sheet[]
}

function columnName(index: number): string {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result
  return result
}

function sheetXml(sheet: Sheet): string {
  return `${XML}<worksheet xmlns="${S}"><sheetData>${sheet.rows.map((row, index) => `<row r="${index + 1}">${row.map((cell, column) => {
    if (cell === null) return ''
    const attrs = `r="${columnName(column)}${index + 1}"${index === 0 ? ' s="1"' : ''}`
    if (typeof cell === 'number') return `<c ${attrs}><v>${cell}</v></c>`
    if (typeof cell === 'boolean') return `<c ${attrs} t="b"><v>${cell ? 1 : 0}</v></c>`
    // SpreadsheetML interprets _xHHHH_ escapes even in inline strings.
    const value = spreadsheetLiteral(cell)
    return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
  }).join('')}</row>`).join('')}</sheetData></worksheet>`
}

function writeXlsx(content: string): Buffer {
  const sheets = sheetsFrom(content)
  const parts: Record<string, string> = { 'xl/workbook.xml': 'spreadsheetml.sheet.main+xml', 'xl/styles.xml': 'spreadsheetml.styles+xml' }
  sheets.forEach((_, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = 'spreadsheetml.worksheet+xml' })
  const files = packageBase('xl/workbook.xml', parts)
  files['xl/workbook.xml'] = `${XML}<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(spreadsheetLiteral(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
  files['xl/_rels/workbook.xml.rels'] = `${XML}<Relationships xmlns="${P}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`
  files['xl/styles.xml'] = `${XML}<styleSheet xmlns="${S}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheet) })
  return zipOffice(files)
}

export function writeOffice(format: 'docx' | 'xlsx', content: string): Buffer {
  if (typeof content !== 'string' || content.length > 2000000) throw new Error('content 必须为字符串，最多 2000000 字')
  if (format === 'docx') return writeDocx(content)
  if (format === 'xlsx') return writeXlsx(content)
  throw new Error('仅支持写入 docx 或 xlsx')
}
