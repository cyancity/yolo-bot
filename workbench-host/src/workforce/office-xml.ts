export interface OfficeXml { name: string; attrs: Record<string, string>; children: Array<OfficeXml | string> }
function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) throw new Error('Office XML 字符无效')
      return String.fromCodePoint(number)
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity]!
  })
}

/** OOXML needs elements, attributes and text only; DTD/entity expansion is deliberately unsupported. */
export function parseXml(source: Buffer | string): OfficeXml {
  const xml = typeof source === 'string' ? source : source[0] === 0xff && source[1] === 0xfe ? source.subarray(2).toString('utf16le') : source.toString('utf8')
  const root: OfficeXml = { name: '', attrs: {}, children: [] }, stack = [root]
  let nodes = 0
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g)) {
    const token = match[0], parent = stack.at(-1)!
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (token.startsWith('<![CDATA[')) { parent.children.push(token.slice(9, -3)); continue }
    if (token.startsWith('<!')) throw new Error('Office XML 不允许 DTD 或实体声明')
    if (token.startsWith('</')) {
      if (stack.length === 1 || stack.pop()!.name !== token.slice(2, -1).trim()) throw new Error('Office XML 标签不匹配')
    } else if (token.startsWith('<')) {
      const name = /^<([^\s/>]+)/.exec(token)?.[1]
      if (!name || ++nodes > 1000000 || stack.length > 256) throw new Error('Office XML 无效或过于复杂')
      const node: OfficeXml = { name, attrs: {}, children: [] }
      for (const attribute of token.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[attribute[1]!] = decode(attribute[2] ?? attribute[3]!)
      parent.children.push(node)
      if (!token.endsWith('/>')) stack.push(node)
    } else parent.children.push(decode(token))
  }
  if (stack.length !== 1) throw new Error('Office XML 未闭合')
  return root
}
export const localName = (name: string): string => name.split(':').at(-1)!
export function children(node: OfficeXml, name?: string): OfficeXml[] {
  return node.children.filter((child): child is OfficeXml => typeof child !== 'string' && (!name || localName(child.name) === name))
}
export function descendants(node: OfficeXml, name: string): OfficeXml[] {
  return children(node).flatMap(child => [...(localName(child.name) === name ? [child] : []), ...descendants(child, name)])
}
export function xmlText(node: OfficeXml): string { return node.children.map(child => typeof child === 'string' ? child : xmlText(child)).join('') }
export function attr(node: OfficeXml | undefined, name: string): string | undefined {
  return node && Object.entries(node.attrs).find(([key]) => localName(key) === name)?.[1]
}
