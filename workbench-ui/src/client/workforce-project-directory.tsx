import { useEffect, useState } from 'react'
import { AutoComplete, Button, Input } from 'antd'
import type { WorkforceSource } from './workforce-source.ts'
import { WF } from './workforce-strings.ts'
import css from './workforce.module.css'

const PROJECT_HISTORY_KEY = 'workbench.project-directories'

function recentDirectories(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROJECT_HISTORY_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
  } catch { return [] }
}

export function ProjectDirectory({ source, channelId, value }: {
  readonly source: WorkforceSource
  readonly channelId: string
  readonly value?: string | undefined
}) {
  const [directory, setDirectory] = useState(value ?? '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState(recentDirectories)
  useEffect(() => { setDirectory(value ?? ''); setMessage('') }, [channelId, value])

  async function save() {
    setBusy(true)
    setMessage('')
    try {
      const channel = await source.patchChannel(channelId, { projectDirectory: directory.trim() || null })
      if (channel.projectDirectory) {
        const next = [channel.projectDirectory, ...recent.filter(item => item !== channel.projectDirectory)].slice(0, 20)
        setRecent(next)
        try { localStorage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(next)) } catch { /* The current channel remains saved. */ }
      }
      setMessage(WF.settings.projectDirectorySaved)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return <div className={css.settingsSection}>
    <label htmlFor="wf-project-directory" className={css.settingsSectionTitle}>{WF.settings.projectDirectory}</label>
    <AutoComplete value={directory} onChange={setDirectory} options={recent.map(path => ({ value: path }))} style={{ width: '100%' }} filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}>
      <Input id="wf-project-directory" />
    </AutoComplete>
    <div className={css.settingsHint}>{WF.settings.projectDirectoryHint}</div>
    <Button onClick={() => void save()} loading={busy}>{WF.settings.projectDirectorySave}</Button>
    {message && <div role="status" className={css.settingsHint}>{message}</div>}
  </div>
}
