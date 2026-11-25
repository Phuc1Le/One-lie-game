import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { ArrowRight, LockKeyhole, LogOut } from 'lucide-react'
import { Button, Input } from './ui'
import { CATEGORIES, matchWord, roomCategory } from '../game/categories'
import { CATEGORY_REVEAL_MS, WORD_SELECTION_MS } from '../game/timing'
import type { LobbySeat } from '../schemas/lobby-schema'
import { WORD_SELECTIONS, type WordSelection } from '../schemas/word-selection-schema'
import { requestRoomAction } from '../lib/room-action'
import { useServerClock } from '../lib/use-server-clock'
import QuestionPanel from './QuestionPanel'
import DuelPlayer from './DuelPlayer'

export default function WordSelectionPanel({ code, seats, userId, startedAt, selectionEndsAt, categoryId, onExit, exiting, actionError }: {
  code: string; seats: LobbySeat[]; userId: string; startedAt: number; selectionEndsAt: number; categoryId?: string
  onExit: () => void; exiting: boolean; actionError: string
}) {
  // Only our own private record can cross this subscription's server boundary.
  const { records, status, error: loadError } = useQuery<WordSelection>(WORD_SELECTIONS, { where: { code }, limit: 1 })
  const selection = records[0]?.data
  const ownSeat = seats.find((seat) => seat.playerId === userId)
  const submitted = !!selection || ownSeat?.ready === 1
  const locked = seats.length === 2 && seats.every((seat) => seat.ready === 1)
  const category = roomCategory(code, categoryId)
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const wordMatch = matchWord(category.id, draft)
  const curated = CATEGORIES.some((entry) => entry.id === category.id)
  const clock = useServerClock(code, !locked)
  const syncing = !locked && clock.now === null
  const animateEntrance = clock.initialNow !== null && clock.initialNow - startedAt < 1200
  const spinning = !locked && clock.now !== null && clock.now < startedAt + CATEGORY_REVEAL_MS
  const seconds = clock.now === null ? null : Math.max(0, Math.min(WORD_SELECTION_MS / 1000, Math.ceil((selectionEndsAt - clock.now) / 1000)))

  useLayoutEffect(() => {
    // A native modal makes the old lobby inert and takes the whole viewport.
    const node = dialog.current!
    if (!node.open) node.showModal()
    return () => { if (node.open) node.close() }
  }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending || submitted || syncing || spinning || seconds === 0) return
    setPending(true)
    setError('')
    try {
      await requestRoomAction('selectWord', { code, word: draft })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your word. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <dialog ref={dialog} className={`one-lie-lobby duel-screen ${animateEntrance ? 'duel-enter' : ''}`} aria-label="One Lie duel" onCancel={(event) => event.preventDefault()}>
      <title>One Lie · The duel</title>
      <header className="duel-topbar">
        <Button variant="destructive" className="duel-exit" onClick={onExit} disabled={exiting} loading={exiting}><LogOut aria-hidden="true" />Exit Room</Button>
        <span className="duel-wordmark">One Lie<span>.</span></span>
        <span className="duel-room">ROOM {code}</span>
      </header>
      {actionError && <p role="alert" className="duel-error px-6">{actionError}</p>}
      {locked ? <QuestionPanel code={code} seats={seats} userId={userId} word={selection?.word} category={category.label} /> : <div className="duel-arena">
        {[...seats].sort((a, b) => a.seat - b.seat).map((player) => {
          const own = player.playerId === userId
          return (
            <DuelPlayer key={player.seat} player={player} own={own} word={own ? selection?.word : undefined}
              status={player.ready === 1 ? 'Locked in' : syncing || spinning ? 'Getting ready' : 'Choosing a word'} />
          )
        })}

        <section className="duel-center" aria-label="Private word selection">
          <p className="duel-eyebrow">THE CATEGORY</p>
          <div className={`duel-slot ${spinning ? 'duel-slot-spinning' : 'duel-slot-landed'}`}>
            <span className="duel-slot-pointer" aria-hidden="true">›</span>
            <div className="duel-slot-window">
              {syncing ? <p>Synchronizing…</p> : spinning ? <div className="category-reel" aria-hidden="true">{[...CATEGORIES, ...CATEGORIES].map((item, index) => <p key={index}>{item.label}</p>)}</div>
                : <h2 data-testid="selection-category">{category.label}</h2>}
            </div>
            <span className="duel-slot-pointer" aria-hidden="true">‹</span>
          </div>
          {!locked && <div className={`duel-timer ${seconds !== null && seconds <= 5 && !spinning ? 'duel-timer-urgent' : ''}`} role="timer" aria-label="Time remaining">
            <span data-testid="selection-timer">{syncing ? 'SYNCING' : spinning ? 'DRAWING' : `${seconds}s`}</span>
            <div className="duel-timer-track" aria-hidden="true"><span style={{ transform: `scaleX(${syncing || spinning ? 1 : (seconds ?? 0) / (WORD_SELECTION_MS / 1000)})` }} /></div>
          </div>}

          {syncing ? <div className="duel-hint"><p role="status">Synchronizing the game timer…</p>{clock.error && <><p role="alert">{clock.error}</p><Button variant="link" onClick={clock.retry}>Retry timer sync</Button></>}</div>
            : spinning ? <p role="status" className="duel-hint">Let fate pick the category.</p>
            : status === 'error' ? <p role="alert" className="duel-error">{loadError ?? 'Could not load your word. Refresh to reconnect.'}</p>
            : status === 'loading' ? <p role="status" className="duel-hint">Loading your word…</p>
            : submitted ? <div className="duel-sealed" role="status"><LockKeyhole size={22} aria-hidden="true" /><h3>Your word is sealed</h3><p>Waiting for your opponent.</p></div>
            : seconds === 0 ? <div className="duel-sealed" role="status"><h3>Time’s up</h3><p>Saving an empty word.</p></div>
            : <form onSubmit={save} className="duel-form">
              <label htmlFor="secret-word">Your secret word</label>
              <div className="duel-input-row"><Input id="secret-word" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={40} value={draft}
                onChange={(event) => { setDraft(event.target.value); setError('') }} disabled={pending} placeholder="Type your word…" />
                <Button type="submit" disabled={pending || !draft.trim() || (curated && !wordMatch.canonical)} loading={pending} aria-label="Lock in word"><ArrowRight aria-hidden="true" /></Button></div>
              {wordMatch.suggestion && <Button type="button" variant="link" onClick={() => setDraft(wordMatch.suggestion!)}>Use “{wordMatch.suggestion}”</Button>}
              {wordMatch.canonical && <p className="duel-hint">Will save as: {wordMatch.canonical}</p>}
              {curated && <details className="duel-hint"><summary>Accepted words in this category</summary><p>{category.words.join(', ')}</p></details>}
              <p className="duel-hint">One choice. No takebacks.<br />If time runs out, your word will be empty.</p>
            </form>}
          {error && <p role="alert" className="duel-error">{error}</p>}
        </section>
      </div>}
      <p className="duel-footer">TWO PLAYERS. TWO SECRETS. ONE LIE.</p>
    </dialog>
  )
}
