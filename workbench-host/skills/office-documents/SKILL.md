---
name: office-documents
description: 处理 Word、Excel 与 PPT 文档，规范读取原件、生成标准文件、回读核对并说明排版边界。
license: MIT
---

# Office 文档

## 1. 读取材料原件

用户提供文档文件或需要分析表格、幻灯片内容时读取原件。先调用 `wb_read_material { materialId, stage: true }` 获取本地路径 `localPath`，再调用 `wb_office_read { path: localPath }` 解析内容。
若返回结果提示内容被截断，必须在回复中如实注明截断位置与未读完的页码或行数，禁止假装读取完毕。

## 2. 生成与规范写入

交付格式严格对齐需求：文档输出 docx，数据表格输出 xlsx，调用 `wb_office_write { path, format, content }` 写入。
- docx 格式：正文使用规范 Markdown 子集，仅使用一级到三级标题（`#` 至 `###`）、标准段落、粗体、斜体、无序/有序列表与管道表格。
- xlsx 格式：支持 Markdown 表格或 JSON 结构 `{"sheets":[{"name","rows":[[...]]}]}`。第一行必须是列名表头；数值保持纯数字格式，禁止在单元格内拼接单位后缀；金额与日期使用统一规范格式；包含合计或计算列时，写入前核对总分一致。

## 3. 回读核对与交付

文件写入完成后，先用 `wb_office_read { path }` 回读生成的文件，检查内容完整性、标题层级与表格对齐。
核对无误后调用 `present` 呈报文件，并在正文给出该文件的 Markdown 链接。在频道任务环境中，按需调用 `wb_save_deliverable` 保存成果版本。
交付时向用户说明内容中的数据假设，并告知无法保留的字体、边距或复杂样式。

## 4. 格式与功能边界

- pptx 仅支持读取提取文本，不支持写出。
- 不支持直接处理或导出 PDF，不支持宏（VBA）、复杂多层合并单元格、图表绘制与精细版式。
- 遇到不支持的格式或交互需求时，如实说明限制并提供替代方案（如提供纯净 Markdown 文本或分表数据），严禁将纯文本或扩展名随意重命名为 docx/xlsx 冒充 Office 文件。
