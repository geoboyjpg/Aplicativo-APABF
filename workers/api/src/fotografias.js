const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 512 * 1024;

const IMAGE_TYPES = [
  {
    mime: 'image/jpeg',
    extension: 'jpg',
    matches(bytes) {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
  },
  {
    mime: 'image/png',
    extension: 'png',
    matches(bytes) {
      return bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    }
  },
  {
    mime: 'image/webp',
    extension: 'webp',
    matches(bytes) {
      return bytes.length >= 12
        && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    }
  }
];

export class PhotoInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PhotoInputError';
    this.status = status;
  }
}

function identifyImage(bytes) {
  return IMAGE_TYPES.find((type) => type.matches(bytes)) || null;
}

async function validateImage(file, maxBytes, label) {
  if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1 || file.size > maxBytes) {
    throw new PhotoInputError(`${label} deve ter até ${maxBytes === MAX_PHOTO_BYTES ? '5 MB' : '512 KB'}.`, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = identifyImage(bytes);
  if (!type || (file.type && file.type !== type.mime)) {
    throw new PhotoInputError(`${label} deve ser uma imagem JPEG, PNG ou WebP válida.`);
  }
  return { bytes, type };
}

export async function validatePhotoFiles(files, thumbnails) {
  if (!Array.isArray(files) || files.length > MAX_PHOTOS) {
    throw new PhotoInputError('Envie no máximo 5 fotografias.');
  }
  if (!Array.isArray(thumbnails) || (thumbnails.length !== 0 && thumbnails.length !== files.length)) {
    throw new PhotoInputError('As miniaturas enviadas não correspondem às fotografias.');
  }

  const validated = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const image = await validateImage(file, MAX_PHOTO_BYTES, `A fotografia ${index + 1}`);
    const thumbnailFile = thumbnails[index] || null;
    const thumbnail = thumbnailFile
      ? await validateImage(thumbnailFile, MAX_THUMBNAIL_BYTES, `A miniatura ${index + 1}`)
      : null;
    validated.push({ file, image, thumbnail });
  }
  return validated;
}

function safeTrailSlug(name, occurrenceId) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || `trilha-${occurrenceId}`;
}

export function formatUploadTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}_${values.hour}${values.minute}${values.second}`;
}

function photoUrls(occurrenceId, photoId) {
  const base = `/api/ocorrencias/${encodeURIComponent(occurrenceId)}/fotografias/${photoId}`;
  return { url: base, miniatura_url: `${base}/miniatura` };
}

export async function uploadOccurrencePhotoObjects(bucket, occurrenceId, photos, trailName) {
  const storedKeys = [];
  const records = [];
  const slug = safeTrailSlug(trailName, occurrenceId);
  const timestamp = formatUploadTimestamp(new Date());

  try {
    for (const photo of photos) {
      const photoId = crypto.randomUUID();
      const fileStem = `${slug}_${timestamp}_${photoId}`;
      const originalKey = `ocorrencias/${occurrenceId}/${fileStem}.${photo.image.type.extension}`;
      const thumbnailKey = photo.thumbnail
        ? `ocorrencias/${occurrenceId}/${fileStem}_thumb.${photo.thumbnail.type.extension}`
        : null;

      storedKeys.push(originalKey);
      await bucket.put(originalKey, photo.image.bytes, {
        httpMetadata: { contentType: photo.image.type.mime }
      });
      if (thumbnailKey) {
        storedKeys.push(thumbnailKey);
        await bucket.put(thumbnailKey, photo.thumbnail.bytes, {
          httpMetadata: { contentType: photo.thumbnail.type.mime }
        });
      }

      records.push({
        foto_id: photoId,
        arquivo: originalKey,
        miniatura: thumbnailKey,
        miniatura_tipo_mime: photo.thumbnail ? photo.thumbnail.type.mime : null,
        nome_original: String(photo.file.name || 'fotografia')
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .slice(0, 255) || 'fotografia',
        tipo_mime: photo.image.type.mime,
        tamanho_bytes: photo.image.bytes.byteLength
      });
    }
  } catch (error) {
    throw Object.assign(new Error('Não foi possível armazenar as fotografias no R2.'), {
      cause: error,
      storedKeys
    });
  }
  return { records, storedKeys };
}

export async function saveOccurrencePhotos(sql, bucket, occurrenceId, photos, trailName) {
  let uploaded = { records: [], storedKeys: [] };
  try {
    uploaded = await uploadOccurrencePhotoObjects(bucket, occurrenceId, photos, trailName);
    const records = JSON.stringify(uploaded.records);
    await sql`
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
        photo.foto_id,
        ${occurrenceId},
        photo.arquivo,
        photo.miniatura,
        photo.miniatura_tipo_mime,
        photo.nome_original,
        photo.tipo_mime,
        photo.tamanho_bytes
      FROM jsonb_to_recordset(${records}::jsonb) AS photo(
        foto_id uuid,
        arquivo text,
        miniatura text,
        miniatura_tipo_mime text,
        nome_original text,
        tipo_mime text,
        tamanho_bytes bigint
      )
    `;
  } catch (error) {
    const keys = Array.from(new Set(
      uploaded.storedKeys.length ? uploaded.storedKeys : error.storedKeys || []
    ));
    let cleanupQueued = keys.length === 0;
    if (uploaded.records.length) {
      try {
        await enqueuePhotoCleanup(sql, occurrenceId, keys);
        cleanupQueued = true;
      } catch {
        console.error('Não foi possível registrar a compensação das fotografias no Neon.', {
          occurrenceId,
          failedCount: keys.length
        });
      }
    } else {
      const results = await Promise.allSettled(keys.map((key) => bucket.delete(key)));
      const failedKeys = keys.filter((key, index) => results[index].status === 'rejected');
      cleanupQueued = failedKeys.length === 0;
      if (failedKeys.length) {
        try {
          await enqueuePhotoCleanup(sql, occurrenceId, failedKeys);
          cleanupQueued = true;
        } catch {
          console.error('Não foi possível registrar a limpeza pendente das fotografias.', {
            occurrenceId,
            failedCount: failedKeys.length
          });
        }
      }
    }

    if (cleanupQueued) {
      try {
        await sql`
          DELETE FROM public.ocorrencias_trilhas
          WHERE ocorrencia_id::text = ${occurrenceId}
        `;
        if (keys.length) {
          const cleanup = await processPhotoCleanup(sql, bucket, occurrenceId);
          if (cleanup.pendingCount) {
            console.error('A limpeza de fotografias permanece pendente após um envio incompleto.', {
              occurrenceId,
              pendingCount: cleanup.pendingCount
            });
          }
        }
      } catch (cleanupError) {
        console.error('Falha ao compensar um envio incompleto de fotografias.', {
          occurrenceId,
          name: cleanupError instanceof Error ? cleanupError.name : 'UnknownError'
        });
      }
    }
    throw error;
  }

  return uploaded.records.map((photo) => ({
    foto_id: photo.foto_id,
    ...photoUrls(occurrenceId, photo.foto_id)
  }));
}

export async function enqueuePhotoCleanup(sql, occurrenceId, keys) {
  const uniqueKeys = Array.from(new Set(keys.filter((key) => typeof key === 'string' && key)));
  if (!uniqueKeys.length) {
    return;
  }
  const payload = JSON.stringify(uniqueKeys.map((arquivo) => ({ arquivo })));
  await sql`
    INSERT INTO public.ocorrencias_trilhas_fotografias_cleanup (
      ocorrencia_id,
      arquivo
    )
    SELECT ${occurrenceId}, photo.arquivo
    FROM jsonb_to_recordset(${payload}::jsonb) AS photo(arquivo text)
    ON CONFLICT (arquivo) DO NOTHING
  `;
}

export async function processPhotoCleanup(sql, bucket, occurrenceId) {
  const rows = await sql`
    SELECT cleanup_id::text AS cleanup_id, arquivo
    FROM public.ocorrencias_trilhas_fotografias_cleanup AS cleanup
    WHERE cleanup.ocorrencia_id = ${occurrenceId}
      AND NOT EXISTS (
        SELECT 1
        FROM public.ocorrencias_trilhas_fotografias AS photo
        WHERE photo.arquivo = cleanup.arquivo
          OR photo.miniatura = cleanup.arquivo
      )
    ORDER BY cleanup.data_criacao, cleanup.cleanup_id
    LIMIT 50
  `;

  for (const row of rows) {
    try {
      await bucket.delete(row.arquivo);
      await sql`
        DELETE FROM public.ocorrencias_trilhas_fotografias_cleanup
        WHERE cleanup_id::text = ${row.cleanup_id}
      `;
    } catch (error) {
      try {
        await sql`
          UPDATE public.ocorrencias_trilhas_fotografias_cleanup
          SET tentativas = tentativas + 1,
              ultimo_erro = ${error instanceof Error ? error.name : 'StorageError'},
              ultima_tentativa = now()
          WHERE cleanup_id::text = ${row.cleanup_id}
        `;
      } catch {
        console.error('Falha ao registrar uma tentativa de limpeza pendente.', {
          occurrenceId,
          cleanupId: row.cleanup_id
        });
      }
    }
  }

  const pendingRows = await sql`
    SELECT count(*)::int AS quantidade
    FROM public.ocorrencias_trilhas_fotografias_cleanup
    WHERE ocorrencia_id = ${occurrenceId}
  `;
  return {
    pendingCount: Number(pendingRows[0]?.quantidade || 0)
  };
}

export async function getOccurrencePhoto(sql, bucket, occurrenceId, photoId, thumbnail = false) {
  const rows = await sql`
    SELECT
      CASE WHEN ${thumbnail} THEN miniatura ELSE arquivo END AS arquivo,
      CASE WHEN ${thumbnail} THEN miniatura_tipo_mime ELSE tipo_mime END AS tipo_mime
    FROM public.ocorrencias_trilhas_fotografias
    WHERE ocorrencia_id::text = ${occurrenceId}
      AND foto_id::text = ${photoId}
  `;
  if (rows.length !== 1 || !rows[0].arquivo) {
    return null;
  }
  return bucket.get(rows[0].arquivo);
}
