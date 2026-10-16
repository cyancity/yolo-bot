import { extname } from 'node:path'

export const MAX_MATERIAL_BYTES = 32 * 1024 * 1024
export const MATERIAL_SIZE_ERROR = '单个附件不能超过 32MiB'

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.jsonl': 'application/x-ndjson', '.ndjson': 'application/x-ndjson',
  '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.py': 'text/plain', '.rb': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain',
  '.java': 'text/plain', '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain',
  '.hpp': 'text/plain', '.cs': 'text/plain', '.swift': 'text/plain', '.kt': 'text/plain',
  '.php': 'text/plain', '.sh': 'text/plain', '.bash': 'text/plain', '.ps1': 'text/plain',
  '.sql': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain',
  '.ini': 'text/plain', '.log': 'text/plain', '.vue': 'text/plain', '.svelte': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation', '.rtf': 'application/rtf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
}

export function materialMime(name: string, supplied?: string): string {
  const known = MIME_BY_EXTENSION[extname(name).toLowerCase()]
  if (known) return known
  const mime = supplied?.split(';')[0]?.trim().toLowerCase()
  return mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream'
}

export function isTextMaterial(mime: string): boolean {
  return mime.startsWith('text/') || ['application/json', 'application/x-ndjson', 'application/xml', 'application/xhtml+xml', 'application/javascript', 'application/ecmascript', 'image/svg+xml'].includes(mime) || mime.endsWith('+json') || mime.endsWith('+xml')
}

export function isActiveMaterial(name: string, mime: string): boolean {
  return /\.(?:html?|xhtml|svgz?|xml|[cm]?js|swf)$/i.test(name)
    || ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/xml', 'text/xml', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'application/x-shockwave-flash'].includes(mime)
    || mime.endsWith('+xml')
}

export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/** 命令行脚本不进文件历史（对用户是内部实现，不是交付物）。 */
const SCRIPT_EXTENSIONS = /^(?:cmd|bat|ps1|psm1|psd1|sh|bash|zsh|fish|csh)$/i
export function isScriptName(name: string): boolean {
  const extension = extname(name).slice(1)
  return extension !== '' && SCRIPT_EXTENSIONS.test(extension)
}

/** 安装包只允许在文件夹中打开，不给字节路由也不内联预览。 */
const INSTALLER_EXTENSIONS = /^(?:exe|msi|msix|appx|dmg|pkg|apk|aab|ipa|rpm|deb|snap|appimage)$/i
export function isInstallerName(name: string): boolean {
  const extension = extname(name).slice(1)
  return extension !== '' && INSTALLER_EXTENSIONS.test(extension)
}

/** 可直接内联预览的 MIME（图片/视频/音频/PDF/文本）；其余（含 Office）默认按附件下载。 */
export function isPreviewableMime(mime: string): boolean {
  const clean = mime.replace(/;.*$/, '').trim().toLowerCase()
  return clean.startsWith('image/') || clean.startsWith('video/') || clean.startsWith('audio/') || clean === 'application/pdf' || isTextMaterial(clean)
}
