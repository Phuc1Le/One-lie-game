import { useQuery } from 'deepspace'
import { useEffect, useRef } from 'react'
import { QUESTION_TURNS, turnComplete, type QuestionTurn } from '../schemas/question-schema'
import type { LobbySeat } from '../schemas/lobby-schema'

// Exact-turn subscriptions keep all rounds available without a query-limit cutoff.
function Exchange({ code, turn, userId, seats }: { code: string; turn: number; userId: string; seats: LobbySeat[] }) {
  const query = useQuery<QuestionTurn>(QUESTION_TURNS, { where: { code, turn }, limit: 1 })
  const data = query.records[0]?.data
  const name = (id: string) => id === userId ? 'You' : seats.find((s) => s.playerId === id)?.displayName ?? 'Opponent'
  if (query.status === 'error') return <p role="alert">Could not load turn {turn}. Refresh to reconnect.</p>
  if (!data || !turnComplete(data)) return null
  return <article className="qa-exchange">
    {(turn - 1) % 6 === 0 && <p className="qa-chat-event">Round {Math.ceil(turn / 6)}</p>}
    {data.question ? <div className={`qa-message ${data.askerId === userId ? 'qa-message-own' : ''}`}><p className="qa-message-label">{name(data.askerId)} · Turn {Math.ceil(((turn - 1) % 6 + 1) / 2)}</p><p>{data.question}</p></div> : <p className="qa-chat-event">{name(data.askerId)} ran out of time to ask.</p>}
    {data.answer ? <div className={`qa-message qa-reply ${data.answererId === userId ? 'qa-message-own' : ''}`}><p className="qa-message-label">{name(data.answererId)}</p><strong>{data.answer}</strong></div> : data.question && <p className="qa-chat-event">No answer: time ran out.</p>}
  </article>
}
export default function Conversation({ code, lastTurn, userId, seats }: { code: string; lastTurn: number; userId: string; seats: LobbySeat[] }) {
  const history = useRef<HTMLElement>(null)
  const followLatest = useRef(true)
  useEffect(() => {
    const element = history.current
    if (!element) return
    const observer = new MutationObserver(() => {
      if (followLatest.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  return <section ref={history} onScroll={() => {
    const element = history.current
    if (element) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
  }} className="qa-history" aria-label="Completed conversation" tabIndex={0}>
    <h2>Conversation</h2>
    {!lastTurn && <p className="qa-empty">Two secrets, one lie each. The host asks first.</p>}
    {Array.from({ length: lastTurn }, (_, index) => <Exchange key={index + 1} code={code} turn={index + 1} userId={userId} seats={seats} />)}
  </section>
}
