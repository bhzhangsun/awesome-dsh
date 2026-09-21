import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point the media token store at a throwaway home for every test run, so a test
 * that publishes a media URL can never write into the developer's real
 * `${DSH_HOME}/storages` (the route reads this at first use, not at import).
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-media-home-'))
