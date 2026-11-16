import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { createWorker } from '../src/index.js';
import {
  createOccurrence,
  getOccurrences,
  validateOccurrenceInput
} from '../src/ocorrencias.js';
import {
  formatUploadDate,
  getOccurrencePhoto,
  validatePhotoFiles
} from '../src/fotografias.js';
import { getTrails } from '../src/trilhas.js';

const APP_ORIGIN = 'https://geoboyjpg.github.io';
const geometry = {
  type: 'Point',
  coordinates: [-49.2, -28.8]
};
const occurrenceRow = {
  ocorrencia_id: '42',
  trilha_fid: 1,
  trilha_nome: 'Praia do Rosa',
  categoria: 'erosao_solo',
  descricao: 'Trecho com erosão.',
  data_identificacao: '2026-11-13',
  situacao: 'pendente_avaliacao',
  fotografias: [],
  geometry: JSON.stringify(geometry)
};
const validPayload = {
  trilha_fid: '1',
  coordinates: [-49.2, -28.8],
  categoria: 'erosao_solo',
  descricao: 'Trecho com erosão.',
  data_identificacao: '2026-11-13'
};
const ADMIN_TOKEN = 'test-admin-token-value-32-chars-minimum-for-unit-tests';

function createSql(resultRows) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ query: strings.join('?'), values });
    return typeof resultRows === 'function' ? resultRows(strings.join('?'), values) : resultRows;
  };
  sql.calls = calls;
  return sql;
}

function createAdminSql(initialRow, initialPhotos = [], initialCleanup = []) {
  let row = { ...initialRow };
  let exists = true;
  const photos = initialPhotos.map((photo) => ({ ...photo }));
  const cleanup = initialCleanup.map((item) => ({ ...item }));
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join('?');
    calls.push({ query, values });
    if (query.includes('SELECT cleanup_id::text AS cleanup_id')) {
      return cleanup.filter((item) => item.ocorrencia_id === '42').slice(0, 50);
    }
    if (query.includes('SELECT count(*)::int AS quantidade')) {
      return [{ quantidade: cleanup.filter((item) => item.ocorrencia_id === '42').length }];
    }
    if (query.includes('DELETE FROM public.ocorrencias_trilhas_fotografias_cleanup')) {
      const cleanupId = values.find((value) => typeof value === 'string' && value.startsWith('cleanup-'));
      const index = cleanup.findIndex((item) => item.cleanup_id === cleanupId);
      if (index !== -1) {
        cleanup.splice(index, 1);
      }
      return [];
    }
    if (query.includes('UPDATE public.ocorrencias_trilhas_fotografias_cleanup')) {
      return [];
    }
    if (query.includes('target AS MATERIALIZED')) {
      if (!exists) {
        return [];
      }
      photos.forEach((photo) => {
        [photo.arquivo, photo.miniatura].filter(Boolean).forEach((arquivo) => {
          if (!cleanup.some((item) => item.arquivo === arquivo)) {
            cleanup.push({
              cleanup_id: `cleanup-${cleanup.length + 1}`,
              ocorrencia_id: '42',
              arquivo
            });
          }
        });
      });
      exists = false;
      photos.length = 0;
      return [{ ocorrencia_id: '42' }];
    }
    if (query.includes('SELECT EXISTS')) {
      return [{ exists }];
    }
    if (query.includes('foto_id::text AS foto_id')) {
      return photos;
    }
    if (query.includes('WITH selected_trail AS')) {
      if (!exists) {
        return [];
      }
      const keptIds = JSON.parse(values[10]);
      const records = JSON.parse(values[11]);
      const keptLegacyIndexes = JSON.parse(values[7]);
      const removed = photos.filter((photo) => !keptIds.includes(photo.foto_id));
      removed.forEach((photo) => {
        [photo.arquivo, photo.miniatura].filter(Boolean).forEach((arquivo) => {
          if (!cleanup.some((item) => item.arquivo === arquivo)) {
            cleanup.push({
              cleanup_id: `cleanup-${cleanup.length + 1}`,
              ocorrencia_id: '42',
              arquivo
            });
          }
        });
      });
      for (let index = photos.length - 1; index >= 0; index -= 1) {
        if (!keptIds.includes(photos[index].foto_id)) {
          photos.splice(index, 1);
        }
      }
      photos.push(...records);
      row = {
        ...row,
        trilha_fid: Number(values[0]),
        categoria: values[3],
        descricao: values[4],
        data_identificacao: values[5],
        situacao: values[6],
        fotografias: (Array.isArray(row.fotografias) ? row.fotografias : [])
          .filter((_, index) => keptLegacyIndexes.includes(index)),
        geometry: JSON.stringify({ type: 'Point', coordinates: [values[1], values[2]] })
      };
      return [{ ocorrencia_id: '42' }];
    }
    if (query.includes('FROM public.ocorrencias_trilhas AS o')) {
      if (!exists) {
        return [];
      }
      const managed = photos.map((photo) => ({
        foto_id: photo.foto_id,
        gerenciada: true,
        url: `/api/ocorrencias/42/fotografias/${photo.foto_id}`,
        miniatura_url: photo.miniatura
          ? `/api/ocorrencias/42/fotografias/${photo.foto_id}/miniatura`
          : null
      }));
      return [{
        ...row,
        fotografias: [...(Array.isArray(row.fotografias) ? row.fotografias : []), ...managed]
      }];
    }
    if (query.includes('SELECT nome') && query.includes('public.trilhas_apabf')) {
      return [{ nome: 'Praia do Rosa' }];
    }
    return [];
  };
  sql.calls = calls;
  sql.state = { cleanup, photos, get exists() { return exists; }, get row() { return row; } };
  return sql;
}

function createEnvironment(sql, limiter = { limit: async () => ({ success: true }) }) {
  return {
    APP_ORIGIN,
    DATABASE_URL: 'test-connection-not-used',
    OCCURRENCE_POST_LIMITER: limiter,
    OCCURRENCE_ADMIN_LIMITER: { limit: async () => ({ success: true }) },
    OCCURRENCE_ADMIN_TOKEN: ADMIN_TOKEN,
    sql
  };
}

function jpegFile(size = 4) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return new Blob([bytes], { type: 'image/jpeg' });
}

function webpFile() {
  return new Blob([
    Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
  ], { type: 'image/webp' });
}

function multipartOccurrenceRequest(files) {
  const form = new FormData();
  form.append('occurrence', JSON.stringify(validPayload));
  files.forEach((file, index) => {
    form.append('photo', file, `foto-${index + 1}.jpg`);
    form.append('thumbnail', webpFile(), `miniatura-${index + 1}.webp`);
  });
  return new Request('https://api.example.test/api/ocorrencias', {
    method: 'POST',
    headers: {
      Origin: APP_ORIGIN,
      'CF-Connecting-IP': '192.0.2.13'
    },
    body: form
  });
}

function multipartEditRequest(files, keepPhotoIds = [], keepLegacyPhotoIndexes = []) {
  const form = new FormData();
  form.append('occurrence', JSON.stringify({
    ...validPayload,
    categoria: 'problemas_acesso',
    descricao: 'Descrição editada.',
    situacao: 'em_atendimento',
    coordinates: [-49.1, -28.7],
    keep_photo_ids: keepPhotoIds,
    keep_legacy_photo_indexes: keepLegacyPhotoIndexes
  }));
  files.forEach((file, index) => {
    form.append('photo', file, `galeria-${index + 1}.jpg`);
    form.append('thumbnail', webpFile(), `thumb-${index + 1}.webp`);
  });
  return new Request('https://api.example.test/api/ocorrencias/42', {
    method: 'PATCH',
    headers: {
      Origin: APP_ORIGIN,
      'CF-Connecting-IP': '192.0.2.14',
      Authorization: `Bearer ${ADMIN_TOKEN}`
    },
    body: form
  });
}

function adminRequest(method, path, body) {
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      'CF-Connecting-IP': '192.0.2.15',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function photoBucket(objects, failAtPut, failAtDelete, failAtHead) {
  let putCount = 0;
  let deleteCount = 0;
  let headCount = 0;
  const deletedKeys = [];
  return {
    head: async (key) => {
      headCount += 1;
      if (headCount === failAtHead) {
        return {};
      }
      return objects.has(key) ? {} : null;
    },
    put: async (key, body, options) => {
      putCount += 1;
      if (putCount === failAtPut) {
        throw new Error('R2 upload failed');
      }
      objects.set(key, { body, options });
    },
    delete: async (key) => {
      deleteCount += 1;
      deletedKeys.push(key);
      if (deleteCount === failAtDelete) {
        throw new Error('R2 delete failed');
      }
      objects.delete(key);
    },
    deletedKeys
  };
}

test('validates required occurrence fields and allows an omitted description', function () {
  const input = validateOccurrenceInput({
    ...validPayload,
    descricao: undefined,
    situacao: 'resolvida'
  });

  assert.equal(input.trailId, '1');
  assert.equal(input.description, null);
  assert.equal(input.category, 'erosao_solo');
  assert.equal(input.date, '2026-11-13');
  assert.equal(input.longitude, -49.2);
  assert.equal(input.latitude, -28.8);
  assert.equal(Object.hasOwn(input, 'situation'), false);
});

test('formats photo dates in the Brasília timezone', function () {
  assert.equal(
    formatUploadDate(new Date('2026-11-17T02:30:00.000Z')),
    '2026-11-16'
  );
});

test('rejects invalid trail, category, date, coordinates, and photograph payloads', function () {
  [
    { ...validPayload, trilha_fid: '1 OR 1=1' },
    { ...validPayload, categoria: 'categoria_desconhecida' },
    { ...validPayload, data_identificacao: '2026-02-30' },
    { ...validPayload, coordinates: [181, 0] },
    { ...validPayload, coordinates: [-49, Number.NaN] },
    { ...validPayload, fotografias: ['data:image/jpeg;base64,abc'] },
    { ...validPayload, descricao: 'x'.repeat(2001) }
  ].forEach((payload) => {
    assert.throws(() => validateOccurrenceInput(payload));
  });
});

test('validates image signatures, MIME types, sizes, and the five-photo limit', async function () {
  const jpeg = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0x00])], { type: 'image/jpeg' });
  const webp = new Blob([
    Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
  ], { type: 'image/webp' });

  assert.equal((await validatePhotoFiles([jpeg], [webp])).length, 1);
  await assert.rejects(
    validatePhotoFiles([new Blob(['not an image'], { type: 'image/jpeg' })], []),
    /JPEG, PNG ou WebP válida/
  );
  await assert.rejects(
    validatePhotoFiles([new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' })], []),
    /até 5 MB/
  );
  await assert.rejects(validatePhotoFiles([jpeg, jpeg, jpeg, jpeg, jpeg, jpeg], []), /no máximo 5/);
});

test('reads existing occurrence rows as a GeoJSON FeatureCollection', async function () {
  const sql = createSql([occurrenceRow]);
  const collection = await getOccurrences(sql);

  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.features.length, 1);
  assert.deepEqual(collection.features[0], {
    type: 'Feature',
    properties: {
      ocorrencia_id: '42',
      trilha_fid: 1,
      categoria: 'erosao_solo',
      descricao: 'Trecho com erosão.',
      data_identificacao: '2026-11-13',
      situacao: 'pendente_avaliacao',
      fotografias: []
    },
    geometry
  });
  assert.match(sql.calls[0].query, /JOIN public\.trilhas_apabf/);
  assert.match(sql.calls[0].query, /o\.trilha_ogc_fid/);
  assert.match(sql.calls[0].query, /ST_AsGeoJSON\(o\.geom/);
});

test('GET /api/ocorrencias returns the database rows with the app CORS origin', async function () {
  const sql = createSql([occurrenceRow]);
  const app = createWorker(() => sql);
  const response = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias', {
      headers: { Origin: APP_ORIGIN }
    }),
    createEnvironment(sql)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  assert.equal(body.type, 'FeatureCollection');
  assert.equal(body.features[0].properties.ocorrencia_id, '42');
});

test('GET photo route serves only the object returned from registered photo metadata', async function () {
  let queriedKey;
  const sql = createSql((query) => {
    assert.match(query, /ocorrencias_trilhas_fotografias/);
    return [{ arquivo: 'ocorrencias/42/registered.png', tipo_mime: 'image/png' }];
  });
  const app = createWorker(() => sql);
  const response = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias/42/fotografias/12345678-1234-1234-1234-123456789abc', {
      headers: { Origin: APP_ORIGIN }
    }),
    {
      ...createEnvironment(sql),
      OCCURRENCE_PHOTOS: {
        get: async (key) => {
          queriedKey = key;
          return {
            body: new Blob(['image']),
            httpMetadata: { contentType: 'image/png' }
          };
        }
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN);
  assert.equal(queriedKey, 'ocorrencias/42/registered.png');
});

test('inserts with parameters, server-assigned pending status, and database defaults', async function () {
  const sql = createSql([occurrenceRow]);
  const input = validateOccurrenceInput(validPayload);
  const created = await createOccurrence(sql, input);
  const call = sql.calls[0];

  assert.equal(created.trailName, 'Praia do Rosa');
  const feature = created.feature;
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.properties.situacao, 'pendente_avaliacao');
  assert.match(call.query, /INSERT INTO public\.ocorrencias_trilhas/);
  assert.match(call.query, /pg_advisory_xact_lock/);
  assert.match(call.query, /pg_get_serial_sequence/);
  assert.match(call.query, /setval\([\s\S]*1,[\s\S]*false/);
  assert.match(call.query, /WHEN NOT EXISTS \(SELECT 1 FROM public\.ocorrencias_trilhas\)/);
  assert.match(call.query, /WHERE fid::text = \?/);
  assert.match(call.query, /ST_SetSRID\(ST_MakePoint\(\?, \?\), 4326\)/);
  const insertedColumns = call.query.match(
    /INSERT INTO public\.ocorrencias_trilhas \(([\s\S]*?)\)\s*SELECT/
  )[1];
  assert.doesNotMatch(insertedColumns, /ocorrencia_id|criado_em|atualizado_em|fotos/);
  assert.deepEqual(call.values, [
    '1',
    -49.2,
    -28.8,
    'erosao_solo',
    'Trecho com erosão.',
    '2026-11-13',
    'pendente_avaliacao'
  ]);
});

test('POST /api/ocorrencias creates one feature and assigns pending status on the server', async function () {
  const sql = createSql([occurrenceRow]);
  const app = createWorker(() => sql);
  const env = createEnvironment(sql);
  delete env.OCCURRENCE_ADMIN_TOKEN;
  const response = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias', {
      method: 'POST',
      headers: {
        Origin: APP_ORIGIN,
        'CF-Connecting-IP': '192.0.2.12',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(validPayload)
    }),
    env
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.type, 'Feature');
  assert.equal(body.properties.situacao, 'pendente_avaliacao');
  assert.equal(sql.calls.length, 1);
});

test('multipart occurrence creation stores photo and thumbnail under generated R2 keys', async function () {
  const sql = createSql([occurrenceRow]);
  const objects = new Map();
  const app = createWorker(() => sql);
  const request = multipartOccurrenceRequest([jpegFile()]);
  const response = await app.fetch(
    request,
    {
      ...createEnvironment(sql),
      OCCURRENCE_PHOTOS: photoBucket(objects, undefined, undefined, 1)
    }
  );
  const body = await response.json();

  assert.match(request.headers.get('Content-Type'), /^multipart\/form-data; boundary=/);
  assert.equal(response.status, 201);
  assert.equal(body.properties.fotografias.length, 1);
  assert.match(body.properties.fotografias[0].url, /\/api\/ocorrencias\/42\/fotografias\/[0-9a-f-]{36}$/);
  assert.equal(objects.size, 2);
  const keys = Array.from(objects.keys());
  assert.ok(keys.every((key) => key.startsWith('ocorrencias/praia-do-rosa/')));
  assert.ok(Array.from(objects.keys()).every((key) => !key.includes('user-supplied-name')));
  assert.ok(keys.every((key) =>
    /^ocorrencias\/praia-do-rosa\/praia-do-rosa_\d{4}-\d{2}-\d{2}_[0-9a-f]{12}(?:_thumb)?\.(?:jpg|webp)$/.test(key)
  ));
  const originalKey = keys.find((key) => key.endsWith('.jpg'));
  const thumbnailKey = keys.find((key) => key.endsWith('_thumb.webp'));
  assert.ok(originalKey);
  assert.ok(thumbnailKey);
  assert.equal(
    thumbnailKey,
    `${originalKey.slice(0, -'.jpg'.length)}_thumb.webp`
  );
  const insertCall = sql.calls.find((call) =>
    call.query.includes('INSERT INTO public.ocorrencias_trilhas_fotografias')
  );
  assert.ok(insertCall);
  const records = JSON.parse(insertCall.values.find((value) =>
    typeof value === 'string' && value.startsWith('[')
  ));
  assert.equal(records[0].arquivo, originalKey);
  assert.equal(records[0].miniatura, thumbnailKey);
  assert.equal(records[0].nome_original, 'foto-1.jpg');
});

test('multipart occurrence creation accepts five photographs', async function () {
  const sql = createSql([occurrenceRow]);
  const objects = new Map();
  const app = createWorker(() => sql);
  const response = await app.fetch(
    multipartOccurrenceRequest([jpegFile(), jpegFile(), jpegFile(), jpegFile(), jpegFile()]),
    {
      ...createEnvironment(sql),
      OCCURRENCE_PHOTOS: photoBucket(objects)
    }
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.properties.fotografias.length, 5);
  assert.equal(objects.size, 10);
  const keys = Array.from(objects.keys());
  const originals = keys.filter((key) => key.endsWith('.jpg'));
  const stems = originals.map((key) => key.slice(0, -'.jpg'.length));
  assert.equal(new Set(stems).size, 5);
  assert.ok(keys.every((key) => key.startsWith('ocorrencias/praia-do-rosa/')));
  stems.forEach((stem) => assert.ok(objects.has(`${stem}_thumb.webp`)));
  const insertCall = sql.calls.find((call) =>
    call.query.includes('INSERT INTO public.ocorrencias_trilhas_fotografias')
  );
  assert.ok(insertCall);
  assert.equal(JSON.parse(insertCall.values.find((value) =>
    typeof value === 'string' && value.startsWith('[')
  )).length, 5);
});

test('rejects oversized and unsupported photo files before inserting an occurrence', async function () {
  for (const [file, expectedStatus, expectedMessage] of [
    [jpegFile(5 * 1024 * 1024 + 1), 413, /até 5 MB/],
    [new Blob(['not a permitted image'], { type: 'image/gif' }), 400, /JPEG, PNG ou WebP válida/]
  ]) {
    let databaseCreated = false;
    const app = createWorker(() => {
      databaseCreated = true;
      return createSql([occurrenceRow]);
    });
    const response = await app.fetch(
      multipartOccurrenceRequest([file]),
      {
        ...createEnvironment(null),
        OCCURRENCE_PHOTOS: photoBucket(new Map())
      }
    );
    const body = await response.json();

    assert.equal(response.status, expectedStatus);
    assert.match(body.error, expectedMessage);
    assert.equal(databaseCreated, false);
  }
});

test('compensates occurrence metadata and R2 objects when a later upload fails', async function () {
  const sql = createSql([occurrenceRow]);
  const objects = new Map();
  const app = createWorker(() => sql);
  const response = await app.fetch(
    multipartOccurrenceRequest([jpegFile(), jpegFile()]),
    {
      ...createEnvironment(sql),
      OCCURRENCE_PHOTOS: photoBucket(objects, 3)
    }
  );

  assert.equal(response.status, 500);
  assert.equal(objects.size, 0);
  assert.ok(sql.calls.some((call) => /DELETE FROM public\.ocorrencias_trilhas/.test(call.query)));
});

test('requires Worker authorization for administrative routes and rate-limits attempts', async function () {
  const app = createWorker(() => {
    throw new Error('The database must not be opened before authorization.');
  });
  const request = adminRequest('DELETE', '/api/ocorrencias/42');
  const noSecret = createEnvironment(null);
  delete noSecret.OCCURRENCE_ADMIN_TOKEN;

  const missingSecret = await app.fetch(request, noSecret);
  const missingToken = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias/42', {
      method: 'DELETE',
      headers: { Origin: APP_ORIGIN }
    }),
    createEnvironment(null)
  );
  const throttled = await app.fetch(request, {
    ...createEnvironment(null),
    OCCURRENCE_ADMIN_LIMITER: { limit: async () => ({ success: false }) }
  });

  assert.equal(missingSecret.status, 503);
  assert.equal(missingToken.status, 401);
  assert.equal(throttled.status, 429);
});

test('PATCH edits an occurrence in place, changes geometry and adds photos with generated names', async function () {
  const existingId = '11111111-1111-4111-8111-111111111111';
  const sql = createAdminSql({
    ...occurrenceRow,
    fotografias: [{ url: 'https://legacy.example/photo.jpg' }]
  }, [{
    foto_id: existingId,
    arquivo: 'ocorrencias/42/old.jpg',
    miniatura: 'ocorrencias/42/old_thumb.webp',
    nome_original: 'old.jpg',
    tipo_mime: 'image/jpeg',
    miniatura_tipo_mime: 'image/webp',
    tamanho_bytes: 4
  }]);
  const objects = new Map();
  const bucket = photoBucket(objects);
  const app = createWorker(() => sql);
  const response = await app.fetch(
    multipartEditRequest([jpegFile()], [existingId], [0]),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );
  const feature = await response.json();

  assert.equal(response.status, 200, JSON.stringify({ feature, calls: sql.calls }));
  assert.equal(feature.properties.ocorrencia_id, '42');
  assert.equal(feature.properties.categoria, 'problemas_acesso');
  assert.equal(feature.properties.descricao, 'Descrição editada.');
  assert.equal(feature.properties.situacao, 'em_atendimento');
  assert.deepEqual(feature.geometry.coordinates, [-49.1, -28.7]);
  assert.equal(feature.properties.fotografias.length, 3);
  assert.deepEqual(
    feature.properties.fotografias.filter((photo) => photo.gerenciada).map((photo) => photo.foto_id),
    [existingId, sql.state.photos[1].foto_id]
  );
  assert.ok(sql.calls.some((call) => /UPDATE public\.ocorrencias_trilhas AS occurrence/.test(call.query)));
  assert.ok(sql.calls.every((call) => !/INSERT INTO public\.ocorrencias_trilhas\s*\(/.test(call.query)));
  assert.ok(Array.from(objects.keys()).some((key) =>
    /ocorrencias\/praia-do-rosa\/praia-do-rosa_\d{4}-\d{2}-\d{2}_[0-9a-f]{12}\.jpg$/.test(key)
  ));
  assert.ok(Array.from(objects.keys()).some((key) => /_thumb\.webp$/.test(key)));
  assert.equal(objects.has(sql.state.photos[1].arquivo), true);
  assert.equal(objects.has(sql.state.photos[1].miniatura), true);
  assert.ok(sql.state.photos.every((photo) => photo.nome_original === 'galeria-1.jpg'
    || photo.foto_id === existingId));
});

test('PATCH removes selected photos while preserving the others and queues both R2 objects', async function () {
  const removedId = '11111111-1111-4111-8111-111111111111';
  const keptId = '22222222-2222-4222-8222-222222222222';
  const photos = [
    {
      foto_id: removedId,
      arquivo: 'ocorrencias/42/removed.jpg',
      miniatura: 'ocorrencias/42/removed_thumb.webp',
      nome_original: 'removed.jpg',
      tipo_mime: 'image/jpeg',
      miniatura_tipo_mime: 'image/webp',
      tamanho_bytes: 4
    },
    {
      foto_id: keptId,
      arquivo: 'ocorrencias/42/kept.jpg',
      miniatura: 'ocorrencias/42/kept_thumb.webp',
      nome_original: 'kept.jpg',
      tipo_mime: 'image/jpeg',
      miniatura_tipo_mime: 'image/webp',
      tamanho_bytes: 4
    }
  ];
  const sql = createAdminSql(occurrenceRow, photos);
  const objects = new Map(photos.flatMap((photo) =>
    [photo.arquivo, photo.miniatura].map((key) => [key, { body: new Uint8Array([1]) }])
  ));
  const bucket = photoBucket(objects);
  const response = await createWorker(() => sql).fetch(
    multipartEditRequest([], [keptId]),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );
  const feature = await response.json();

  assert.equal(response.status, 200, JSON.stringify({ feature, calls: sql.calls }));
  assert.deepEqual(feature.properties.fotografias.map((photo) => photo.foto_id), [keptId]);
  assert.deepEqual(bucket.deletedKeys.sort(), [photos[0].arquivo, photos[0].miniatura].sort());
  assert.equal(objects.has(photos[1].arquivo), true);
  assert.equal(sql.state.cleanup.length, 0);
});

test('PATCH can remove an individual legacy photo without changing other legacy references', async function () {
  const legacyPhotos = [
    { url: 'https://legacy.example/keep.jpg' },
    { url: 'https://legacy.example/remove.jpg' }
  ];
  const sql = createAdminSql({ ...occurrenceRow, fotografias: legacyPhotos });
  const response = await createWorker(() => sql).fetch(
    multipartEditRequest([], [], [0]),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: photoBucket(new Map()) }
  );
  const feature = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(feature.properties.fotografias, [legacyPhotos[0]]);
  const updateCall = sql.calls.find((call) =>
    call.query.includes('UPDATE public.ocorrencias_trilhas AS occurrence')
  );
  assert.ok(updateCall);
  assert.ok(updateCall.query.includes('jsonb_array_elements_text'));
});

test('PATCH enforces the five-photo cap before uploading new objects', async function () {
  const photos = Array.from({ length: 5 }, (_, index) => ({
    foto_id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    arquivo: `ocorrencias/42/${index}.jpg`,
    miniatura: null,
    nome_original: `${index}.jpg`,
    tipo_mime: 'image/jpeg',
    miniatura_tipo_mime: null,
    tamanho_bytes: 4
  }));
  const sql = createAdminSql(occurrenceRow, photos);
  const bucket = photoBucket(new Map());
  const response = await createWorker(() => sql).fetch(
    multipartEditRequest([jpegFile()], photos.map((photo) => photo.foto_id)),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /no máximo 5/);
  assert.equal(bucket.deletedKeys.length, 0);
  assert.equal(sql.calls.some((call) => /UPDATE public\.ocorrencias_trilhas AS occurrence/.test(call.query)), false);
});

test('PATCH compensates R2 uploads through the cleanup queue when Neon rejects the update', async function () {
  const cleanup = [];
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join('?');
    calls.push({ query, values });
    if (query.includes('FROM public.ocorrencias_trilhas AS o')) {
      return [occurrenceRow];
    }
    if (query.includes('foto_id::text AS foto_id')) {
      return [];
    }
    if (query.includes('SELECT nome') && query.includes('public.trilhas_apabf')) {
      return [{ nome: 'Praia do Rosa' }];
    }
    if (query.includes('WITH selected_trail AS')) {
      throw new Error('Neon unavailable during update');
    }
    if (query.includes('INSERT INTO public.ocorrencias_trilhas_fotografias_cleanup')) {
      const entries = JSON.parse(values[1]);
      entries.forEach((entry, index) => {
        cleanup.push({
          cleanup_id: `cleanup-${index + 1}`,
          ocorrencia_id: '42',
          arquivo: entry.arquivo
        });
      });
      return [];
    }
    if (query.includes('SELECT cleanup_id::text AS cleanup_id')) {
      return cleanup.slice();
    }
    if (query.includes('DELETE FROM public.ocorrencias_trilhas_fotografias_cleanup')) {
      const id = values.find((value) => typeof value === 'string' && value.startsWith('cleanup-'));
      const index = cleanup.findIndex((entry) => entry.cleanup_id === id);
      if (index >= 0) cleanup.splice(index, 1);
      return [];
    }
    if (query.includes('SELECT count(*)::int AS quantidade')) {
      return [{ quantidade: cleanup.length }];
    }
    return [];
  };
  sql.calls = calls;
  const objects = new Map();
  const bucket = photoBucket(objects);
  const response = await createWorker(() => sql).fetch(
    multipartEditRequest([jpegFile()]),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /atualizar a ocorrência/);
  assert.equal(body.arquivos_pendentes, 0);
  assert.equal(objects.size, 0);
  assert.equal(cleanup.length, 0);
  assert.ok(calls.some((call) =>
    call.query.includes('INSERT INTO public.ocorrencias_trilhas_fotografias_cleanup')
  ));
});

test('DELETE cleans occurrences with no photos and with one original photo', async function () {
  const singlePhoto = {
    foto_id: '11111111-1111-4111-8111-111111111111',
    arquivo: 'ocorrencias/42/one.jpg',
    miniatura: null
  };
  for (const photos of [[], [singlePhoto]]) {
    const sql = createAdminSql(occurrenceRow, photos);
    const objects = new Map(photos.map((photo) => [
      photo.arquivo,
      { body: new Uint8Array([1]) }
    ]));
    const response = await createWorker(() => sql).fetch(
      adminRequest('DELETE', '/api/ocorrencias/42'),
      { ...createEnvironment(sql), OCCURRENCE_PHOTOS: photoBucket(objects) }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.limpeza, 'concluida');
    assert.equal(body.arquivos_pendentes, 0);
    assert.equal(objects.size, 0);
  }
});

test('DELETE is idempotent and reports pending R2 cleanup until an authorized retry succeeds', async function () {
  const photos = [
    {
      foto_id: '11111111-1111-4111-8111-111111111111',
      arquivo: 'ocorrencias/42/one.jpg',
      miniatura: 'ocorrencias/42/one_thumb.webp'
    },
    {
      foto_id: '22222222-2222-4222-8222-222222222222',
      arquivo: 'ocorrencias/42/two.jpg',
      miniatura: 'ocorrencias/42/two_thumb.webp'
    }
  ];
  const sql = createAdminSql(occurrenceRow, photos);
  const objects = new Map(photos.flatMap((photo) =>
    [photo.arquivo, photo.miniatura].map((key) => [key, { body: new Uint8Array([1]) }])
  ));
  const bucket = photoBucket(objects, undefined, 2);
  const app = createWorker(() => sql);
  const first = await app.fetch(
    adminRequest('DELETE', '/api/ocorrencias/42'),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );
  const firstBody = await first.json();

  assert.equal(first.status, 202);
  assert.equal(firstBody.deleted, true);
  assert.equal(firstBody.limpeza, 'pendente');
  assert.equal(firstBody.arquivos_pendentes, 1);
  assert.equal(sql.state.exists, false);

  const retry = await app.fetch(
    adminRequest('POST', '/api/ocorrencias/42/limpeza'),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.limpeza, 'concluida');
  assert.equal(retryBody.arquivos_pendentes, 0);
  assert.equal(objects.size, 0);

  const repeatedDelete = await app.fetch(
    adminRequest('DELETE', '/api/ocorrencias/42'),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );
  assert.equal(repeatedDelete.status, 200);
  assert.equal((await repeatedDelete.json()).deleted, true);
});

test('does not report deletion when Neon fails before the occurrence is removed', async function () {
  const sql = createSql((query) => {
    if (query.includes('target AS MATERIALIZED')) {
      throw new Error('Neon unavailable');
    }
    return [];
  });
  const bucket = photoBucket(new Map());
  const response = await createWorker(() => sql).fetch(
    adminRequest('DELETE', '/api/ocorrencias/42'),
    { ...createEnvironment(sql), OCCURRENCE_PHOTOS: bucket }
  );

  assert.equal(response.status, 500);
  assert.equal(bucket.deletedKeys.length, 0);
  assert.ok(sql.calls[0].query.includes('pg_advisory_xact_lock'));
});

test('returns no inserted feature when a trail identifier is absent or ambiguous', async function () {
  const sql = createSql([]);
  const created = await createOccurrence(sql, validateOccurrenceInput(validPayload));

  assert.equal(created, null);
});

test('keeps GET /api/trilhas operational with its existing GeoJSON contract', async function () {
  const trailRows = [{
    fid: 1,
    nome: 'Trilha de teste',
    distance: '1 km',
    municipality: 'Laguna',
    geometry: {
      type: 'MultiLineString',
      coordinates: [[[-49.2, -28.8, 0], [-49.1, -28.7, 1]]]
    }
  }];
  const sql = createSql((query) => query.includes('FROM public.trilhas_apabf')
    ? trailRows
    : []);
  const collection = await getTrails(sql);
  assert.equal(collection.type, 'FeatureCollection');
  const app = createWorker(() => sql);
  const response = await app.fetch(
    new Request('https://api.example.test/api/trilhas', {
      headers: { Origin: APP_ORIGIN }
    }),
    createEnvironment(sql)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.type, 'FeatureCollection');
  assert.equal(body.features[0].properties.fid, 1);
  assert.equal(body.features[0].properties.Nome, 'Trilha de teste');
  assert.equal(body.features[0].geometry.coordinates[0][1].length, 3);
});

test('preserves the existing trail API error response', async function () {
  const app = createWorker(() => async () => {
    throw new Error('database unavailable');
  });
  const response = await app.fetch(
    new Request('https://api.example.test/api/trilhas', {
      headers: { Origin: APP_ORIGIN }
    }),
    createEnvironment(null)
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Não foi possível carregar as trilhas.');
});

test('serves occurrence preflight without changing the trails preflight methods', async function () {
  const occurrenceOptions = await worker.fetch(
    new Request('https://api.example.test/api/ocorrencias', {
      method: 'OPTIONS',
      headers: { Origin: APP_ORIGIN }
    }),
    { APP_ORIGIN }
  );
  const trailOptions = await worker.fetch(
    new Request('https://api.example.test/api/trilhas', {
      method: 'OPTIONS',
      headers: { Origin: APP_ORIGIN }
    }),
    { APP_ORIGIN }
  );
  const adminOptions = await worker.fetch(
    new Request('https://api.example.test/api/ocorrencias/42', {
      method: 'OPTIONS',
      headers: { Origin: APP_ORIGIN }
    }),
    { APP_ORIGIN }
  );

  assert.equal(occurrenceOptions.status, 204);
  assert.equal(occurrenceOptions.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(trailOptions.status, 204);
  assert.equal(trailOptions.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(adminOptions.status, 204);
  assert.equal(
    adminOptions.headers.get('Access-Control-Allow-Methods'),
    'PATCH, DELETE, OPTIONS'
  );
  assert.match(adminOptions.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('rate limits public occurrence writes and rejects origins outside the app', async function () {
  let databaseCreated = false;
  const app = createWorker(() => {
    databaseCreated = true;
    return createSql([]);
  });
  const response = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias', {
      method: 'POST',
      headers: {
        Origin: APP_ORIGIN,
        'CF-Connecting-IP': '192.0.2.10',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(validPayload)
    }),
    {
      ...createEnvironment(null, { limit: async () => ({ success: false }) })
    }
  );
  const blockedOrigin = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias', {
      method: 'GET',
      headers: { Origin: 'https://other.example' }
    }),
    { APP_ORIGIN }
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(blockedOrigin.status, 403);
  assert.equal(databaseCreated, false);
});

test('rejects oversized JSON requests before attempting a database connection', async function () {
  let databaseCreated = false;
  const app = createWorker(() => {
    databaseCreated = true;
    return createSql([]);
  });
  const response = await app.fetch(
    new Request('https://api.example.test/api/ocorrencias', {
      method: 'POST',
      headers: {
        Origin: APP_ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.11'
      },
      body: JSON.stringify({ ...validPayload, descricao: 'x'.repeat(9000) })
    }),
    createEnvironment(null)
  );

  assert.equal(response.status, 413);
  assert.equal(databaseCreated, false);
});
