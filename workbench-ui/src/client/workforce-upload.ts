export interface UploadedAttachment {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly sizeBytes?: number
  readonly mime?: string
}

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

/** Escape names both inside link labels and in the human-readable attachment list. */
function markdownText(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&')
}

export function attachmentMessage(text: string, attachments: readonly UploadedAttachment[]): string {
  if (attachments.length === 0) return text
  const links = attachments.map(attachment => {
    const mime = attachment.mime || 'application/octet-stream'
    const title = JSON.stringify({ materialId: attachment.id, sizeBytes: attachment.sizeBytes, mime })
      .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const url = attachment.url.replace(/[\s()<>"\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    const name = markdownText(attachment.name)
    return `- [${name}](${url} "${title}") · 名称：${name} · 类型：${markdownText(mime)} · material id：${markdownText(attachment.id)}`
  })
  return `${text ? `${text}\n\n` : ''}附件：\n${links.join('\n')}`
}
