import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { Button, Input } from './ui'
import { requestRoomAction } from '../lib/room-action'
import type { LobbySeat } from '../schemas/lobby-schema'
import { ANSWERS, PRIVATE_ANSWERS, QUESTION_TURNS, turnComplete, type Answer, type PrivateAnswer, type QuestionTurn } from '../schemas/question-schema'
import DuelPlayer from './DuelPlayer'
import { useServerClock } from '../lib/use-server-clock'
import { ANSWER_MS, QUESTION_MS } from '../game/timing'

export default function QuestionPanel({ code, seats, userId, word, category }: {
  code: string; seats: LobbySeat[]; userId: string; word: string | undefined; category: string
}) {
  const shared = useQuery<QuestionTurn>(QUESTION_TURNS, { where: { code }, orderBy: 'turn', orderDir: 'asc', limit: 6 })
  // The server filters this subscription to the caller's own rows, including
  // for admin players. Neither the opponent's truth nor token reaches React.
  const privateState = useQuery<PrivateAnswer>(PRIVATE_ANSWERS, { where: { code }, limit: 3 })
  const completed = shared.records.filter((r) => turnComplete(r.data)).sort((a, b) => a.data.turn - b.data.turn)
  const turn = completed.length + 1
  const current = shared.records.find((r) => r.data.turn === turn)?.data
  const declaration = privateState.records.find((r) => r.data.turn === turn)?.data
  const tokenUsed = privateState.records.some((r) => r.data.spentLie === 1)
  const asker = [...seats].sort((a, b) => a.seat - b.seat)[(turn - 1) % 2]
  const asking = asker?.playerId === userId
  const [question, setQuestion] = useState('')
  const [choice, setChoice] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const history = useRef<HTMLElement>(null)
  const clock = useServerClock(code, turn <= 6)
  const deadline = current?.phaseEndsAt
  const expired = deadline !== undefined && clock.now !== null && clock.now >= deadline
  const seconds = !deadline || clock.now === null ? null : Math.max(0, Math.ceil((deadline - clock.now) / 1000))
  const duration = current?.question ? ANSWER_MS : QUESTION_MS
  const activeId = turn > 6 ? undefined : current?.question ? current.answererId : current?.askerId
  const name = (id: string) => id === userId ? 'You' : seats.find((s) => s.playerId === id)?.displayName ?? 'Opponent'

  useEffect(() => {
    let disposed = false
    void requestRoomAction('syncQuestions', { code }).catch(() => { if (!disposed) setError('Could not restore the turn timer. Refresh to reconnect.') })
    return () => { disposed = true }
  }, [code])
  useEffect(() => {
    if (expired) void requestRoomAction('syncQuestions', { code }).catch(() => {})
  }, [code, expired, deadline])
  useEffect(() => { if (history.current) history.current.scrollTop = history.current.scrollHeight }, [completed.length])
  useEffect(() => { setChoice(null); setQuestion(''); setError('') }, [turn])

  async function act(action: string, data: Record<string, unknown>) {
    if (inFlight.current || expired || clock.now === null) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await requestRoomAction(action, { code, turn, ...data })
      if (action === 'askQuestion') setQuestion('')
      if (action === 'submitAnswer') setChoice(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save. Please retry.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function ask(event: FormEvent) {
    event.preventDefault()
    if (question.trim()) void act('askQuestion', { question })
  }

  return <section className="duel-arena qa-arena" aria-label="Questions and answers">
    {[...seats].sort((a, b) => a.seat - b.seat).map((player) => <DuelPlayer key={player.seat} player={player} own={player.playerId === userId} word={player.playerId === userId ? word : undefined}
      active={player.playerId === activeId} seconds={seconds} progress={seconds === null ? 1 : Math.min(1, Math.max(0, seconds * 1000 / duration))}
      status={turn > 6 ? 'Secrets sealed' : player.playerId === activeId ? current?.question ? 'Answering' : 'Asking' : 'Waiting'} />)}
    <div className="qa-screen duel-center">
    <div className="qa-summary">
      <span data-testid="selections-locked">Both players ready</span><span>{category}</span><strong data-testid="qa-round">Round {Math.min(3, Math.ceil(turn / 2))}/3</strong>
    </div>
    {shared.status === 'error' || privateState.status === 'error' ? <p role="alert" className="qa-loading">Could not load the conversation. Refresh to reconnect.</p>
      : shared.status !== 'ready' || privateState.status !== 'ready' ? <p role="status" className="qa-loading">Restoring the conversation…</p> : <>
    <section ref={history} className="qa-history" aria-label="Completed conversation" tabIndex={0}>
      <h2>Conversation</h2>
      {!completed.length && <p className="qa-empty">Two secrets, one lie each. The host asks first.</p>}
      {completed.map(({ recordId, data }) => <article key={recordId} className="qa-exchange">
        {data.question ? <div className={`qa-message ${data.askerId === userId ? 'qa-message-own' : ''}`}><p className="qa-message-label">{name(data.askerId)} · Round {Math.ceil(data.turn / 2)}</p><p>{data.question}</p></div> : <p className="qa-chat-event">{name(data.askerId)} ran out of time to ask.</p>}
        {data.answer ? <div className={`qa-message qa-reply ${data.answererId === userId ? 'qa-message-own' : ''}`}><p className="qa-message-label">{name(data.answererId)}</p><strong>{data.answer}</strong></div> : data.question && <p className="qa-chat-event">No answer · time ran out.</p>}
      </article>)}
    </section>
    {turn > 6 ? <section className="qa-finished" role="status"><h2>Awaiting guesses</h2><p>All three rounds are complete. Your secrets stay sealed.</p></section> : <>
      <section className="qa-current" aria-label="Current question">
        <p className="duel-eyebrow">ROUND {Math.ceil(turn / 2)}/3 · {current?.question ? asking ? 'OPPONENT ANSWERING' : 'YOUR TURN TO ANSWER' : asking ? 'YOUR TURN TO ASK' : 'OPPONENT’S TURN TO ASK'}</p>
        {current?.question ? <><h2>{current.question}</h2>{asking && <p role="status">Waiting for your opponent’s answer.</p>}</>
          : asking ? <form onSubmit={ask}>
            <label htmlFor="qa-question">Your question</label>
            <div className="qa-question-row"><Input id="qa-question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} disabled={busy || expired} autoComplete="off" placeholder="Does it…?" /><Button type="submit" disabled={busy || expired || clock.now === null || !question.trim()}>Submit question</Button></div>
            <p className="qa-rule">Ask a Yes / Depends / No question. Don’t guess the secret word directly.</p>
          </form> : <h2 role="status">Waiting for {asker.displayName} to ask a question.</h2>}
      </section>
      <section className="qa-answer" aria-label="Answer controls">
        {current?.question && !asking ? <>
          {!declaration ? <fieldset disabled={busy || expired || clock.now === null} className="qa-declaration"><legend>First, declare the truthful answer privately</legend>
            <p>Your opponent cannot see this. Your declaration is final for this question.</p>
            <div>{ANSWERS.map((answer) => <Button key={answer} aria-label={`Declare truthful ${answer}`} onClick={() => { setChoice(null); void act('declareTruth', { truth: answer }) }}>{answer}</Button>)}</div>
          </fieldset> : <p className="qa-private-note">Your private truthful declaration: <strong>{declaration.truth}</strong></p>}
          <p className={`qa-token ${tokenUsed ? 'qa-token-used' : ''}`} data-testid="lie-token">Your private Lie token: <strong>{tokenUsed ? 'Used' : 'Available'}</strong></p>
          <div className="qa-answer-boxes">{ANSWERS.map((answer) => {
            const truthful = declaration?.truth === answer
            const unavailable = !declaration || (tokenUsed && !truthful && declaration.sentAnswer !== answer) || (!!declaration.sentAnswer && declaration.sentAnswer !== answer)
            return <button type="button" key={answer} aria-label={`Send ${answer}`} aria-pressed={choice === answer} disabled={busy || expired || unavailable}
              className={`qa-answer-box ${declaration ? truthful ? 'qa-truth' : 'qa-lie' : ''}`} onClick={() => setChoice(answer)}>
              <strong>{answer}</strong><span>{declaration ? truthful ? 'True' : tokenUsed && declaration.sentAnswer !== answer ? 'Unavailable' : 'Lie' : 'Declare first'}</span>
            </button>
          })}</div>
          <Button className="qa-submit" disabled={busy || expired || clock.now === null || !choice || !declaration || (tokenUsed && choice !== declaration.truth && choice !== declaration.sentAnswer)} onClick={() => { if (choice) void act('submitAnswer', { answer: choice }) }}>Submit answer</Button>
        </> : <p className="qa-private-note">{current?.question ? 'Only the submitted answer will appear in the conversation.' : 'Answer controls will appear when it’s your turn to answer.'}</p>}
      </section>
    </>}
    </>}
    {error && <p role="alert" className="duel-error">{error}</p>}
    {clock.error && turn <= 6 && <p role="alert" className="duel-error">{clock.error} <Button variant="link" onClick={clock.retry}>Retry timer</Button></p>}
    </div>
  </section>
}
