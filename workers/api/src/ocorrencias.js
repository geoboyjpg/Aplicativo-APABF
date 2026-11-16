import catalog from '../../../dados/catalogo_ocorrencias.json' with { type: 'json' };

const INITIAL_SITUATION = 'pendente_avaliacao';
const MAX_DESCRIPTION_LENGTH = 2000;
const CATEGORY_KEYS = new Set(
  catalog.categorias
    .filter((category) => category.ativo)
    .map((category) => category.chave)
);
const SITUATION_KEYS = new Set(catalog.situacoes.map((situation) => situation.chave));

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
      throw new OccurrenceInputError('As fotografias devem ser enviadas como arquivos.');
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

export function validateOccurrenceUpdateInput(body) {
  const input = validateOccurrenceInput(body);
  if (typeof body.situacao !== 'string' || !SITUATION_KEYS.has(body.situacao)) {
    throw new OccurrenceInputError('Selecione uma situação válida.');
  }
  return { ...input, situation: body.situacao };
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

export async function getOccurrences(sql, occurrenceId = null) {
  const rows = await sql`
    SELECT
      o.ocorrencia_id::text AS ocorrencia_id,
      t.fid AS trilha_fid,
      o.categoria,
      o.descricao,
      to_char(o.data_identificacao, 'YYYY-MM-DD') AS data_identificacao,
      o.situacao,
      COALESCE(o.fotos, '[]'::jsonb) || COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'foto_id', f.foto_id::text,
            'gerenciada', true,
            'url', '/api/ocorrencias/' || o.ocorrencia_id::text || '/fotografias/' || f.foto_id::text,
            'miniatura_url', CASE
              WHEN f.miniatura IS NULL THEN NULL
              ELSE '/api/ocorrencias/' || o.ocorrencia_id::text || '/fotografias/' || f.foto_id::text || '/miniatura'
            END
          )
          ORDER BY f.data_upload, f.foto_id
        )
        FROM public.ocorrencias_trilhas_fotografias AS f
        WHERE f.ocorrencia_id = o.ocorrencia_id
      ), '[]'::jsonb) AS fotografias,
      ST_AsGeoJSON(o.geom, 15, 0) AS geometry
    FROM public.ocorrencias_trilhas AS o
    JOIN public.trilhas_apabf AS t
      ON t.ogc_fid = o.trilha_ogc_fid
    WHERE o.geom IS NOT NULL
      AND (${occurrenceId}::text IS NULL OR o.ocorrencia_id::text = ${occurrenceId})
    ORDER BY o.criado_em DESC, o.ocorrencia_id DESC
  `;

  return {
    type: 'FeatureCollection',
    name: 'ocorrencias_trilhas',
    features: rows.map(toFeature)
  };
}

export async function getOccurrencePhotoRecords(sql, occurrenceId) {
  return sql`
    SELECT
      foto_id::text AS foto_id,
      arquivo,
      miniatura,
      nome_original,
      tipo_mime,
      miniatura_tipo_mime,
      tamanho_bytes
    FROM public.ocorrencias_trilhas_fotografias
    WHERE ocorrencia_id::text = ${occurrenceId}
    ORDER BY data_upload, foto_id
  `;
}

export async function getTrailName(sql, trailId) {
  const rows = await sql`
    SELECT nome
    FROM public.trilhas_apabf
    WHERE fid::text = ${trailId}
    LIMIT 2
  `;
  return rows.length === 1 ? rows[0].nome : null;
}

export async function occurrenceExists(sql, occurrenceId) {
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM public.ocorrencias_trilhas
      WHERE ocorrencia_id::text = ${occurrenceId}
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

export async function createOccurrence(sql, input) {
  const rows = await sql`
    WITH selected_trail AS (
      SELECT ogc_fid, nome
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
      trail.nome AS trilha_nome,
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

  return rows.length === 1
    ? { feature: toFeature(rows[0]), trailName: rows[0].trilha_nome }
    : null;
}

export async function updateOccurrence(
  sql,
  occurrenceId,
  input,
  keepPhotoIds,
  keepLegacyPhotoIndexes,
  newPhotos
) {
  const keepIds = JSON.stringify(keepPhotoIds);
  const keepLegacyIndexes = keepLegacyPhotoIndexes === null
    ? null
    : JSON.stringify(keepLegacyPhotoIndexes);
  const newPhotoRecords = JSON.stringify(newPhotos);
  const rows = await sql`
    WITH selected_trail AS (
      SELECT ogc_fid
      FROM public.trilhas_apabf
      WHERE fid::text = ${input.trailId}
      LIMIT 2
    ),
    updated AS (
      UPDATE public.ocorrencias_trilhas AS occurrence
      SET trilha_ogc_fid = selected_trail.ogc_fid,
          geom = ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326),
          categoria = ${input.category},
          descricao = ${input.description},
          data_identificacao = ${input.date}::date,
          situacao = ${input.situation},
          fotos = CASE
            WHEN ${keepLegacyIndexes}::jsonb IS NULL THEN occurrence.fotos
            ELSE COALESCE((
              SELECT jsonb_agg(legacy_photo.value ORDER BY legacy_photo.ordinality)
              FROM jsonb_array_elements(COALESCE(occurrence.fotos, '[]'::jsonb))
                WITH ORDINALITY AS legacy_photo(value, ordinality)
              WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(${keepLegacyIndexes}::jsonb) AS keep(photo_index)
                WHERE keep.photo_index::integer = legacy_photo.ordinality - 1
              )
            ), '[]'::jsonb)
          END
      FROM selected_trail
      WHERE occurrence.ocorrencia_id::text = ${occurrenceId}
        AND (SELECT count(*) FROM selected_trail) = 1
      RETURNING
        occurrence.ocorrencia_id,
        occurrence.trilha_ogc_fid,
        occurrence.categoria,
        occurrence.descricao,
        to_char(occurrence.data_identificacao, 'YYYY-MM-DD') AS data_identificacao,
        occurrence.situacao,
        COALESCE(occurrence.fotos, '[]'::jsonb) AS fotografias,
        ST_AsGeoJSON(occurrence.geom, 15, 0) AS geometry
    ),
    removed_photos AS (
      DELETE FROM public.ocorrencias_trilhas_fotografias AS photo
      USING updated
      WHERE photo.ocorrencia_id = updated.ocorrencia_id
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${keepIds}::jsonb) AS keep(foto_id)
          WHERE keep.foto_id = photo.foto_id::text
        )
      RETURNING photo.ocorrencia_id::text AS ocorrencia_id, photo.arquivo, photo.miniatura
    ),
    queued_cleanup AS (
      INSERT INTO public.ocorrencias_trilhas_fotografias_cleanup (
        ocorrencia_id,
        arquivo
      )
      SELECT removed_photos.ocorrencia_id, object.arquivo
      FROM removed_photos
      CROSS JOIN LATERAL (
        VALUES (removed_photos.arquivo), (removed_photos.miniatura)
      ) AS object(arquivo)
      WHERE object.arquivo IS NOT NULL
      ON CONFLICT (arquivo) DO NOTHING
      RETURNING arquivo
    ),
    cleanup_barrier AS (
      SELECT count(*) FROM queued_cleanup
    ),
    inserted_photos AS (
      INSERT INTO public.ocorrencias_trilhas_fotografias (
        foto_id,
        ocorrencia_id,
        arquivo,
        miniatura,
        miniatura_tipo_mime,
        nome_original,
        tipo_mime,
        tamanho_bytes
      )
      SELECT
        new_photo.foto_id,
        updated.ocorrencia_id,
        new_photo.arquivo,
        new_photo.miniatura,
        new_photo.miniatura_tipo_mime,
        new_photo.nome_original,
        new_photo.tipo_mime,
        new_photo.tamanho_bytes
      FROM updated
      CROSS JOIN cleanup_barrier
      CROSS JOIN jsonb_to_recordset(${newPhotoRecords}::jsonb) AS new_photo(
        foto_id uuid,
        arquivo text,
        miniatura text,
        miniatura_tipo_mime text,
        nome_original text,
        tipo_mime text,
        tamanho_bytes bigint
      )
      RETURNING foto_id
    )
    SELECT
      updated.ocorrencia_id::text AS ocorrencia_id,
      trail.fid AS trilha_fid,
      trail.nome AS trilha_nome,
      updated.categoria,
      updated.descricao,
      updated.data_identificacao,
      updated.situacao,
      updated.fotografias,
      updated.geometry
    FROM updated
    JOIN public.trilhas_apabf AS trail
      ON trail.ogc_fid = updated.trilha_ogc_fid
  `;
  return rows.length === 1 ? rows[0] : null;
}

export async function deleteOccurrence(sql, occurrenceId) {
  const rows = await sql`
    WITH target AS MATERIALIZED (
      SELECT occurrence.ocorrencia_id
      FROM public.ocorrencias_trilhas AS occurrence
      WHERE occurrence.ocorrencia_id::text = ${occurrenceId}
      FOR UPDATE
    ),
    photo_objects AS MATERIALIZED (
      SELECT
        target.ocorrencia_id::text AS ocorrencia_id,
        photo.arquivo
      FROM target
      JOIN public.ocorrencias_trilhas_fotografias AS photo
        ON photo.ocorrencia_id = target.ocorrencia_id
      UNION
      SELECT
        target.ocorrencia_id::text AS ocorrencia_id,
        photo.miniatura AS arquivo
      FROM target
      JOIN public.ocorrencias_trilhas_fotografias AS photo
        ON photo.ocorrencia_id = target.ocorrencia_id
      WHERE photo.miniatura IS NOT NULL
    ),
    queued_cleanup AS (
      INSERT INTO public.ocorrencias_trilhas_fotografias_cleanup (
        ocorrencia_id,
        arquivo
      )
      SELECT ocorrencia_id, arquivo
      FROM photo_objects
      ON CONFLICT (arquivo) DO NOTHING
      RETURNING arquivo
    ),
    cleanup_barrier AS (
      SELECT count(*) FROM queued_cleanup
    ),
    deleted AS (
      DELETE FROM public.ocorrencias_trilhas AS occurrence
      USING target, cleanup_barrier
      WHERE occurrence.ocorrencia_id = target.ocorrencia_id
      RETURNING occurrence.ocorrencia_id::text AS ocorrencia_id
    )
    SELECT ocorrencia_id FROM deleted
  `;
  return rows.length === 1;
}
