# Morph Bot 头像来源

本目录的渲染 JavaScript 来源于 `~/workspace/yolo-project/grok-bot-design-study/demo/morph-bot`，源提交 `10fcbb97c3fc0e9b30ebf2eebf1a4d00772e0e77`。

真源基于 [iduu/grokbot-animation](https://github.com/iduu/grokbot-animation) `6c27d96`，并包含默认脸转正、idle 表情池收敛、身体跟随三处行为修正，以及后续形体、材质和物理实现。SVG 模板与配置适配位于相邻的 `workforce-avatar-motion.ts`，不复制语音、TTS 或音频资源。

默认形体 `blob` 以及八套材质选择参考 `~/workspace/yolo-project/danmaku-live/app/renderer/mate.js` 的实际 THEMES：aurora、prism、candy、iridescent-orb、electric-dusk、ocean-signal、mint-violet、peach-sky。配色数值由真源 `materials.js` 维护。

项目维护者已确认，本次 Morph Bot 头像公开分发获得授权。来源素材与上游实现的权利仍归原权利人；此说明不将上游整体或参考素材声明为本项目 MIT 原创代码。

为遵守单文件 500 行限制，真源 runtime/svg-renderer.js 按现有导出函数边界等价拆为 svg-renderer.js 与 svg-effects.js；渲染器重导出效果函数，调用接口保持一致。其余 12 个来源 JavaScript 文件原样保留，仅有两处本地适配：一是 `grok-bot-engine.js` 构造函数查询的结构 id（head-path、head-clip-path、bot-transform、notify-badge、particles-back、particles-front）跟随 svg 实例 id 前缀（模板同步加前缀），同文档多头像挂载时不产生重复 id，无 id 的 svg 退回来源静态命名；二是 `svg-renderer.js` 的眼睛指针偏移乘 `config.pointerGain`（默认 1 等于来源行为），用于小尺寸头像也能看清视线跟随。更新时同步真源，再保持这处分拆与本地适配。`.d.ts` 是本项目消费引擎时的最小类型边界。
