// 视觉取值只能来自 --wb-* 设计 token（刻度见 docs/design-tokens.md）。
// 颜色、字号、圆角、阴影、间距写字面量会报错；ui/tokens.module.css 是唯一的取值定义处。
// 例外写在这里或行内 `stylelint-disable-next-line ... -- 原因`，不要放宽规则本身。

// 插件按空格把值拆成若干段逐段检查（括号内不拆），所以下面的正则都针对单段。
// 颜色段：不含颜色字面量（hex、rgb/hsl 等函数、white/black）且引用了 CSS 变量，
// 例如 color-mix(in srgb, var(--wb-accent) 12%, transparent)、linear-gradient(var(--a), var(--b))。
const TOKEN_EXPRESSION = String.raw`/^(?![\s\S]*(#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(white|black)\b))[\s\S]*var\(--[\s\S]*$/`

// 字号：token、基于 token 的 calc，或相对父级的 em。
const FONT_SIZE = [
  String.raw`/^var\(--[\w-]+\)$/`,
  String.raw`/^calc\([\s\S]*var\(--[\s\S]*\)$/`,
  String.raw`/^\d*\.?\d+em$/`,
]

// 圆角每段：token、0 或基于 token 的 calc。
const RADIUS = [String.raw`/^(0|var\(--[\w-]+\)|calc\([\s\S]*var\(--[\s\S]*\))$/`]

// 间距（padding / margin / gap 及其分方向属性）每段：0、auto、token，或引用 token 且不含长度字面量的
// calc/clamp/min/max，例如 calc(-1 * var(--wb-space-4))、calc(var(--wb-space-5) + var(--wb-avatar-message-size))。
const SPACING_PROPS = '/^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(row-|column-)?gap$/'
const SPACING = [
  String.raw`/^(0|auto)$/`,
  String.raw`/^var\(--[\w-]+\)$/`,
  String.raw`/^(calc|clamp|min|max)\((?![\s\S]*\d(px|rem|em)\b)[\s\S]*var\(--[\s\S]*\)$/`,
]

// 阴影每段：偏移/模糊/扩散长度、inset，颜色段同 TOKEN_EXPRESSION；整条阴影优先用 --wb-shadow-*。
const SHADOW = [String.raw`/^-?\d*\.?\d+(px)?$/`, 'inset', TOKEN_EXPRESSION]

// 描边简写（border、border-top、outline…）每段：线宽、线型，颜色段同 TOKEN_EXPRESSION。
const STROKE_SHORTHAND = [
  String.raw`/^\d*\.?\d+(px)?$/`,
  String.raw`/^(solid|dashed|dotted|double)$/`,
  TOKEN_EXPRESSION,
]

export default {
  plugins: ['stylelint-declaration-strict-value'],
  rules: {
    'scale-unlimited/declaration-strict-value': [
      ['/color$/', 'background', 'fill', 'stroke', 'box-shadow', 'font-size', '/radius$/', '/^(border(-(top|right|bottom|left))?|outline)$/', SPACING_PROPS],
      {
        ignoreVariables: false,
        ignoreFunctions: false,
        ignoreKeywords: ['transparent', 'currentColor', 'currentcolor', 'inherit', 'initial', 'unset', 'none'],
        ignoreValues: {
          '': [TOKEN_EXPRESSION],
          'font-size': FONT_SIZE,
          '/radius$/': RADIUS,
          'box-shadow': SHADOW,
          '/^(border(-(top|right|bottom|left))?|outline)$/': STROKE_SHORTHAND,
          [SPACING_PROPS]: SPACING,
        },
        message: 'Use a --wb-* design token for "${property}" instead of "${value}" (see docs/design-tokens.md).',
      },
    ],
  },
  overrides: [
    {
      // token 定义文件本身
      files: ['src/client/ui/tokens.module.css'],
      rules: { 'scale-unlimited/declaration-strict-value': null },
    },
  ],
}
