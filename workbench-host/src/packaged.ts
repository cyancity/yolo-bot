/**
 * Packaged-app path fixup. In the Electron bundle the plugin lives inside
 * app.asar; files passed to external tools (including skill resources) ship
 * via electron-builder `asarUnpack`, mirrored
 * under app.asar.unpacked. In-process reads (readdir/readFile) work inside
 * the archive, so only paths handed to another process need the remap.
 */
import { existsSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Remap an app.asar-internal path to its app.asar.unpacked mirror when that
 * mirror exists on disk; returns the input unchanged in a development tree
 * and for files that are not unpacked.
 */
export function packagedPath(path: string): string {
  const unpacked = path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  return unpacked !== path && existsSync(unpacked) ? unpacked : path
}
