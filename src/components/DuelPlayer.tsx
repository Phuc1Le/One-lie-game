import { LockKeyhole, UserRound } from 'lucide-react'
import type { LobbySeat } from '../schemas/lobby-schema'

export default function DuelPlayer({ player, own, word, status, active, seconds, progress, revealed }: {
  player: LobbySeat; own: boolean; word?: string; status: string
  active?: boolean; seconds?: number | null; progress?: number; revealed?: boolean
}) {
  return <section className={`duel-player duel-player-${player.seat === 1 ? 'left' : 'right'} ${active ? 'duel-player-active' : ''}`} data-testid={`duel-player-${player.seat}`} aria-label={own ? 'Your player' : 'Opponent'}>
    <div className={`duel-secret ${(own || revealed) && word !== undefined ? 'duel-secret-revealed' : ''}`}>
      {(own || revealed) && word !== undefined ? <span data-testid={own ? 'own-secret-word' : 'revealed-opponent-word'}>{word || 'Empty word'}</span> : <span data-testid={own ? 'own-word-placeholder' : 'opponent-secret'}>{own ? 'Your secret' : '?????'}</span>}
      <LockKeyhole size={14} aria-hidden="true" />
    </div>
    <div className="duel-avatar-wrap">
      <div className={`duel-avatar ${player.ready === 1 ? 'duel-avatar-ready' : ''}`}><UserRound aria-hidden="true" strokeWidth={1.1} /></div>
      {active && seconds !== null && seconds !== undefined && <svg className="duel-countdown-ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="duel-ring-track" cx="60" cy="60" r="56" />
        <circle className="duel-ring-progress" cx="60" cy="60" r="56" pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - (progress ?? 1))} />
      </svg>}
    </div>
    {seconds !== undefined && (active ? <span className="duel-turn-seconds" role="timer" aria-label={`${status} time remaining`}>{seconds === null ? 'Syncing…' : `${seconds}s`}</span> : <span className="duel-turn-seconds" aria-hidden="true">&nbsp;</span>)}
    <h2 className="duel-player-name">{player.displayName}</h2>
    <p className="duel-player-label">{own ? 'YOU' : 'YOUR OPPONENT'}</p>
    <p className="duel-player-status" data-testid={`duel-ready-${player.seat}`}>{status}</p>
  </section>
}
