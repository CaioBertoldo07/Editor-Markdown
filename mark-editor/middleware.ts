/**
 * Routing Middleware da Vercel: repassa /api/* para a API no Railway.
 *
 * - O navegador fala só com o domínio do app (cookies do Better Auth ficam
 *   first-party, SameSite=Lax).
 * - Envia `x-proxy-secret` (variável de SERVIDOR da Vercel, nunca vai para o
 *   bundle) e `x-client-ip` com o IP que a própria Vercel atribui ao cliente.
 *   Cabeçalhos de IP/segredo enviados pelo navegador são descartados.
 * - Variáveis por ambiente da Vercel: Production -> API de produção;
 *   Preview -> API de staging. Um Preview nunca recebe o segredo de produção.
 */
export const config = { matcher: '/api/:path*' };

const FORWARD_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'cookie', 'origin', 'referer', 'user-agent'];
const DROP_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'];

const clientIpOf = (request: Request): string => {
  // Definidos pela borda da Vercel a partir da conexão real (não são repassados do cliente).
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0]!.trim() : '';
};

export default async function middleware(request: Request): Promise<Response> {
  const apiOrigin = process.env.API_ORIGIN;
  const secret = process.env.API_PROXY_SECRET;
  if (!apiOrigin || !secret) {
    return Response.json({ error: 'api_not_configured' }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, apiOrigin);

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('accept-encoding', 'identity');
  headers.set('x-proxy-secret', secret);
  const ip = clientIpOf(request);
  if (ip) headers.set('x-client-ip', ip);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  } catch {
    return Response.json({ error: 'api_unreachable' }, { status: 502 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (name === 'set-cookie' || DROP_RESPONSE_HEADERS.includes(name)) return;
    responseHeaders.set(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);

  return new Response(upstream.status === 204 || request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
