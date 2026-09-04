import { ALL_CHARACTERS } from '../src/sanguosha/data/characters/standard.ts'
import { huashenEligibilityReport } from '../src/sanguosha/engine/huashen.ts'

const report = huashenEligibilityReport()
const considered = ALL_CHARACTERS.filter((character) => character.pack !== 'entertainment')

console.log(JSON.stringify({
  charactersConsidered: considered.length,
  eligibleSkills: report.eligible.length,
  excludedLimited: report.excludedLimited,
  excludedAwakening: report.excludedAwakening,
  excludedLord: report.excludedLord,
  excludedSelf: report.excludedSelf,
  incompatibleOrdinarySkills: report.incompatibleBug,
}, null, 2))

if (report.incompatibleBug.length > 0) process.exitCode = 1
