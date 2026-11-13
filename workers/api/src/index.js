import { createDatabase } from './db.js';
import { getTrails } from './trilhas.js';

const API_PATH = '/api/trilhas';

function jsonResponse(body, status, origin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin'
  });

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function validOrigin(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? value : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== API_PATH) {
      return jsonResponse({ error: 'Rota não encontrada.' }, 404);
    }

    const allowedOrigin = validOrigin(env.APP_ORIGIN);
    if (!allowedOrigin) {
      return jsonResponse({ error: 'A origem permitida da API não está configurada.' }, 503);
    }

    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && requestOrigin !== allowedOrigin) {
      return jsonResponse({ error: 'Origem não permitida.' }, 403);
    }

    const corsOrigin = requestOrigin ? allowedOrigin : null;
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin || allowedOrigin,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin'
        }
      });
    }

    if (request.method !== 'GET') {
      const response = jsonResponse({ error: 'Método não permitido.' }, 405, corsOrigin);
      response.headers.set('Allow', 'GET, OPTIONS');
      return response;
    }

    if (!env.DATABASE_URL) {
      return jsonResponse({ error: 'A conexão com o banco não está configurada.' }, 503, corsOrigin);
    }

    try {
      const sql = createDatabase(env.DATABASE_URL);
      const collection = await getTrails(sql);
      return jsonResponse(collection, 200, corsOrigin);
    } catch (error) {
      console.error('Falha ao consultar trilhas no Neon.', {
        name: error instanceof Error ? error.name : 'UnknownError',
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
      });
      return jsonResponse({ error: 'Não foi possível carregar as trilhas.' }, 500, corsOrigin);
    }
  }
};
