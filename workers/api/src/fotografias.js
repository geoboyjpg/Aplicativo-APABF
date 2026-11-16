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

function photoUrls(occurrenceId, photoId) {
  const base = `/api/ocorrencias/${encodeURIComponent(occurrenceId)}/fotografias/${photoId}`;
  return { url: base, miniatura_url: `${base}/miniatura` };
}

export async function saveOccurrencePhotos(sql, bucket, occurrenceId, photos) {
  const storedKeys = [];
  const records = [];

  try {
    for (const photo of photos) {
      const photoId = crypto.randomUUID();
      const originalKey = `ocorrencias/${occurrenceId}/${photoId}.${photo.image.type.extension}`;
      const thumbnailKey = photo.thumbnail
        ? `ocorrencias/${occurrenceId}/${photoId}-miniatura.${photo.thumbnail.type.extension}`
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
        VALUES (
          ${photoId},
          ${occurrenceId},
          ${originalKey},
          ${thumbnailKey},
          ${photo.thumbnail ? photo.thumbnail.type.mime : null},
          ${String(photo.file.name || 'fotografia').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'fotografia'},
          ${photo.image.type.mime},
          ${photo.image.bytes.byteLength}
        )
      `;
      records.push({ foto_id: photoId, ...photoUrls(occurrenceId, photoId) });
    }
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      ...storedKeys.map((key) => bucket.delete(key)),
      sql`DELETE FROM public.ocorrencias_trilhas WHERE ocorrencia_id::text = ${occurrenceId}`
    ]);
    if (cleanupResults.some((result) => result.status === 'rejected')) {
      console.error('Falha ao compensar um envio incompleto de fotografias.', {
        occurrenceId,
        failedCleanups: cleanupResults.filter((result) => result.status === 'rejected').length
      });
    }
    throw error;
  }

  return records;
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
