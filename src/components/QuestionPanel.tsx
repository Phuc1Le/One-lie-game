import { QUESTION_REQUESTS, type QuestionRequest } from '../schemas/question-request-schema'
import Conversation from './Conversation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { Button, Input } from './ui'
import { requestRoomAction } from '../lib/room-action'
import type { LobbySeat } from '../schemas/lobby-schema'
import { ANSWERS, PRIVATE_ANSWERS, QUESTION_TURNS, turnComplete, type Answer, type PrivateAnswer, type QuestionTurn } from '../schemas/question-schema'
import DuelPlayer from './DuelPlayer'
import GuessPanel from './GuessPanel'
import { useServerClock } from '../lib/use-server-clock'
import { ANSWER_MS, QUESTION_MS } from '../game/timing'

export default function QuestionPanel({ code, seats, userId, word, category }: {
  code: string; seats: LobbySeat[]; userId: string; word: string | undefined; category: string
}) {
  const shared = useQuery<QuestionTurn>(QUESTION_TURNS, { where: { code }, orderBy: 'turn', orderDir: 'desc', limit: 6 })
  // The server filters this subscription to the caller's own rows, including
  // for admin players. Neither the opponent's truth nor token reaches React.
  const privateState = useQuery<PrivateAnswer>(PRIVATE_ANSWERS, { where: { code }, orderBy: 'turn', orderDir: 'desc', limit: 3 })
  const completed = shared.records.filter((r) => turnComplete(r.data)).sort((a, b) => a.data.turn - b.data.turn)
  const turn = Math.max(0, ...completed.map((r) => r.data.turn)) + 1
  const waiting = shared.records.length === 6 && shared.records.every((r) => turnComplete(r.data))
  const localTurn = (turn - 1) % 6 + 1
  const spentToken = useQuery<PrivateAnswer>(PRIVATE_ANSWERS, { where: { code, spentLie: 1 }, limit: 1 })
  const aiRequest = useQuery<QuestionRequest>(QUESTION_REQUESTS, { where: { code, turn }, limit: 1 }).records[0]?.data
  const current = shared.records.find((r) => r.data.turn === turn)?.data
  const declaration = privateState.records.find((r) => r.data.turn === turn)?.data
  const tokenUsed = spentToken.records.length > 0
  const asker = [...seats].sort((a, b) => a.seat - b.seat)[(turn - 1) % 2]
  const asking = asker?.playerId === userId
  const checking = current?.status === 'checking'
  const latestTurn = useRef(turn)
  latestTurn.current = turn
  const [question, setQuestion] = useState('')
  const [choice, setChoice] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const clock = useServerClock(code, !waiting)
  const deadline = current?.phaseEndsAt
  const expired = deadline !== undefined && clock.now !== null && clock.now >= deadline
  const seconds = !deadline || clock.now === null ? null : Math.max(0, Math.ceil((deadline - clock.now) / 1000))
  const duration = current?.question ? ANSWER_MS : QUESTION_MS
  const activeId = waiting || checking ? undefined : current?.question ? current.answererId : current?.askerId

  useEffect(() => {
    let disposed = false
    void requestRoomAction('syncQuestions', { code }).catch(() => { if (!disposed) setError('Could not restore the turn timer. Refresh to reconnect.') })
    return () => { disposed = true }
  }, [code])
  useEffect(() => {
    if (expired) void requestRoomAction('syncQuestions', { code }).catch(() => {})
  }, [code, expired, deadline])
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
      if (latestTurn.current === turn) setError(cause instanceof Error ? cause.message : 'Could not save. Please retry.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function ask(event: FormEvent) {
    event.preventDefault()
    if (question.trim()) void act('askQuestion', { question })
  }

  if (waiting) return <GuessPanel code={code} seats={seats} userId={userId} word={word} category={category} conversation={completed.map((r) => r.data)} />

  return <section className="duel-arena qa-arena" aria-label="Questions and answers">
    {[...seats].sort((a, b) => a.seat - b.seat).map((player) => <DuelPlayer key={player.seat} player={player} own={player.playerId === userId} word={player.playerId === userId ? word : undefined}
      active={player.playerId === activeId} seconds={seconds} progress={seconds === null ? 1 : Math.min(1, Math.max(0, seconds * 1000 / duration))}
      status={checking ? 'AI checking' : player.playerId === activeId ? current?.question ? 'Answering' : 'Asking' : 'Waiting'} />)}
    <div className="qa-screen duel-center">
    <div className="qa-summary">
      <span data-testid="selections-locked">Both players ready</span><span>{category}</span><strong data-testid="qa-round">Turn {Math.min(3, Math.ceil(localTurn / 2))}/3</strong>
    </div>
    {shared.status === 'error' || privateState.status === 'error' ? <p role="alert" className="qa-loading">Could not load the conversation. Refresh to reconnect.</p>
      : shared.status !== 'ready' || privateState.status !== 'ready' ? <p role="status" className="qa-loading">Restoring the conversation…</p> : <>
    <Conversation code={code} lastTurn={turn - 1} userId={userId} seats={seats} />
      <section className="qa-current" aria-label="Current question">
        <p className="duel-eyebrow">TURN {Math.ceil(localTurn / 2)}/3 · {current?.question ? asking ? 'OPPONENT ANSWERING' : 'YOUR TURN TO ANSWER' : asking ? 'YOUR TURN TO ASK' : 'OPPONENT’S TURN TO ASK'}</p>
        {current?.question ? <><h2>{current.question}</h2>{asking && <p role="status">Waiting for your opponent’s answer.</p>}</>
          : asking ? <form onSubmit={ask}>
            <label htmlFor="qa-question">Your question</label>
            <div className="qa-question-row"><Input id="qa-question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} disabled={busy || expired || checking} autoComplete="off" placeholder="Does it…?" /><Button type="submit" disabled={busy || expired || checking || clock.now === null || !question.trim()}>Submit question</Button></div>
            {checking && <p role="status">Checking your question...</p>}
            {aiRequest?.error && !error && <p role="alert">{aiRequest.error}</p>}
            <p className="qa-rule">Ask a Yes / Depends / No question. Don’t guess the secret word directly.</p>
          </form> : <h2 role="status">Waiting for {asker.displayName} to ask a question.</h2>}
      </section>
      <section className="qa-answer" aria-label="Answer controls">
        {current?.question && !asking ? <>
          {declaration ? <p className="qa-private-note">AI truthful answer (only you can see): <strong>{declaration.truth}</strong></p> : <p role="status">Loading the private AI answer...</p>}
          <p className={`qa-token ${tokenUsed ? 'qa-token-used' : ''}`} data-testid="lie-token">Your private Lie token: <strong>{tokenUsed ? 'Used' : 'Available'}</strong></p>
          <div className="qa-answer-boxes">{ANSWERS.map((answer) => {
            const truthful = declaration?.truth === answer
            const unavailable = !declaration || (tokenUsed && !truthful && declaration.sentAnswer !== answer) || (!!declaration.sentAnswer && declaration.sentAnswer !== answer)
            return <button type="button" key={answer} aria-label={`Send ${answer}`} aria-pressed={choice === answer} disabled={busy || expired || unavailable}
              className={`qa-answer-box ${declaration ? truthful ? 'qa-truth' : 'qa-lie' : ''}`} onClick={() => setChoice(answer)}>
              <strong>{answer}</strong><span>{declaration ? truthful ? 'True' : tokenUsed && declaration.sentAnswer !== answer ? 'Unavailable' : 'Lie' : 'Loading truth'}</span>
            </button>
          })}</div>
          <Button className="qa-submit" disabled={busy || expired || clock.now === null || !choice || !declaration || (tokenUsed && choice !== declaration.truth && choice !== declaration.sentAnswer)} onClick={() => { if (choice) void act('submitAnswer', { answer: choice }) }}>Submit answer</Button>
        </> : <p className="qa-private-note">{current?.question ? 'Only the submitted answer will appear in the conversation.' : 'Answer controls will appear when it’s your turn to answer.'}</p>}
      </section>
    </>}
    {error && <p role="alert" className="duel-error">{error}</p>}
    {clock.error && <p role="alert" className="duel-error">{clock.error} <Button variant="link" onClick={clock.retry}>Retry timer</Button></p>}
    </div>
  </section>
}
