import type { ReactElement } from 'react'
import type { MarkSkin } from '../../markSkin'
import { waveform } from './waveform'

/** The skin implementations by id (`markSkin.ts::MARK_SKIN_IDS`). */
export const SKINS: Record<string, MarkSkin<ReactElement[]>> = { waveform }
