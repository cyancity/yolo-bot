/** Ambient module class map for the package's `*.module.css` imports. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const content: string
  export default content
}
