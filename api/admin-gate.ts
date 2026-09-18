import { createHmac, timingSafeEqual } from 'node:crypto';

const ALLOWED_PUBLIC_IP = '121.200.220.137';
const ADMIN_PASSWORD = 'Wasim@2965';
const COOKIE_NAME = 'paywai_admin_gate';
const COOKIE_TTL_MS = 8 * 60 * 60 * 1000;

function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || '';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(timestamp: string, ip: string): string {
  return createHmac('sha256', ADMIN_PASSWORD).update(timestamp + ':' + ip).digest('hex');
}

function parseGateCookie(request: Request): string | null {
  const header = request.headers.get('cookie') || '';
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + '='));
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : null;
}

function validGate(request: Request, ip: string): boolean {
  const value = parseGateCookie(request);
  if (!value) return false;

  const [timestamp, signature] = value.split('.');
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;

  const age = Date.now() - Number(timestamp);
  if (age < 0 || age > COOKIE_TTL_MS) return false;

  return safeEqual(signature, sign(timestamp, ip));
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  const ip = getClientIp(request);
  if (ip !== ALLOWED_PUBLIC_IP) return forbidden();

  if (validGate(request, ip)) {
    return new Response(JSON.stringify({ allowed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ allowed: false }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (ip !== ALLOWED_PUBLIC_IP) return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const password = typeof body === 'object' && body !== null && 'password' in body
    ? (body as { password?: unknown }).password
    : undefined;

  if (typeof password !== 'string' || !safeEqual(password, ADMIN_PASSWORD)) {
    return new Response(JSON.stringify({ error: 'invalid_password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const timestamp = String(Date.now());
  const value = timestamp + '.' + sign(timestamp, ip);

  return new Response(JSON.stringify({ allowed: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': COOKIE_NAME + '=' + encodeURIComponent(value) + '; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict',
    },
  });
}
