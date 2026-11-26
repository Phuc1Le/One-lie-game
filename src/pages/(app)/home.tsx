import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

export default function HomePage() {
  const { search, hash } = useLocation()
  const navigate = useNavigate()
  useEffect(() => { navigate('/lobby' + search + hash, { replace: true }) }, [navigate, search, hash])
  return <Link to={'/lobby' + search + hash}>Opening One Lie…</Link>
}
