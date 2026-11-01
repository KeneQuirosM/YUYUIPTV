/**
 * YUYU IPTV · Proxy CORS + HTTPS para Cloudflare Workers (plan gratuito)
 *
 * Uso desde la app:  https://<tu-worker>.workers.dev/?url={url}
 *
 * Qué hace:
 *  - Descarga la URL pedida (http o https) y la devuelve por HTTPS con
 *    cabeceras CORS → resuelve el bloqueo CORS y el de "contenido mixto".
 *  - Si la respuesta es un manifiesto HLS (.m3u8), reescribe sus enlaces para
 *    que los segmentos también pasen por el proxy (necesario en Safari/iPhone).
 *  - Solo responde a las webs de ALLOWED_ORIGINS, para que otros no usen
 *    tu proxy desde sus páginas.
 */

// ⚠️ Cambia esto por la dirección de tu web (sin barra final).
const ALLOWED_ORIGINS = [
  'https://kenequirosm.github.io',
  'http://localhost:8000',          // para pruebas locales (puedes quitarlo)
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Método no permitido', { status: 405, headers: cors });
    }
    // Las peticiones del <video> nativo (Safari) no envían Origin: se permiten.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origen no permitido', { status: 403, headers: cors });
    }

    const self = new URL(request.url);
    let target;
    try { target = new URL(self.searchParams.get('url')); } catch {
      return new Response('Uso: ?url=https://ejemplo.com/stream.m3u8', { status: 400, headers: cors });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return new Response('Solo http/https', { status: 400, headers: cors });
    }

    // Petición al servidor original
    const headers = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    } catch {
      return new Response('No se pudo conectar con el canal', { status: 502, headers: cors });
    }

    const out = new Headers(cors);
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }

    // ¿Es un manifiesto HLS? → reescribir enlaces para que también pasen por aquí
    const type = upstream.headers.get('Content-Type') || '';
    const looksHls = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(upstream.url || target.href);
    if (looksHls && request.method === 'GET' && upstream.ok) {
      const text = await upstream.text();
      if (text.includes('#EXT-X-')) {          // solo manifiestos HLS, no listas de canales
        const base = upstream.url || target.href;
        const wrap = u => `${self.origin}${self.pathname}?url=${encodeURIComponent(new URL(u, base).href)}`;
        const body = text.split('\n').map(line => {
          const t = line.trim();
          if (!t) return line;
          if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
          return wrap(t);
        }).join('\n');
        out.delete('Content-Length');
        out.set('Content-Type', 'application/vnd.apple.mpegurl');
        return new Response(body, { status: upstream.status, headers: out });
      }
      out.delete('Content-Length');
      return new Response(text, { status: upstream.status, headers: out });
    }

    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
