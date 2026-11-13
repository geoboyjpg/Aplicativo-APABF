import { createDatabase } from './db.js';
import {
  createOccurrence,
  getOccurrences,
  OccurrenceInputError,
  validateOccurrenceInput
} from './ocorrencias.js';
import { getTrails } from './trilhas.js';

const TRAILS_PATH = '/api/trilhas';
const OCCURRENCES_PATH = '/api/ocorrencias';
const MAX_BODY_BYTES = 8192;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type');
  if (!contentType || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'Envie os dados como application/json.');
  }

  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RequestError(413, 'O corpo da requisição excede o limite permitido.');
  }

  if (!request.body) {
    throw new RequestError(400, 'O corpo JSON da requisição está vazio.');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    totalBytes += part.value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestError(413, 'O corpo da requisição excede o limite permitido.');
    }
    chunks.push(part.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, 'O corpo da requisição não contém JSON válido.');
  }
}

async function checkPostRateLimit(request, env, origin) {
  const limiter = env.OCCURRENCE_POST_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    return jsonResponse({ error: 'A proteção contra excesso de envios não está configurada.' }, 503, origin);
  }

  try {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    const result = await limiter.limit({ key });
    if (result && result.success) {
      return null;
    }
  } catch {
    console.error('Falha ao verificar o limite de envios de ocorrências.');
    return jsonResponse({ error: 'Não foi possível verificar o limite de envios.' }, 503, origin);
  }

  const response = jsonResponse({ error: 'Limite de envios atingido. Tente novamente mais tarde.' }, 429, origin);
  response.headers.set('Retry-After', '60');
  return response;
}

function supportedMethods(pathname) {
  return pathname === TRAILS_PATH ? ['GET', 'OPTIONS'] : ['GET', 'POST', 'OPTIONS'];
}

export function createWorker(databaseFactory = createDatabase) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== TRAILS_PATH && url.pathname !== OCCURRENCES_PATH) {
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
      const methods = supportedMethods(url.pathname);
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': corsOrigin || allowedOrigin,
            'Access-Control-Allow-Methods': methods.join(', '),
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin'
          }
        });
      }

      if (!methods.includes(request.method)) {
        const response = jsonResponse({ error: 'Método não permitido.' }, 405, corsOrigin);
        response.headers.set('Allow', methods.join(', '));
        return response;
      }

      if (url.pathname === OCCURRENCES_PATH && request.method === 'POST') {
        const rateLimitResponse = await checkPostRateLimit(request, env, corsOrigin);
        if (rateLimitResponse) {
          return rateLimitResponse;
        }
      }

      let input;
      if (url.pathname === OCCURRENCES_PATH && request.method === 'POST') {
        try {
          input = validateOccurrenceInput(await readJsonBody(request));
        } catch (error) {
          if (error instanceof RequestError || error instanceof OccurrenceInputError) {
            return jsonResponse({ error: error.message }, error.status || 400, corsOrigin);
          }
          console.error('Falha ao ler o corpo do cadastro de ocorrência.');
          return jsonResponse({ error: 'Não foi possível ler o cadastro enviado.' }, 400, corsOrigin);
        }
      }

      if (!env.DATABASE_URL) {
        return jsonResponse({ error: 'A conexão com o banco não está configurada.' }, 503, corsOrigin);
      }

      try {
        const sql = databaseFactory(env.DATABASE_URL);
        if (url.pathname === TRAILS_PATH) {
          const collection = await getTrails(sql);
          return jsonResponse(collection, 200, corsOrigin);
        }
        if (request.method === 'GET') {
          const collection = await getOccurrences(sql);
          return jsonResponse(collection, 200, corsOrigin);
        }

        const feature = await createOccurrence(sql, input);
        if (!feature) {
          return jsonResponse(
            { error: 'A trilha informada não existe ou seu identificador não é único.' },
            422,
            corsOrigin
          );
        }
        return jsonResponse(feature, 201, corsOrigin);
      } catch (error) {
        const isTrailsRequest = url.pathname === TRAILS_PATH;
        console.error(
          isTrailsRequest
            ? 'Falha ao consultar trilhas no Neon.'
            : 'Falha ao processar a requisição de ocorrências.',
          {
          name: error instanceof Error ? error.name : 'UnknownError',
          code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
          }
        );
        return jsonResponse({
          error: isTrailsRequest
            ? 'Não foi possível carregar as trilhas.'
            : 'Não foi possível processar as ocorrências.'
        }, 500, corsOrigin);
      }
    }
  };
}

export default createWorker();
