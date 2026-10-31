// Request policy for the local dashboard server. It listens on 127.0.0.1 only, but any web page the
// user has open can still make the browser send requests to it, and a hostile DNS name can point at it.
// These checks keep the usage data and the account lookup reachable only from the dashboard itself:
//
// * Host must be exactly 127.0.0.1 or localhost on the port we listen on (defeats DNS rebinding).
// * A browser-supplied Origin must be this same dashboard.
// * /api/ requests that a browser marks as coming from another site (Sec-Fetch-Site) are refused, so a
//   page cannot trigger the scan or the Codex account lookup with a cross-site "no-cors" request.
//
// A user who deliberately reaches the HUD under another name (for example through a local reverse proxy)
// can list that name in AERUS_ALLOWED_HOSTS. An IPv6 literal needs its port too: "[::1]:8790".
//
// None of this is authentication: another program running as the same user can still call the API, and a
// browser too old to send Sec-Fetch-Site (it is in all current Chrome, Edge, Firefox and Safari releases)
// can still make a cross-site request that triggers a scan, although it cannot read the answer.

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];

function hostMatches(value, port, extraHosts) {
  const host = String(value ?? '').toLowerCase();
  if (LOOPBACK_NAMES.some((name) => host === `${name}:${port}` || (port === 80 && host === name))) return true;
  // Extra names the user chose to allow (AERUS_ALLOWED_HOSTS): "name" matches that name on any port,
  // "name:port" only that port.
  return extraHosts.some((entry) => host === entry || (!entry.includes(':') && host.startsWith(`${entry}:`) && /^\d+$/.test(host.slice(entry.length + 1))));
}

// "a.example, b.example:8790" -> ['a.example', 'b.example:8790'] (lower case, empty entries dropped).
export function parseAllowedHosts(text) {
  return String(text ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

// Returns { ok: true } or { ok: false, status, reason } for one request.
export function checkRequest({ method, pathname, headers, port, extraHosts = [] }) {
  if (method !== 'GET' && method !== 'HEAD') return { ok: false, status: 405, reason: 'Method not allowed.' };
  if (!hostMatches(headers.host, port, extraHosts)) return { ok: false, status: 403, reason: 'Unexpected Host header.' };

  const origin = headers.origin;
  if (origin !== undefined) {
    const match = /^http:\/\/(.+)$/.exec(String(origin).toLowerCase());
    if (!match || !hostMatches(match[1], port, extraHosts)) return { ok: false, status: 403, reason: 'Unexpected Origin header.' };
  }

  const site = headers['sec-fetch-site'];
  if (pathname.startsWith('/api/') && site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: 'Cross-site request refused.' };
  }
  return { ok: true };
}
