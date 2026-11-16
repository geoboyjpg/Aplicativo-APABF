import { createDatabase } from './db.js';
import {
  deleteOccurrence,
  createOccurrence,
  getOccurrencePhotoRecords,
  getOccurrences,
  getTrailName,
  OccurrenceInputError,
  occurrenceExists,
  updateOccurrence,
  validateOccurrenceInput,
  validateOccurrenceUpdateInput
} from './ocorrencias.js';
import {
  enqueuePhotoCleanup,
  getOccurrencePhoto,
  PhotoInputError,
  processPhotoCleanup,
  saveOccurrencePhotos,
  uploadOccurrencePhotoObjects,
  validatePhotoFiles
} from './fotografias.js';
import { getTrails } from './trilhas.js';
import { validateAdminRequest } from './admin-auth.js';

const TRAILS_PATH = '/api/trilhas';
const OCCURRENCES_PATH = '/api/ocorrencias';
const MAX_JSON_BODY_BYTES = 8192;
const MAX_MULTIPART_BODY_BYTES = 30 * 1024 * 1024;
const PHOTO_PATH = /^\/api\/ocorrencias\/([^/]+)\/fotografias\/([0-9a-f-]{36})(\/miniatura)?$/i;
const ADMIN_OCCURRENCE_PATH = /^\/api\/ocorrencias\/([1-9]\d{0,18})$/;
const ADMIN_CLEANUP_PATH = /^\/api\/ocorrencias\/([1-9]\d{0,18})\/limpeza$/;

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

async function readBodyBytes(request, maxBytes) {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestError(413, 'O corpo da requisição excede o limite permitido.');
  }
  if (!request.body) {
    throw new RequestError(400, 'O corpo da requisição está vazio.');
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
    if (totalBytes > maxBytes) {
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

  return bytes;
}

async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type');
  if (!contentType || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'Envie os dados como application/json ou multipart/form-data.');
  }
  const bytes = await readBodyBytes(request, MAX_JSON_BODY_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, 'O corpo JSON da requisição não é válido.');
  }
}

async function readMultipartForm(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'multipart/form-data') {
    throw new RequestError(415, 'Envie os dados como multipart/form-data.');
  }
  const bytes = await readBodyBytes(request, MAX_MULTIPART_BODY_BYTES);
  let form;
  try {
    form = await new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes
    }).formData();
  } catch {
    throw new RequestError(400, 'O formulário enviado não contém multipart válido.');
  }

  const occurrenceText = form.get('occurrence');
  if (typeof occurrenceText !== 'string') {
    throw new RequestError(400, 'Os dados da ocorrência não foram informados.');
  }
  let body;
  try {
    body = JSON.parse(occurrenceText);
  } catch {
    throw new RequestError(400, 'Os dados da ocorrência não contêm JSON válido.');
  }
  const files = form.getAll('photo');
  const thumbnails = form.getAll('thumbnail');
  if (files.some((file) => typeof file === 'string')
      || thumbnails.some((file) => typeof file === 'string')) {
    throw new RequestError(400, 'Envie fotografias como arquivos.');
  }
  return { body, files, thumbnails };
}

async function readMultipartBody(request) {
  const parsed = await readMultipartForm(request);
  return {
    input: validateOccurrenceInput(parsed.body),
    photos: await validatePhotoFiles(parsed.files, parsed.thumbnails)
  };
}

function readKeepPhotoIds(body) {
  if (body.keep_photo_ids === undefined) {
    return null;
  }
  const ids = body.keep_photo_ids;
  if (!Array.isArray(ids) || ids.length > 5
      || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      || new Set(ids).size !== ids.length) {
    throw new RequestError(400, 'A lista de fotografias a manter não é válida.');
  }
  return ids;
}

function readKeepLegacyPhotoIndexes(body) {
  if (body.keep_legacy_photo_indexes === undefined) {
    return null;
  }
  const indexes = body.keep_legacy_photo_indexes;
  if (!Array.isArray(indexes) || indexes.length > 5
      || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 4)
      || new Set(indexes).size !== indexes.length) {
    throw new RequestError(400, 'A lista de fotografias antigas a manter não é válida.');
  }
  return indexes;
}

async function readOccurrenceUpdateBody(request) {
  const mediaType = (request.headers.get('Content-Type') || '')
    .split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') {
    const body = await readJsonBody(request);
    return {
      input: validateOccurrenceUpdateInput(body),
      keepPhotoIds: readKeepPhotoIds(body),
      keepLegacyPhotoIndexes: readKeepLegacyPhotoIndexes(body),
      photos: []
    };
  }
  if (mediaType === 'multipart/form-data') {
    const parsed = await readMultipartForm(request);
    return {
      input: validateOccurrenceUpdateInput(parsed.body),
      keepPhotoIds: readKeepPhotoIds(parsed.body),
      keepLegacyPhotoIndexes: readKeepLegacyPhotoIndexes(parsed.body),
      photos: await validatePhotoFiles(parsed.files, parsed.thumbnails)
    };
  }
  throw new RequestError(415, 'Envie os dados como application/json ou multipart/form-data.');
}

async function readOccurrenceBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') {
    return {
      input: validateOccurrenceInput(await readJsonBody(request)),
      photos: []
    };
  }
  if (mediaType === 'multipart/form-data') {
    return readMultipartBody(request);
  }
  throw new RequestError(415, 'Envie os dados como application/json ou multipart/form-data.');
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

function supportedMethods(pathname, photoMatch, cleanupMatch, adminOccurrenceMatch) {
  if (pathname === TRAILS_PATH) {
    return ['GET', 'OPTIONS'];
  }
  if (pathname === OCCURRENCES_PATH) {
    return ['GET', 'POST', 'OPTIONS'];
  }
  if (photoMatch) {
    return ['GET', 'OPTIONS'];
  }
  if (cleanupMatch) {
    return ['POST', 'OPTIONS'];
  }
  if (adminOccurrenceMatch) {
    return ['PATCH', 'DELETE', 'OPTIONS'];
  }
  return ['GET', 'OPTIONS'];
}

function photoResponse(object, origin) {
  if (!object) {
    return jsonResponse({ error: 'Fotografia não encontrada.' }, 404, origin);
  }
  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin'
  });
  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag);
  }
  if (object.writeHttpMetadata) {
    object.writeHttpMetadata(headers);
    headers.set('Content-Disposition', 'inline');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'public, max-age=300');
    headers.set('Vary', 'Origin');
  }
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return new Response(object.body, { status: 200, headers });
}

async function compensateUploadedPhotos(sql, bucket, occurrenceId, keys) {
  const uniqueKeys = Array.from(new Set(keys));
  if (!uniqueKeys.length) {
    return 0;
  }
  try {
    await enqueuePhotoCleanup(sql, occurrenceId, uniqueKeys);
  } catch {
    console.error('Não foi possível persistir a limpeza de fotografias após uma falha de edição.', {
      occurrenceId,
      failedCount: uniqueKeys.length
    });
    return uniqueKeys.length;
  }
  try {
    const cleanup = await processPhotoCleanup(sql, bucket, occurrenceId);
    return cleanup.pendingCount;
  } catch {
    console.error('Não foi possível processar a limpeza compensatória das fotografias.', {
      occurrenceId,
      failedCount: uniqueKeys.length
    });
    return uniqueKeys.length;
  }
}

export function createWorker(databaseFactory = createDatabase) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const photoMatch = url.pathname.match(PHOTO_PATH);
      const cleanupMatch = url.pathname.match(ADMIN_CLEANUP_PATH);
      const adminOccurrenceMatch = url.pathname.match(ADMIN_OCCURRENCE_PATH);
      if (url.pathname !== TRAILS_PATH && url.pathname !== OCCURRENCES_PATH
          && !photoMatch && !cleanupMatch && !adminOccurrenceMatch) {
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
      const methods = supportedMethods(url.pathname, photoMatch, cleanupMatch, adminOccurrenceMatch);
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': corsOrigin || allowedOrigin,
            'Access-Control-Allow-Methods': methods.join(', '),
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

      const isAdminRoute = Boolean(cleanupMatch || adminOccurrenceMatch);
      if (isAdminRoute) {
        const authorizationError = await validateAdminRequest(request, env);
        if (authorizationError) {
          return jsonResponse(
            { error: authorizationError.message },
            authorizationError.status,
            corsOrigin
          );
        }
      }

      if (url.pathname === OCCURRENCES_PATH && request.method === 'POST') {
        const rateLimitResponse = await checkPostRateLimit(request, env, corsOrigin);
        if (rateLimitResponse) {
          return rateLimitResponse;
        }
      }

      let input;
      let photos = [];
      let keepPhotoIds = [];
      let keepLegacyPhotoIndexes = null;
      if (adminOccurrenceMatch && request.method === 'PATCH') {
        try {
          const parsed = await readOccurrenceUpdateBody(request);
          input = parsed.input;
          photos = parsed.photos;
          keepPhotoIds = parsed.keepPhotoIds;
          keepLegacyPhotoIndexes = parsed.keepLegacyPhotoIndexes;
          if (photos.length && (!env.OCCURRENCE_PHOTOS
              || typeof env.OCCURRENCE_PHOTOS.put !== 'function')) {
            return jsonResponse({ error: 'O armazenamento de fotografias não está configurado.' }, 503, corsOrigin);
          }
        } catch (error) {
          if (error instanceof RequestError || error instanceof OccurrenceInputError
              || error instanceof PhotoInputError) {
            return jsonResponse({ error: error.message }, error.status || 400, corsOrigin);
          }
          console.error('Falha ao ler a atualização da ocorrência.');
          return jsonResponse({ error: 'Não foi possível ler a atualização enviada.' }, 400, corsOrigin);
        }
      }
      if (url.pathname === OCCURRENCES_PATH && request.method === 'POST') {
        try {
          const parsed = await readOccurrenceBody(request);
          input = parsed.input;
          photos = parsed.photos;
          if (photos.length && (!env.OCCURRENCE_PHOTOS
              || typeof env.OCCURRENCE_PHOTOS.put !== 'function')) {
            return jsonResponse({ error: 'O armazenamento de fotografias não está configurado.' }, 503, corsOrigin);
          }
        } catch (error) {
          if (error instanceof RequestError || error instanceof OccurrenceInputError
              || error instanceof PhotoInputError) {
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
        if (adminOccurrenceMatch && request.method === 'DELETE') {
          await deleteOccurrence(sql, adminOccurrenceMatch[1]);
          if (await occurrenceExists(sql, adminOccurrenceMatch[1])) {
            return jsonResponse(
              { error: 'A ocorrência permanece cadastrada; nenhuma exclusão foi confirmada.' },
              409,
              corsOrigin
            );
          }
          const cleanup = await processPhotoCleanup(
            sql,
            env.OCCURRENCE_PHOTOS,
            adminOccurrenceMatch[1]
          );
          return jsonResponse({
            ocorrencia_id: adminOccurrenceMatch[1],
            deleted: true,
            limpeza: cleanup.pendingCount ? 'pendente' : 'concluida',
            arquivos_pendentes: cleanup.pendingCount
          }, cleanup.pendingCount ? 202 : 200, corsOrigin);
        }
        if (cleanupMatch && request.method === 'POST') {
          const cleanup = await processPhotoCleanup(
            sql,
            env.OCCURRENCE_PHOTOS,
            cleanupMatch[1]
          );
          return jsonResponse({
            ocorrencia_id: cleanupMatch[1],
            limpeza: cleanup.pendingCount ? 'pendente' : 'concluida',
            arquivos_pendentes: cleanup.pendingCount
          }, cleanup.pendingCount ? 202 : 200, corsOrigin);
        }
        if (adminOccurrenceMatch && request.method === 'PATCH') {
          const occurrenceId = adminOccurrenceMatch[1];
          const currentCollection = await getOccurrences(sql, occurrenceId);
          const currentFeature = currentCollection.features[0];
          if (!currentFeature) {
            return jsonResponse({ error: 'Ocorrência não encontrada.' }, 404, corsOrigin);
          }

          const photoRecords = await getOccurrencePhotoRecords(sql, occurrenceId);
          const managedPhotoIds = new Set(photoRecords.map((photo) => photo.foto_id));
          if (keepPhotoIds && keepPhotoIds.some((photoId) => !managedPhotoIds.has(photoId))) {
            return jsonResponse(
              { error: 'A lista de fotografias a manter não corresponde à ocorrência.' },
              400,
              corsOrigin
            );
          }
          const legacyPhotoCount = currentFeature.properties.fotografias
            .filter((photo) => !photo || typeof photo !== 'object' || photo.gerenciada !== true).length;
          const legacyIndexes = keepLegacyPhotoIndexes === null
            ? Array.from({ length: legacyPhotoCount }, (_, index) => index)
            : keepLegacyPhotoIndexes;
          const retainedManagedCount = keepPhotoIds === null
            ? managedPhotoIds.size
            : keepPhotoIds.length;
          if (legacyIndexes.some((index) => index >= legacyPhotoCount)) {
            return jsonResponse(
              { error: 'A lista de fotografias antigas a manter não corresponde à ocorrência.' },
              400,
              corsOrigin
            );
          }
          if (legacyIndexes.length + retainedManagedCount + photos.length > 5) {
            return jsonResponse(
              { error: 'A ocorrência pode ter no máximo 5 fotografias.' },
              400,
              corsOrigin
            );
          }

          const trailName = await getTrailName(sql, input.trailId);
          if (!trailName) {
            return jsonResponse(
              { error: 'A trilha informada não existe ou seu identificador não é único.' },
              422,
              corsOrigin
            );
          }
          let uploaded = { records: [], storedKeys: [] };
          if (photos.length) {
            try {
              uploaded = await uploadOccurrencePhotoObjects(
                env.OCCURRENCE_PHOTOS,
                photos,
                trailName
              );
            } catch (error) {
              const pendingCount = await compensateUploadedPhotos(
                sql,
                env.OCCURRENCE_PHOTOS,
                occurrenceId,
                error.storedKeys || []
              );
              return jsonResponse({
                error: 'Não foi possível armazenar as novas fotografias.',
                arquivos_pendentes: pendingCount
              }, 500, corsOrigin);
            }
          }

          let updated;
          try {
            updated = await updateOccurrence(
              sql,
              occurrenceId,
              input,
              keepPhotoIds === null ? Array.from(managedPhotoIds) : keepPhotoIds,
              keepLegacyPhotoIndexes,
              uploaded.records
            );
          } catch (error) {
            const pendingCount = await compensateUploadedPhotos(
              sql,
              env.OCCURRENCE_PHOTOS,
              occurrenceId,
              uploaded.storedKeys
            );
            console.error('Falha ao atualizar ocorrência no Neon.', {
              name: error instanceof Error ? error.name : 'UnknownError',
              pendingPhotoCleanup: pendingCount
            });
            return jsonResponse({
              error: 'Não foi possível atualizar a ocorrência.',
              arquivos_pendentes: pendingCount
            }, 500, corsOrigin);
          }
          if (!updated) {
            const pendingCount = await compensateUploadedPhotos(
              sql,
              env.OCCURRENCE_PHOTOS,
              occurrenceId,
              uploaded.storedKeys
            );
            return jsonResponse({
              error: 'A ocorrência não pôde ser atualizada.',
              arquivos_pendentes: pendingCount
            }, 404, corsOrigin);
          }

          const cleanup = await processPhotoCleanup(
            sql,
            env.OCCURRENCE_PHOTOS,
            occurrenceId
          );
          const updatedCollection = await getOccurrences(sql, occurrenceId);
          const feature = updatedCollection.features[0];
          if (!feature) {
            throw new Error('A ocorrência atualizada não foi encontrada após a gravação.');
          }
          return jsonResponse({
            ...feature,
            limpeza_pendente: cleanup.pendingCount
          }, cleanup.pendingCount ? 202 : 200, corsOrigin);
        }
        if (request.method === 'GET') {
          if (photoMatch) {
            if (!env.OCCURRENCE_PHOTOS || typeof env.OCCURRENCE_PHOTOS.get !== 'function') {
              return jsonResponse({ error: 'O armazenamento de fotografias não está configurado.' }, 503, corsOrigin);
            }
            const occurrenceId = decodeURIComponent(photoMatch[1]);
            const object = await getOccurrencePhoto(
              sql,
              env.OCCURRENCE_PHOTOS,
              occurrenceId,
              photoMatch[2],
              Boolean(photoMatch[3])
            );
            return photoResponse(object, corsOrigin);
          }
          const collection = await getOccurrences(sql);
          return jsonResponse(collection, 200, corsOrigin);
        }

        const created = await createOccurrence(sql, input);
        if (!created) {
          return jsonResponse(
            { error: 'A trilha informada não existe ou seu identificador não é único.' },
            422,
            corsOrigin
          );
        }
        const feature = created.feature;
        if (photos.length) {
          feature.properties.fotografias = await saveOccurrencePhotos(
            sql,
            env.OCCURRENCE_PHOTOS,
            feature.properties.ocorrencia_id,
            photos,
            created.trailName
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
