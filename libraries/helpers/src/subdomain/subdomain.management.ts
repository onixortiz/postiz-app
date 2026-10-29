import { parse } from 'tldts';

export function getCookieUrlFromDomain(domain: string) {
  // FORK: on a shared host like *.up.railway.app the registrable domain is
  // the host's (railway.app), so the auth cookie would reach every app on it.
  // COOKIE_DOMAIN keeps the cookies on the app's own hostname.
  if (process.env.COOKIE_DOMAIN) {
    return process.env.COOKIE_DOMAIN;
  }
  const url = parse(domain);
  return url.domain! ? '.' + url.domain! : url.hostname!;
}
