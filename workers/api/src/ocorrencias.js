import catalog from '../../../dados/catalogo_ocorrencias.json' with { type: 'json' };

const INITIAL_SITUATION = 'pendente_avaliacao';
const MAX_DESCRIPTION_LENGTH = 2000;
const CATEGORY_KEYS = new Set(
  catalog.categorias
    .filter((category) => category.ativo)
    .map((category) => category.chave)
);

export class OccurrenceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OccurrenceInputError';
  }
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateOccurrenceInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OccurrenceInputError('O corpo deve ser um objeto JSON.');
  }

  const trailId = typeof body.trilha_fid === 'number' && Number.isSafeInteger(body.trilha_fid)
    ? String(body.trilha_fid)
    : typeof body.trilha_fid === 'string' && /^[1-9]\d*$/.test(body.trilha_fid)
      ? body.trilha_fid
      : '';
  if (!trailId || Number(trailId) < 1 || Number(trailId) > 2147483647) {
    throw new OccurrenceInputError('Informe uma trilha válida.');
  }

  if (typeof body.categoria !== 'string' || !CATEGORY_KEYS.has(body.categoria)) {
    throw new OccurrenceInputError('Selecione uma categoria válida.');
  }

  if (!isValidDate(body.data_identificacao)) {
    throw new OccurrenceInputError('Informe uma data válida no formato AAAA-MM-DD.');
  }

  if (!Array.isArray(body.coordinates) || body.coordinates.length !== 2
      || !Number.isFinite(body.coordinates[0]) || body.coordinates[0] < -180
      || body.coordinates[0] > 180 || !Number.isFinite(body.coordinates[1])
      || body.coordinates[1] < -90 || body.coordinates[1] > 90) {
    throw new OccurrenceInputError('Informe uma localização válida em longitude e latitude.');
  }

  let description = null;
  if (body.descricao !== undefined && body.descricao !== null) {
    if (typeof body.descricao !== 'string' || body.descricao.length > MAX_DESCRIPTION_LENGTH) {
      throw new OccurrenceInputError(
        `A descrição deve ter no máximo ${MAX_DESCRIPTION_LENGTH} caracteres.`
      );
    }
    description = body.descricao.trim() || null;
  }

  ['fotos', 'fotografias'].forEach((key) => {
    if (Object.hasOwn(body, key)
        && (!Array.isArray(body[key]) || body[key].length > 0)) {
      throw new OccurrenceInputError('O cadastro ainda não aceita fotografias.');
    }
  });

  return {
    trailId,
    category: body.categoria,
    description,
    date: body.data_identificacao,
    longitude: body.coordinates[0],
    latitude: body.coordinates[1]
  };
}

function parseGeometry(value) {
  let geometry = value;
  if (typeof geometry === 'string') {
    try {
      geometry = JSON.parse(geometry);
    } catch {
      throw new Error('A geometria da ocorrência não contém GeoJSON válido.');
    }
  }

  const coordinates = geometry && geometry.coordinates;
  if (!geometry || geometry.type !== 'Point' || !Array.isArray(coordinates)
      || coordinates.length !== 2 || !Number.isFinite(coordinates[0])
      || coordinates[0] < -180 || coordinates[0] > 180
      || !Number.isFinite(coordinates[1]) || coordinates[1] < -90 || coordinates[1] > 90) {
    throw new Error('A ocorrência possui uma geometria Point inválida.');
  }

  return geometry;
}

function parsePhotos(value) {
  let photos = value;
  if (typeof photos === 'string') {
    try {
      photos = JSON.parse(photos);
    } catch {
      throw new Error('Os metadados de fotografias não contêm JSON válido.');
    }
  }
  if (photos === null || photos === undefined) {
    return [];
  }
  if (!Array.isArray(photos)) {
    throw new Error('Os metadados de fotografias devem ser uma lista.');
  }
  return photos;
}

function toFeature(row) {
  return {
    type: 'Feature',
    properties: {
      ocorrencia_id: String(row.ocorrencia_id),
      trilha_fid: row.trilha_fid,
      categoria: row.categoria,
      descricao: row.descricao,
      data_identificacao: row.data_identificacao,
      situacao: row.situacao,
      fotografias: parsePhotos(row.fotografias)
    },
    geometry: parseGeometry(row.geometry)
  };
}

export async function getOccurrences(sql) {
  const rows = await sql`
    SELECT
      o.ocorrencia_id::text AS ocorrencia_id,
      t.fid AS trilha_fid,
      o.categoria,
      o.descricao,
      to_char(o.data_identificacao, 'YYYY-MM-DD') AS data_identificacao,
      o.situacao,
      COALESCE(o.fotos, '[]'::jsonb) AS fotografias,
      ST_AsGeoJSON(o.geom, 15, 0) AS geometry
    FROM public.ocorrencias_trilhas AS o
    JOIN public.trilhas_apabf AS t
      ON t.ogc_fid = o.trilha_ogc_fid
    WHERE o.geom IS NOT NULL
    ORDER BY o.criado_em DESC, o.ocorrencia_id DESC
  `;

  return {
    type: 'FeatureCollection',
    name: 'ocorrencias_trilhas',
    features: rows.map(toFeature)
  };
}

export async function createOccurrence(sql, input) {
  const rows = await sql`
    WITH selected_trail AS (
      SELECT ogc_fid
      FROM public.trilhas_apabf
      WHERE fid::text = ${input.trailId}
      LIMIT 2
    ),
    inserted AS (
      INSERT INTO public.ocorrencias_trilhas (
        trilha_ogc_fid,
        geom,
        categoria,
        descricao,
        data_identificacao,
        situacao
      )
      SELECT
        selected_trail.ogc_fid,
        ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326),
        ${input.category},
        ${input.description},
        ${input.date}::date,
        ${INITIAL_SITUATION}
      FROM selected_trail
      WHERE (SELECT COUNT(*) FROM selected_trail) = 1
      RETURNING
        ocorrencia_id::text AS ocorrencia_id,
        trilha_ogc_fid,
        categoria,
        descricao,
        to_char(data_identificacao, 'YYYY-MM-DD') AS data_identificacao,
        situacao,
        COALESCE(fotos, '[]'::jsonb) AS fotografias,
        ST_AsGeoJSON(geom, 15, 0) AS geometry
    )
    SELECT
      inserted.ocorrencia_id,
      trail.fid AS trilha_fid,
      inserted.categoria,
      inserted.descricao,
      inserted.data_identificacao,
      inserted.situacao,
      inserted.fotografias,
      inserted.geometry
    FROM inserted
    JOIN public.trilhas_apabf AS trail
      ON trail.ogc_fid = inserted.trilha_ogc_fid
  `;

  return rows.length === 1 ? toFeature(rows[0]) : null;
}
