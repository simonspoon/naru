import type { ReactElement } from 'react'
import type { MarkSkin } from '../../markSkin'
import { blob } from './blob'
import { face } from './face'
import { waveform } from './waveform'

/** The skin implementations by id (`markSkin.ts::MARK_SKIN_IDS`). */
export const SKINS: Record<string, MarkSkin<ReactElement[]>> = { waveform, face, blob }
