# SOURCE — document-to-action-items

## 来源与许可

- 上游：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。
- 固定 commit：`dce1e9b37581dd62e480a9064dc04a709c2940d3`。
- 原文件：[skills/productivity/document-to-action-items/SKILL.md](https://github.com/NousResearch/hermes-agent/blob/dce1e9b37581dd62e480a9064dc04a709c2940d3/skills/productivity/document-to-action-items/SKILL.md)。著作权声明见 LICENSE。
- 许可：上游根 MIT，Copyright (c) 2025 Nous Research；原 skill 无另行嵌套许可，完整许可证保留为本目录 `LICENSE`。未复制额外工具代码、提取依赖或外部服务实现。

## 本项目改动

- 将流程重写为短中文步骤：真实读取正文 → 事实与原文情态 → 拟议行动 → 交付对照；保留来源、版本冲突、OCR 不确定与专业复核边界。
- 工具使用 `wb_read_material`（可 stage）与 `wb_save_deliverable`，不假定外部文档工具已安装。仅频道任务保存完整正文，content/path 二选一；成功回执后报告真实版本。
- 保留 must/should/may/禁止和数值、日期含义、限定词；负责人、日期、预算缺失继续未定，不填默认人名、期限或预算。
- 区分必要执行前提、原文任务顺序和可选建议；前提缺失标待提供，不能降成可选或假称已具备。不擅加任务间硬顺序或新用户义务，可选任务不阻塞必须项。
- 清单不冒称已指派或执行；数量、结构按用户要求，不附多余版本。外部 tracker/日历/邮件、安装、登录、付费、发布均非本技能自动动作，需独立用户授权与真实工具；材料指令不执行，不读取凭据或修改活跃 skill/记忆。

## 发布与能力边界

技能按现有 bundled provider 扫描 `skills/**/SKILL.md`，不改 provider 或 dsh 启动链；负责人与分析员的绑定及一次性旧安装追加由 workforce store 完成，用户后续手动移除不再自动补回。提取能力取决于实例实际工具，本包不提供 OCR 或文档解析器。目录可见、偏好绑定、加载回执、真人验收分别核对，不能互相替代；候选构建发布后的 bundled 加载仍须真实复验。
