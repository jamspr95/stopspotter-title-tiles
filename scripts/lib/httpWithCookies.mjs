// Minimal cookie-jar-aware fetch, for INSPIRE download sites that use a
// cookie-walk redirect pattern: the first response sets a session cookie
// and redirects back to the same URL, expecting that cookie on the next
// request before it'll actually serve content.
//
// Confirmed against the real HM Land Registry download page (not a
// login wall, as originally suspected — see this script's git history):
// the GitHub Actions run failed with `TypeError: fetch failed` /
// `Error: redirect count exceeded`. Node's built-in fetch follows
// redirects automatically but does NOT carry a Set-Cookie header from
// one hop into the next request, so a site that needs this walk loops
// forever rather than ever reaching real content.
//
// This follows redirects manually, accumulating cookies across hops, up
// to MAX_REDIRECTS before giving up with a clearer error than undici's
// own "redirect count exceeded".

const MAX_REDIRECTS = 15
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function mergeCookies(jar, response) {
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const raw of setCookie) {
    const pair = raw.split(';')[0] // drop Path/Expires/Secure/etc. attributes, keep name=value
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

function cookieHeader(jar) {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** fetch() that manually follows redirects while carrying cookies between hops — see header comment. */
export async function fetchWithCookieJar(url, options = {}) {
  const jar = new Map()
  let currentUrl = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const headers = { ...(options.headers ?? {}) }
    if (jar.size > 0) headers.Cookie = cookieHeader(jar)
    const res = await fetch(currentUrl, { ...options, headers, redirect: 'manual' })

    if (REDIRECT_STATUSES.has(res.status)) {
      mergeCookies(jar, res)
      const location = res.headers.get('location')
      if (!location) throw new Error(`Redirect response (${res.status}) from ${currentUrl} had no Location header.`)
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    return res
  }
  throw new Error(
    `${url}: exceeded ${MAX_REDIRECTS} redirects while trying to establish a session — this site likely needs an actual signed-in browser session, not just cookie-walking. See docs/SETUP.md §15's --dir fallback.`,
  )
}
