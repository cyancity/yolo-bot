// Lobe owns appearance; local CSS may describe business layout.
const TOKEN_EXPRESSION = String.raw`/^(?![\s\S]*(#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(white|black)\b))[\s\S]*var\(--[\s\S]*$/`

export default {
  plugins: ['stylelint-declaration-strict-value'],
  rules: {
    'scale-unlimited/declaration-strict-value': [
      ['/color$/', 'background', 'fill', 'stroke', 'box-shadow'],
      {
        ignoreVariables: false,
        ignoreFunctions: false,
        ignoreKeywords: ['transparent', 'currentColor', 'currentcolor', 'inherit', 'initial', 'unset', 'none'],
        ignoreValues: {
          '': [TOKEN_EXPRESSION],
          'box-shadow': [String.raw`/^-?\d*\.?\d+(px)?$/`, 'inset', TOKEN_EXPRESSION],
        },
        message: 'Use a native Lobe theme alias for "${property}" instead of "${value}".',
      },
    ],
  },
  overrides: [
    {
      // Token definitions and avatar illustration data are not component skins.
      files: ['src/client/ui/tokens.module.css', 'src/client/workforce-avatar.module.css'],
      rules: { 'scale-unlimited/declaration-strict-value': null },
    },
  ],
}
