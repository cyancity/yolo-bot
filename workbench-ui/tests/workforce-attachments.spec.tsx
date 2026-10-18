// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkforceAttachment, WorkforceFilePreview, attachmentKind, isAttachmentUrl, isPreviewableAttachment, safeAttachmentUrl } from '../src/client/workforce-attachments.tsx'
import { WorkforceMessageText } from '../src/client/workforce-message-text.tsx'

afterEach(cleanup)

describe('附件类型识别', () => {
  it('按扩展名识别图片/视频/音频/pdf/文件', () => {
    expect(attachmentKind('https://cdn.example.com/a.png')).toBe('image')
    expect(attachmentKind('https://cdn.example.com/b.JPG')).toBe('image')
    expect(attachmentKind('/wb/api/workforce/materials/m1/clip.mp4')).toBe('video')
    expect(attachmentKind('/wb/api/workforce/materials/m1/语音.m4a')).toBe('audio')
    expect(attachmentKind('/wb/api/workforce/materials/m1/报告.pdf')).toBe('pdf')
    expect(attachmentKind('/wb/api/workforce/materials/m1/表格.xlsx')).toBe('file')
    expect(attachmentKind('/wb/api/workforce/materials/m1/合同.docx')).toBe('file')
    expect(attachmentKind('/wb/api/workforce/materials/m1/笔记.txt')).toBe('file')
  })

  it('无扩展名或扩展名不可信时以 mime 为准', () => {
    expect(attachmentKind('/wb/api/workforce/materials/m1/blob', 'image/png')).toBe('image')
    expect(attachmentKind('/wb/api/workforce/materials/m1/blob', 'video/mp4')).toBe('video')
    expect(attachmentKind('/wb/api/workforce/materials/m1/blob', 'audio/mpeg')).toBe('audio')
    expect(attachmentKind('/wb/api/workforce/materials/m1/伪装.png.exe', 'application/octet-stream')).toBe('file')
    expect(attachmentKind('/wb/api/workforce/materials/m1/x.bin', 'application/pdf')).toBe('pdf')
  })

  it('站内材料与常见文件后缀判定为附件，普通链接不是', () => {
    expect(isAttachmentUrl('/wb/api/workforce/materials/m1/任何.bin')).toBe(true)
    expect(isAttachmentUrl('/wb/api/workforce/tasks/t1/deliverables/文案.txt')).toBe(true)
    expect(isAttachmentUrl('https://example.com/report.pdf?ver=2')).toBe(true)
    expect(isAttachmentUrl('https://example.com/docs/page')).toBe(false)
  })

  it('URL 白名单：http/https 与站内文件路由可渲染，其余剥成纯文本', () => {
    expect(safeAttachmentUrl('/wb/api/workforce/materials/m1/a.png')).toBe('/wb/api/workforce/materials/m1/a.png')
    expect(safeAttachmentUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(safeAttachmentUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeAttachmentUrl('file:///C:/a.png')).toBeUndefined()
    expect(safeAttachmentUrl('/wb/api/workforce/materials/../state.json')).toBeUndefined()
    expect(safeAttachmentUrl('/wb/api/workforce/materials/%2e%2e/state.json')).toBeUndefined()
    expect(safeAttachmentUrl('//evil.example.com/a.png')).toBeUndefined()
    expect(safeAttachmentUrl('/wb/api/workforce/other/x')).toBeUndefined()
  })
  it('识别支持 WorkforceFilePreview 的在线预览类型（图片/视频/音频/PDF/文本/Markdown）', () => {
    expect(isPreviewableAttachment('/a.png')).toBe(true)
    expect(isPreviewableAttachment('/doc.pdf')).toBe(true)
    expect(isPreviewableAttachment('/report.md')).toBe(true)
    expect(isPreviewableAttachment('/script.py')).toBe(true)
    expect(isPreviewableAttachment('/data.json')).toBe(true)
    expect(isPreviewableAttachment('/note.txt')).toBe(true)
    expect(isPreviewableAttachment('/clip.mp4')).toBe(true)
    expect(isPreviewableAttachment('/voice.mp3')).toBe(true)
    expect(isPreviewableAttachment('/sheet.xlsx')).toBe(false)
    expect(isPreviewableAttachment('/pack.zip')).toBe(false)
  })
})

describe('附件卡片渲染', () => {
  const url = '/wb/api/workforce/materials/m1/'
  it('图片出缩略图、视频出播放器、文档出文件卡', () => {
    const { container, unmount } = render(<WorkforceAttachment url={url + '图.png'} sizeBytes={1024} />)
    expect(container.querySelector('[data-attachment-kind="image"]')).toBeTruthy()
    expect(container.querySelector('img[data-message-image]')?.getAttribute('src')).toBe(url + '图.png')
    unmount()
    const video = render(<WorkforceAttachment url={url + '片.mp4'} sizeBytes={2048} />)
    expect(video.container.querySelector('[data-attachment-kind="video"]')).toBeTruthy()
    expect(video.container.querySelector('video')).toBeTruthy()
    video.unmount()
    const doc = render(<WorkforceAttachment url={url + encodeURIComponent('报表.xlsx')} sizeBytes={512} />)
    expect(doc.container.querySelector('[data-attachment-kind="file"]')).toBeTruthy()
    expect(screen.getByText('报表.xlsx')).toBeTruthy()
    // Office：主动作「打开」交给系统应用；下载收进 ⋯ 菜单，不再平铺外链
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '下载' })).toBeNull()
    // 真点菜单「下载」：最终目的地仍是原字节路由 download=1，能力不降级
    const xlsxClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: '更多操作 报表.xlsx' }))
    fireEvent.click(screen.getByText('下载'))
    const xlsxAnchors = xlsxClick.mock.contexts as HTMLAnchorElement[]
    const xlsxAnchor = xlsxAnchors.find(a => a.getAttribute('download') === '报表.xlsx')!
    expect(xlsxAnchor.getAttribute('href')).toBe(`${url}${encodeURIComponent('报表.xlsx')}?download=1`)
    expect(xlsxAnchor.getAttribute('rel')).toContain('noopener')
    xlsxClick.mockRestore()
  })
  it('可预览文件（Markdown/PDF/图片）卡片提供「预览」按钮唤起预览弹窗', () => {
    const md = render(<WorkforceAttachment url={url + encodeURIComponent('方案.md')} name="方案.md" sizeBytes={256} />)
    const previewBtn = screen.getByRole('button', { name: '预览 方案.md' })
    expect(previewBtn).toBeTruthy()
    expect(screen.queryByRole('link', { name: '打开' })).toBeNull()

    // 点击「预览」唤起弹窗
    fireEvent.click(previewBtn)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-label')).toBe('方案.md')
    md.unmount()

    // PDF 附件也是「预览」按钮（主预览统一叫预览，不再叫打开）；未核验字节前绝不把原 URL 交给 iframe
    const pdf = render(<WorkforceAttachment url={url + '报告.pdf'} name="报告.pdf" sizeBytes={1024} />)
    const pdfPreviewBtn = screen.getByRole('button', { name: '预览 报告.pdf' })
    expect(pdfPreviewBtn).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull()
    fireEvent.click(pdfPreviewBtn)
    expect(document.querySelector('iframe')).toBeNull()
    pdf.unmount()

    // 图片附件卡片是「预览图片」按钮（缩略图与卡动作同名）唤起 lightbox
    const img = render(<WorkforceAttachment url={url + 'pic.png'} name="pic.png" sizeBytes={512} />)
    const imgBtns = screen.getAllByRole('button', { name: '预览图片 pic.png' })
    expect(imgBtns.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(imgBtns[0]!)
    expect(document.querySelector('[aria-label="图片预览"]')).toBeTruthy()
    img.unmount()
  })

  it('不可在线预览的二进制文件（zip）走「文件夹」（aria 在资源管理器中显示），真点菜单下载原字节', () => {
    render(<WorkforceAttachment url={url + 'archive.zip'} name="archive.zip" sizeBytes={2048} />)
    // 外部主动作：可见「文件夹」，完整 aria-label 含文件名；jsdom 无桌面会话所以禁用
    const folderBtn = screen.getByRole('button', { name: '在资源管理器中显示 archive.zip' })
    expect(folderBtn).toBeTruthy()
    expect(folderBtn.getAttribute('aria-label')).toBe('在资源管理器中显示 archive.zip')
    expect((folderBtn as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('link', { name: '打开' })).toBeNull()
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull()
    // 真点菜单「下载」：zip 非安装包仍可下载，最终目的地是 download=1 原字节路由
    const zipClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: '更多操作 archive.zip' }))
    fireEvent.click(screen.getByText('下载'))
    const zipAnchors = zipClick.mock.contexts as HTMLAnchorElement[]
    const zipAnchor = zipAnchors.find(a => a.getAttribute('download') === 'archive.zip')!
    expect(zipAnchor.getAttribute('href')).toBe('/wb/api/workforce/materials/m1/archive.zip?download=1')
    expect(zipAnchor.getAttribute('rel')).toContain('noopener')
    zipClick.mockRestore()
  })

  it('不可渲染 URL 退化为纯文本卡，不产生链接与媒体', () => {
    const { container } = render(<WorkforceAttachment url="javascript:alert(1)" name="恶意.txt" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
    expect(container.textContent).toContain('恶意.txt')
    expect(container.textContent).toContain('大小未知')
    // 退化卡仍提供安全的外部动作（完整 aria 含文件名），不给可点击的原 URL
    expect(screen.getByRole('button', { name: '在资源管理器中显示 恶意.txt' })).toBeTruthy()
  })
})

describe('GFM 渲染', () => {
  const noop = () => {}
  it('表格渲染为 table 并带横向滚动容器', () => {
    const { container } = render(<WorkforceMessageText
      text={'| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |'}
      employees={[]} onDm={noop}
    />)
    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    expect(table!.parentElement!.className).toContain('tableScroll')
    expect(screen.getByText('名称')).toBeTruthy()
    expect(screen.getByText('苹果')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
  })

  it('围栏代码块走 CodeBlock 且内容不进 markdown 解析', () => {
    const { container } = render(<WorkforceMessageText
      text={'看代码：\n\n```ts\nconst a: number = 1 | 2\n```'}
      employees={[]} onDm={noop}
    />)
    expect(container.querySelector('section')).toBeTruthy()
    expect(container.textContent).toContain('const a: number = 1 | 2')
    expect(container.querySelector('table')).toBeNull()
  })

  it('行内链接里的站内附件渲染为卡片而非裸链接', () => {
    const { container } = render(<WorkforceMessageText
      text={'成果：[交付文档](/wb/api/workforce/materials/m1/%E4%BA%A4%E4%BB%98.docx)'}
      employees={[]} onDm={noop}
    />)
    expect(container.querySelector('[data-attachment-kind="file"]')).toBeTruthy()
    expect(screen.getByText('交付.docx')).toBeTruthy()
  })
})

describe('WorkforceFilePreview 弹窗预览', () => {
  it('markdown 弹窗具有有界结构、关闭按钮、下载链接并响应关闭动作', async () => {
    const onClose = vi.fn()
    const sampleMarkdown = '# 策划方案\n\n- 任务一\n- 任务二'
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => sampleMarkdown,
    })) as unknown as typeof fetch

    try {
      const { baseElement } = render(
        <WorkforceFilePreview
          url="/wb/api/workforce/tasks/t1/deliverables/%E6%96%B9%E6%A1%88.md?v=1"
          name="方案.md"
          onClose={onClose}
        />
      )

      const dialog = baseElement.querySelector('[role="dialog"]')
      expect(dialog).toBeTruthy()
      expect(dialog?.getAttribute('aria-label')).toBe('方案.md')

      // 检查主题 token 容器 class 是否存在（D2：.scope 类重建浮层 token 环境），保证深浅色变量生效
      expect(dialog?.className).toMatch(/tokens|scope/)

      // 明显的右上角关闭按钮
      const closeBtn = baseElement.querySelector('button[aria-label="关闭文件预览"]')
      expect(closeBtn).toBeTruthy()

      // 底部关闭按钮与下载链接（v 参数保留 + download=1 合并进同一 query）
      const footerCloseBtn = screen.getByRole('button', { name: '关闭' })
      expect(footerCloseBtn).toBeTruthy()
      const downloadLink = screen.getByRole('link', { name: '下载文件' })
      expect(downloadLink.getAttribute('href')).toBe('/wb/api/workforce/tasks/t1/deliverables/%E6%96%B9%E6%A1%88.md?v=1&download=1')

      // 正文加载
      await waitFor(() => {
        expect(screen.getByText('策划方案')).toBeTruthy()
        expect(screen.getByText('任务一')).toBeTruthy()
      })

      // 点击右上角关闭按钮触发 onClose
      fireEvent.click(closeBtn!)
      expect(onClose).toHaveBeenCalledTimes(1)

      // 点击底部关闭按钮触发 onClose
      fireEvent.click(footerCloseBtn)
      expect(onClose).toHaveBeenCalledTimes(2)

      // 按 Escape 键触发 onClose
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(3)

      // 点击遮罩触发 onClose
      const mask = baseElement.querySelector('[class*="overlay"]') ?? baseElement.querySelector('[aria-hidden="true"]')
      expect(mask).toBeTruthy()
      fireEvent.click(mask!)
      expect(onClose).toHaveBeenCalledTimes(4)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  const pdfReader = (bytes: Uint8Array) => {
    let done = false
    return { read: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: bytes })), cancel: async () => {} }
  }
  const pdfFetch = (contentType: string, bytes: Uint8Array) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? contentType : null },
      body: { getReader: () => pdfReader(bytes) },
    })) as unknown as typeof fetch

  it('pdf 弹窗按真实字节异步核验后渲染 blob iframe 与有界结构', async () => {
    const onClose = vi.fn()
    const originalFetch = globalThis.fetch
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    // 合法 PDF：application/pdf MIME + %PDF- 魔数 → 通过核验才生成 blob URL 交给 iframe
    globalThis.fetch = pdfFetch('application/pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]))
    URL.createObjectURL = (() => 'blob:pdf-preview-url') as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    try {
      const { baseElement } = render(
        <WorkforceFilePreview
          url="/wb/api/workforce/tasks/t1/deliverables/report.pdf"
          name="report.pdf"
          onClose={onClose}
        />
      )

      const dialog = baseElement.querySelector('[role="dialog"]')
      expect(dialog).toBeTruthy()
      // 核验通过前不产生任何 iframe，绝不渲染原 URL
      expect(baseElement.querySelector('iframe')).toBeNull()
      await waitFor(() => {
        const iframe = baseElement.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('blob:pdf-preview-url')
      })

      const closeBtn = baseElement.querySelector('button[aria-label="关闭文件预览"]')
      expect(closeBtn).toBeTruthy()
      fireEvent.click(closeBtn!)
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
    }
  })

  it('pdf 弹窗拒绝 MIME 伪装：MIME 非 application/pdf 即失败，只给提示与下载入口，不渲染 iframe', async () => {
    const onClose = vi.fn()
    const originalFetch = globalThis.fetch
    // MIME 是 text/plain：即使字节是 %PDF- 也严格拒绝（不接受声明 mime 回退）
    globalThis.fetch = pdfFetch('text/plain', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))
    try {
      const { baseElement } = render(
        <WorkforceFilePreview
          url="/wb/api/workforce/tasks/t1/deliverables/fake.pdf"
          name="fake.pdf"
          onClose={onClose}
        />
      )
      await waitFor(() => {
        expect(screen.getByText('PDF 文件验证失败或格式不正确，可直接下载查看。')).toBeTruthy()
      })
      expect(baseElement.querySelector('iframe')).toBeNull()
      const downloadLinks = screen.getAllByRole('link', { name: '下载文件' })
      expect(downloadLinks.length).toBeGreaterThanOrEqual(1)
      expect(downloadLinks.some(link => link.getAttribute('href')?.includes('download=1'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('pdf 弹窗拒绝坏魔数：MIME 合法但字节非 %PDF- 时不渲染 iframe，只给提示与下载入口', async () => {
    const onClose = vi.fn()
    const originalFetch = globalThis.fetch
    // MIME 是 application/pdf 但文件头是 HTML 伪装：魔数校验独立生效，仍拒绝
    globalThis.fetch = pdfFetch('application/pdf', new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]))
    try {
      const { baseElement } = render(
        <WorkforceFilePreview
          url="/wb/api/workforce/tasks/t1/deliverables/evil.pdf"
          name="evil.pdf"
          onClose={onClose}
        />
      )
      await waitFor(() => {
        expect(screen.getByText('PDF 文件验证失败或格式不正确，可直接下载查看。')).toBeTruthy()
      })
      expect(baseElement.querySelector('iframe')).toBeNull()
      const downloadLinks = screen.getAllByRole('link', { name: '下载文件' })
      expect(downloadLinks.length).toBeGreaterThanOrEqual(1)
      expect(downloadLinks.some(link => link.getAttribute('href')?.includes('download=1'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
