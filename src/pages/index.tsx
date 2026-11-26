import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

// Keep a prerenderable entry for link previews, then open the game directly.
export default function GameEntry() {
  const navigate = useNavigate()
  const { search, hash } = useLocation()
  useEffect(() => { navigate('/lobby' + search + hash, { replace: true }) }, [navigate, search, hash])
  return <><Seo {...seo} path="/" /><main className="flex min-h-screen items-center justify-center">
    <h1 className="font-serif text-4xl"><Link to={'/lobby' + search + hash}>One Lie</Link></h1>
  </main></>
}
