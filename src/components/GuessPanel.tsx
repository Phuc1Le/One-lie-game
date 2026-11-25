import Conversation from './Conversation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { Button, Input } from './ui'
import DuelPlayer from './DuelPlayer'
import { requestRoomAction } from '../lib/room-action'
import { useServerClock } from '../lib/use-server-clock'
import { GUESS_ROUNDS, PRIVATE_GUESSES, type GuessRound, type PrivateGuess } from '../schemas/guess-schema'
import type { LobbySeat } from '../schemas/lobby-schema'
import type { QuestionTurn } from '../schemas/question-schema'

export default function GuessPanel({ code, seats, userId, word, category, conversation }: {
  code: string; seats: LobbySeat[]; userId: string; word: string | undefined; category: string; conversation: QuestionTurn[]
}) {
  const rounds = useQuery<GuessRound>(GUESS_ROUNDS, { where: { code }, orderBy: 'round', orderDir: 'desc', limit: 1 })
  const guesses = useQuery<PrivateGuess>(PRIVATE_GUESSES, { where: { code }, orderBy: 'round', orderDir: 'desc', limit: 1 })
  const current = [...rounds.records].sort((a, b) => b.data.round - a.data.round)[0]?.data
  const finished = current?.status === 'finished'
  const revealing = current?.status === 'missed'
  const own = guesses.records.find((r) => r.data.round === current?.round)?.data
  const clock = useServerClock(code, !finished)
  const seconds = current && clock.now !== null ? Math.max(0, Math.ceil((current.endsAt - clock.now) / 1000)) : null
  const [guess, setGuess] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  useEffect(() => { void requestRoomAction('syncGuesses', { code }).catch(() => setError('Could not restore guessing. Refresh to reconnect.')) }, [code])
  useEffect(() => { if (seconds === 0 && !finished) void requestRoomAction('syncGuesses', { code }).catch(() => {}) }, [code, seconds, finished, current?.round])
  useEffect(() => { setGuess(''); setError('') }, [current?.round])
  const name = (id: string) => id === userId ? 'You' : seats.find((s) => s.playerId === id)?.displayName ?? 'Opponent'
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!current || own || inFlight.current || seconds === null || seconds === 0) return
    inFlight.current = true; setBusy(true); setError('')
    try { await requestRoomAction('submitGuess', { code, round: current.round, guess }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit your guess.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <section className="duel-arena qa-arena" aria-label="Guessing">
    {[...seats].sort((a, b) => a.seat - b.seat).map((player) => {
      const ready = player.seat === 1 ? current?.ready1 : current?.ready2
      return <DuelPlayer key={player.seat} player={player} own={player.playerId === userId}
        word={finished ? player.seat === 1 ? current.word1 : current.word2 : player.playerId === userId ? word : undefined}
        revealed={finished} status={finished ? 'Revealed' : revealing ? 'Next round soon' : ready ? 'Ready' : 'Guessing'} active={!!current && !finished && !revealing && !ready}
        seconds={seconds} progress={seconds === null ? 1 : seconds / 30} />
    })}
    <div className="qa-screen duel-center">
      <div className="qa-summary"><span>{category}</span><strong>Guessing round {current?.round ?? 1}</strong></div>
      {revealing && current.result === 'no_winner' && <section className="lie-reveal" aria-label="Lie reveal" role="status">
        <h2>The truth comes out</h2><p>Both guesses were wrong. More Q&A turns begin shortly.</p>
        {seats.filter((player) => player.playerId !== userId).map((player) => {
          const disclosure = conversation.find((turn) => turn.answererId === player.playerId && turn.disclosedLie != null)
          if (!disclosure) return <p key={player.playerId}>Revealing...</p>
          const lied = disclosure.disclosedLie === 1
          return <article key={player.playerId} className={lied ? 'lie-reveal-card lie-reveal-red' : 'lie-reveal-card lie-reveal-green'}>
            <span aria-hidden="true">{lied ? '!' : '+'}</span>
            <h3>{player.displayName} {lied ? 'lied this round!' : 'said the truth this round!'}</h3>
            <p>{lied ? 'Lie token used during Q&A' : 'Lie token unused during Q&A'}</p>
          </article>
        })}
      </section>}
      <Conversation code={code} lastTurn={Math.max(0, ...conversation.map((turn) => turn.turn))} userId={userId} seats={seats} />
      {rounds.status === 'error' || guesses.status === 'error' ? <p role="alert">Could not load guesses. Refresh to reconnect.</p>
        : !current || guesses.status !== 'ready' ? <p role="status">Restoring guessing…</p>
        : revealing ? <p role="status">{current.result === 'judge_error' ? 'The judge could not check this round. Continuing with more Q&A.' : 'Get ready for your next three turns.'}</p>
        : finished ? <section className="qa-finished" role="status"><h2>{current.result === 'tie' ? 'It’s a tie!' : current.result === 'winner' ? current.winnerId === userId ? 'You win!' : `${name(current.winnerId!)} wins!` : current.result === 'judge_error' ? 'The judge could not finish' : 'No winner this time'}</h2><p>{current.result === 'judge_error' ? 'The AI judge was unavailable. This match ends without a result.' : 'Game over. Both mystery words are revealed.'}</p></section>
        : <section className="qa-current"><h2>Guess your opponent’s word</h2><p>One private guess each. Both guesses resolve together. {current.round > 1 && 'Neither player guessed correctly last round.'}</p>
          {own ? <p role="status">Your guess: <strong>{own.guess || 'No guess — time expired'}</strong>. {current.status === 'judging' ? 'Checking guesses…' : 'Waiting for your opponent.'}</p>
            : <form onSubmit={submit}><label htmlFor="secret-guess">Your guess</label><p className="qa-rule">Name one exact word or recognized alias. Spelling mistakes, descriptions, and multiple guesses do not count.</p><div className="qa-question-row"><Input id="secret-guess" autoComplete="off" value={guess} maxLength={80} disabled={busy || seconds === 0} onChange={(e) => setGuess(e.target.value)} /><Button type="submit" disabled={busy || seconds === null || seconds === 0 || !guess.trim()}>Submit guess</Button></div></form>}
        </section>}
      {error && <p role="alert" className="duel-error">{error}</p>}
      {clock.error && !finished && <p role="alert">{clock.error} <Button onClick={clock.retry}>Retry timer</Button></p>}
    </div>
  </section>
}
