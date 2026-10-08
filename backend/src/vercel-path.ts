export function normalizeApiPath(request: { url?: string }) {
  const url = request.url ?? '/'
  const parsedUrl = new URL(url, 'http://localhost')

  if (parsedUrl.pathname === '/api/index') {
    const path = parsedUrl.searchParams.get('path')
    if (path === null) return

    parsedUrl.searchParams.delete('path')
    const routePath = path.startsWith('/') ? path : `/${path}`
    const apiPath = routePath === '/api' || routePath.startsWith('/api/')
      ? routePath
      : `/api${routePath}`
    request.url = `${apiPath}${parsedUrl.search}`
    return
  }

  if (parsedUrl.pathname === '/api' || parsedUrl.pathname.startsWith('/api/')) return
  request.url = `/api${url}`
}
