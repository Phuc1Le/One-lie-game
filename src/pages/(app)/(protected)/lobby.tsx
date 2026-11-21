import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getAuthToken, useAuth, useQuery } from 'deepspace'
import { UserRound, Plus } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '@/schemas/lobby-schema'
import './lobby.css'

// Authentication is supplied by the existing (protected) layout. The token
// identifies the caller; the server never accepts a playerId from this page.
type RoomAction = 'createRoom' | 'joinRoom' | 'exitRoom'

async function requestRoomAction(action: RoomAction, code?: string): Promise<string> {
  const token = await getAuthToken()
  if (!token) throw new Error('Please sign in again to continue.')
  const response = await fetch(`/api/actions/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(code ? { code } : {}),
  })
  const result = await response.json() as { success?: boolean; data?: { code: string }; error?: string }
  if (!response.ok || !result.success || !result.data) {
    throw new Error(result.error ?? 'Could not connect to the room. Please try again.')
  }
  return result.data.code
}

export default function LobbyPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [inputCode, setInputCode] = useState('')
  const [pending, setPending] = useState<RoomAction | null>(null)
  const [error, setError] = useState('')
  const roomCode = (searchParams.get('room') ?? '').trim().toUpperCase()

  async function roomAction(action: RoomAction, code?: string) {
    if (pending) return
    setPending(action)
    setError('')
    try {
      const acceptedCode = await requestRoomAction(action, code)
      // Keep the room in the URL so a refresh restores the same subscription.
      if (action === 'exitRoom') {
        setSearchParams({}, { replace: true })
        setInputCode('')
      } else {
        setSearchParams({ room: acceptedCode })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect. Please try again.')
    } finally {
      setPending(null)
    }
  }

  function join(event: FormEvent) {
    event.preventDefault()
    void roomAction('joinRoom', inputCode)
  }

  return (
    <div className="one-lie-lobby min-h-full px-5 py-12 sm:py-20">
      <title>One Lie · Lobby</title>
      <div className="mx-auto max-w-xl">
        <header className="mb-10 text-center">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">A game for two</p>
          <h1 className="font-serif text-5xl tracking-tight sm:text-6xl">One Lie<span className="text-[#a75538]">.</span></h1>
          <p className="mt-4 text-sm text-muted-foreground">Find your opponent. Take your seat.</p>
        </header>

        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-9" aria-label="Game lobby">
          {roomCode && ROOM_CODE_PATTERN.test(roomCode) ? (
            <Room key={roomCode} code={roomCode} pending={pending !== null}
              onJoin={() => void roomAction('joinRoom', roomCode)}
              onExit={() => void roomAction('exitRoom', roomCode)}
              onBack={() => { setSearchParams({}); setError('') }} />
          ) : (
            <>
              <h2 className="text-xl font-semibold">Pull up a chair</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Create a room and share its code with a friend, or join theirs.</p>
              <Button className="mt-6 w-full" size="lg" loading={pending === 'createRoom'} disabled={pending !== null}
                onClick={() => void roomAction('createRoom')}>Create Room</Button>
              <div className="my-7 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />or join a friend<span className="h-px flex-1 bg-border" />
              </div>
              <form onSubmit={join}>
                <label htmlFor="room-code" className="text-sm font-medium">Room code</label>
                <div className="mt-2 flex gap-3">
                  <Input id="room-code" value={inputCode} maxLength={4} placeholder="K7MP" autoComplete="off" spellCheck={false}
                    className="h-11 flex-1 uppercase tracking-[0.18em]"
                    onChange={(event) => setInputCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
                  <Button type="submit" size="lg" variant="secondary" loading={pending === 'joinRoom'}
                    disabled={pending !== null || inputCode.length !== 4}>Join Room</Button>
                </div>
              </form>
              {roomCode && <p className="mt-4 text-sm text-destructive">That link has an invalid room code. Enter a code above.</p>}
            </>
          )}
          {error && <p role="alert" className="mt-5 text-sm text-destructive">{error}</p>}
        </section>
        <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">Two players. Two secret words. One lie each.<br />For now, we’re just getting everyone seated.</p>
      </div>
    </div>
  )
}

function Room({ code, pending, onJoin, onExit, onBack }: {
  code: string; pending: boolean; onJoin: () => void; onExit: () => void; onBack: () => void
}) {
  const { userId } = useAuth()
  // The SDK subscribes over WebSocket. Both browsers re-render when a seat
  // record arrives; no timer, polling, or manual refresh is needed.
  const { records, status, error } = useQuery<LobbySeat>(LOBBY_SEATS, { where: { code }, orderBy: 'seat', limit: 2 })
  const ownSeat = records.find((record) => record.data.playerId === userId)
  const roomExists = records.some((record) => record.data.seat === 1)
  const roomClosed = records.some((record) => record.data.seat === 1 && record.data.status === 'closed')

  return (
    <>
      <div className="text-center">
        <h2 className="text-sm font-medium text-muted-foreground">Your room code</h2>
        <p data-testid="lobby-code" className="my-3 font-mono text-4xl font-semibold tracking-[0.22em]">{code}</p>
        {!roomClosed && <p className="text-sm text-muted-foreground">Send this code to your friend.</p>}
      </div>
      {status === 'loading' ? <p role="status" className="mt-8 text-center text-sm">Connecting to your room…</p>
        : status === 'error' ? <p role="alert" className="mt-8 text-sm text-destructive">{error ?? 'Could not load the lobby. Please reload to reconnect.'}</p>
        : !roomExists ? <p role="alert" className="mt-8 text-center text-sm">Room not found. Check your code.</p>
        : roomClosed ? <p role="status" className="mt-8 text-center text-sm">Your opponent left. This room has closed.</p>
        : <>
          <div className="my-9 grid grid-cols-2 gap-5">
            {[1, 2].map((number) => {
              const player = records.find((record) => record.data.seat === number)?.data
              return (
                <div key={number} data-testid={`lobby-seat-${number}`} className="flex min-w-0 flex-col items-center text-center">
                  <div className={`mb-4 flex h-20 w-20 items-center justify-center rounded-full border ${player ? 'border-[#d4c4ad] bg-[#ede4d5]' : 'border-dashed border-[#cfc7ba] bg-[#faf8f3]'}`}>
                    {player ? <UserRound className="h-9 w-9" strokeWidth={1.4} aria-hidden="true" /> : <Plus className="h-6 w-6 text-muted-foreground" aria-hidden="true" />}
                  </div>
                  <p className="w-full truncate text-sm font-semibold">{player?.displayName ?? 'Open seat'}{player?.playerId === userId && ' (you)'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{player ? `Player ${number}` : 'Waiting for a friend'}</p>
                </div>
              )
            })}
          </div>
          <p role="status" className="text-center text-sm text-muted-foreground">
            {ownSeat ? (records.length === 2 ? 'Both players are here. Your lobby is complete.' : 'You’re seated. Waiting for your friend…')
              : records.length === 2 ? 'Room full. Both seats are already taken.' : 'One seat is available.'}
          </p>
          {!ownSeat && records.length < 2 && <Button className="mt-5 w-full" disabled={pending} loading={pending} onClick={onJoin}>Join Room</Button>}
          {ownSeat && <p className="mt-3 text-center text-xs text-muted-foreground">Your seat stays reserved if you refresh.</p>}
        </>}
      {ownSeat && !roomClosed ? (
        <Button variant="outline" className="mx-auto mt-6 flex" disabled={pending || status !== 'ready'} loading={pending} onClick={onExit}>Exit Room</Button>
      ) : (
        <Button variant="link" className="mx-auto mt-6 flex text-muted-foreground" disabled={pending} onClick={onBack}>Back to lobby</Button>
      )}
    </>
  )
}
