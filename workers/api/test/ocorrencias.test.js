import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { createWorker } from '../src/index.js';
import {
  createOccurrence,
  getOccurrences,
  validateOccurrenceInput
} from '../src/ocorrencias.js';
import { getTrails } from '../src/trilhas.js';

const APP_ORIGIN = 'https://geoboyjpg.github.io';
const geometry = {
  type: 'Point',
  coordinates: [-49.2, -28.8]
};
const occurrenceRow = {
  ocorrencia_id: '42',
  trilha_fid: 1,
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

function createSql(resultRows) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ query: strings.join('?'), values });
    return typeof resultRows === 'function' ? resultRows(strings.join('?'), values) : resultRows;
  };
  sql.calls = calls;
  return sql;
}

function createEnvironment(sql, limiter = { limit: async () => ({ success: true }) }) {
  return {
    APP_ORIGIN,
    DATABASE_URL: 'test-connection-not-used',
    OCCURRENCE_POST_LIMITER: limiter,
    sql
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

test('inserts with parameters, server-assigned pending status, and database defaults', async function () {
  const sql = createSql([occurrenceRow]);
  const input = validateOccurrenceInput(validPayload);
  const feature = await createOccurrence(sql, input);
  const call = sql.calls[0];

  assert.equal(feature.type, 'Feature');
  assert.equal(feature.properties.situacao, 'pendente_avaliacao');
  assert.match(call.query, /INSERT INTO public\.ocorrencias_trilhas/);
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
    createEnvironment(sql)
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.type, 'Feature');
  assert.equal(body.properties.situacao, 'pendente_avaliacao');
  assert.equal(sql.calls.length, 1);
});

test('returns no inserted feature when a trail identifier is absent or ambiguous', async function () {
  const sql = createSql([]);
  const feature = await createOccurrence(sql, validateOccurrenceInput(validPayload));

  assert.equal(feature, null);
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

  assert.equal(occurrenceOptions.status, 204);
  assert.equal(occurrenceOptions.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(trailOptions.status, 204);
  assert.equal(trailOptions.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
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
