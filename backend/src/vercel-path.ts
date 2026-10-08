export function normalizeApiPath(request: { url?: string }) {
  const url = request.url ?? '/'
  const pathname = url.split('?')[0]
  if (pathname === '/api' || pathname.startsWith('/api/')) return

  request.url = `/api${url}`
}
