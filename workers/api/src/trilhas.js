function parseGeometry(value) {
  let geometry = value;
  if (typeof geometry === 'string') {
    try {
      geometry = JSON.parse(geometry);
    } catch {
      throw new Error('A geometria retornada pelo banco não é um GeoJSON válido.');
    }
  }

  if (!geometry || geometry.type !== 'MultiLineString'
      || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    throw new Error('A trilha não possui uma geometria MultiLineString válida.');
  }

  geometry.coordinates.forEach((line) => {
    if (!Array.isArray(line) || line.length === 0) {
      throw new Error('A geometria contém uma linha vazia.');
    }
    line.forEach((position) => {
      if (!Array.isArray(position) || position.length !== 3
          || !Number.isFinite(position[0]) || position[0] < -180 || position[0] > 180
          || !Number.isFinite(position[1]) || position[1] < -90 || position[1] > 90
          || !Number.isFinite(position[2])) {
        throw new Error('A geometria contém uma coordenada 3D inválida.');
      }
    });
  });

  return geometry;
}

export function toFeatureCollection(rows) {
  return {
    type: 'FeatureCollection',
    name: 'trilhas_apabf',
    features: rows.map((row) => {
      if (row.fid === null || row.fid === undefined) {
        throw new Error('Uma trilha retornada pelo banco não possui fid.');
      }

      return {
        type: 'Feature',
        properties: {
          fid: row.fid,
          Nome: row.nome,
          Distância: row.distance,
          Município: row.municipality
        },
        geometry: parseGeometry(row.geometry)
      };
    })
  };
}

export async function getTrails(sql) {
  const rows = await sql`
    SELECT
      fid,
      nome,
      "distância" AS distance,
      "município" AS municipality,
      ST_AsGeoJSON(wkb_geometry, 15, 0) AS geometry
    FROM public.trilhas_apabf
    ORDER BY ogc_fid
  `;

  return toFeatureCollection(rows);
}
