import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ParsedEmployeeShell {
  command: string
  parameters: Record<string, string | boolean>
}

// Only this host-owned script executes. The employee command is stdin data for ParseInput,
// never an argument to Invoke-Expression, a script block, or a PowerShell execution API.
const PARSER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$inputData.command, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0 -or $ast.ScriptRequirements -or $ast.ParamBlock -or $ast.BeginBlock -or $ast.ProcessBlock -or $ast.DynamicParamBlock -or $ast.UsingStatements.Count -ne 0 -or $ast.EndBlock.Traps.Count -ne 0 -or $ast.EndBlock.Statements.Count -ne 1) { throw 'Expected one static command' }
  if ($ast.PSObject.Properties['CleanBlock'] -and $ast.CleanBlock) { throw 'Clean blocks are forbidden' }
  $pipeline = $ast.EndBlock.Statements[0]
  if ($pipeline -isnot [System.Management.Automation.Language.PipelineAst] -or $pipeline.PipelineElements.Count -ne 1 -or $pipeline.Background) { throw 'Pipelines and background syntax are forbidden' }
  $cmd = $pipeline.PipelineElements[0]
  if ($cmd -isnot [System.Management.Automation.Language.CommandAst] -or $cmd.Redirections.Count -ne 0 -or $cmd.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) { throw 'Expected a direct cmdlet invocation' }
  $elements = $cmd.CommandElements
  if ($elements[0] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $elements[0].StringConstantType -ne [System.Management.Automation.Language.StringConstantType]::BareWord) { throw 'Expected a literal cmdlet name' }
  $name = $elements[0].Value.ToLowerInvariant()
  $shapes = @{
    'get-childitem' = @{ literalpath = 'value'; path = 'value'; recurse = 'switch'; force = 'switch'; directory = 'switch'; file = 'switch'; name = 'switch' }
    'new-item' = @{ path = 'value'; itemtype = 'value'; force = 'switch' }
    'move-item' = @{ literalpath = 'value'; path = 'value'; destination = 'value'; force = 'switch' }
    'remove-item' = @{ literalpath = 'value'; path = 'value'; recurse = 'switch'; force = 'switch' }
  }
  if (-not $shapes.ContainsKey($name)) { throw 'Cmdlet is not permitted' }
  $parameters = @{}
  for ($i = 1; $i -lt $elements.Count; $i++) {
    $parameter = $elements[$i]
    if ($parameter -isnot [System.Management.Automation.Language.CommandParameterAst] -or $parameter.Argument) { throw 'Only explicit named parameters are permitted' }
    $key = $parameter.ParameterName.ToLowerInvariant()
    if (-not $shapes[$name].ContainsKey($key) -or $parameters.ContainsKey($key)) { throw 'Unknown or duplicate parameter' }
    if ($shapes[$name][$key] -eq 'switch') {
      $parameters[$key] = $true
    } else {
      $i++
      if ($i -ge $elements.Count -or $elements[$i] -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { throw 'Parameter values must be literal strings' }
      $parameters[$key] = $elements[$i].Value
    }
  }
  [Console]::Out.Write((@{ command = $name; parameters = $parameters } | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Error.Write('Employee shell requires one approved static cmdlet with literal parameters')
  exit 1
}
`
const ENCODED_PARSER = Buffer.from(PARSER_SCRIPT, 'utf16le').toString('base64')

async function parserExecutable(signal: AbortSignal): Promise<string> {
  const candidates = process.platform === 'win32'
    ? [
      ...[process.env.ProgramW6432, process.env.ProgramFiles].filter((value): value is string => !!value).map(root => join(root, 'PowerShell', '7', 'pwsh.exe')),
      ...(process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')] : []),
    ]
    : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(root => join(root, 'pwsh'))
  for (const candidate of candidates) {
    signal.throwIfAborted()
    try {
      const executable = await realpath(candidate)
      const info = await lstat(executable)
      if (info.isFile() && !info.isSymbolicLink()) return executable
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  signal.throwIfAborted()
  throw new Error('Employee shell unavailable: a trusted host PowerShell parser is required')
}

function parsedResult(text: string): ParsedEmployeeShell {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || !('command' in value) || typeof value.command !== 'string'
    || !('parameters' in value) || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) {
    throw new Error('Invalid host PowerShell parser result')
  }
  const parameters: Record<string, string | boolean> = Object.create(null)
  for (const [key, item] of Object.entries(value.parameters)) {
    if (typeof item !== 'string' && typeof item !== 'boolean') throw new Error('Invalid host PowerShell parameter')
    parameters[key] = item
  }
  return { command: value.command, parameters }
}

export async function parseEmployeeShell(command: string, signal: AbortSignal): Promise<ParsedEmployeeShell> {
  signal.throwIfAborted()
  if (!command.trim() || command.length > 32_768 || command.includes('\0') || command.includes('`')) {
    throw new Error('Employee shell requires a static literal command without escape syntax')
  }
  const executable = await parserExecutable(signal)
  signal.throwIfAborted()
  const { promise, resolve, reject } = Promise.withResolvers<ParsedEmployeeShell>()
  const env = { ...process.env }
  delete env.PSModulePath
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_PARSER], {
    cwd: tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  let size = 0
  let failed: Error | undefined
  const fail = (error: Error) => { failed ??= error; child.kill() }
  const abort = () => child.kill()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => fail(new Error('Host PowerShell parser timed out')), 15_000)
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 131_072) fail(new Error('Host PowerShell parser output exceeded its limit'))
    else stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 131_072) fail(new Error('Host PowerShell parser output exceeded its limit'))
  })
  child.stdin.on('error', error => fail(error))
  child.on('error', error => { failed ??= error })
  child.on('close', code => {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    try {
      signal.throwIfAborted()
      if (failed) throw failed
      if (code !== 0) throw new Error('Employee shell requires one approved static cmdlet with literal parameters')
      resolve(parsedResult(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '')))
    } catch (error) { reject(error) }
  })
  child.stdin.end(JSON.stringify({ command }))
  return promise
}
