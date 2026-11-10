#!/usr/bin/env python3
"""Export the PMP GeoPackage to a compact map layer and lazy detail files."""

import argparse
import datetime as dt
import json
import sqlite3
import struct
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GPKG = ROOT / "ocorrencias_fauna_2015-2025" / "ocorrencias_fauna_individual_apabf_2015-2025.gpkg"
DEFAULT_OUTPUT = ROOT / "Ocorrencias de Fauna Registradas" / "data"
MAP_FIELDS = (
    "Identificador do indivíduo",
    "Identificador da ocorrência",
    "Instituição executora",
    "Cidade",
    "Trecho",
    "Data/Hora",
    "Data",
    "Ponto - Lat",
    "Ponto - Long",
    "Espécies - Classe",
    "Espécies - Ordem",
    "Espécies - Família",
    "Espécies - Gênero",
    "Espécies - Espécie",
    "OFAI - Espécie do indivíduo",
    "Necropsia - Espécie do indivíduo",
    "Espécie ameaçada",
    "Condição",
    "Condição final",
    "OFAI - Sexo",
    "Necropsia - Sexo",
    "Estágio de desenvolvimento",
    "OFAI - Estágio de desenvolvimento",
    "Nome Popular",
)


def parse_date(value):
    text = str(value or "").strip()
    for date_format in ("%d/%m/%Y %H:%M", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(text, date_format).date()
        except ValueError:
            pass
    return None


def gpkg_point(blob):
    if blob is None:
        return None
    data = bytes(blob)
    if len(data) < 8 or data[:2] != b"GP":
        raise ValueError("Invalid GeoPackage geometry header")

    flags = data[3]
    if flags & 0x10:
        return None
    envelope_size = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get((flags >> 1) & 7)
    if envelope_size is None:
        raise ValueError("Unsupported GeoPackage geometry envelope")
    offset = 8 + envelope_size
    if len(data) < offset + 21:
        raise ValueError("Truncated GeoPackage geometry")

    byte_order = "<" if data[offset] == 1 else ">"
    geometry_type = struct.unpack_from(byte_order + "I", data, offset + 1)[0] % 1000
    if geometry_type != 1:
        return None
    return struct.unpack_from(byte_order + "dd", data, offset + 5)


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def export(gpkg_path, output_dir):
    connection = sqlite3.connect(gpkg_path)
    connection.row_factory = sqlite3.Row
    try:
        layers = connection.execute(
            "SELECT table_name, data_type, srs_id FROM gpkg_contents"
        ).fetchall()
        feature_layers = [layer for layer in layers if layer["data_type"] == "features"]
        if len(feature_layers) != 1:
            raise ValueError(f"Expected one feature layer; found {len(feature_layers)}")
        layer = feature_layers[0]
        if layer["srs_id"] not in (4326, 4674):
            raise ValueError(f"Unsupported map coordinate reference system: EPSG:{layer['srs_id']}")
        table = layer["table_name"]
        geometry = connection.execute(
            "SELECT column_name, geometry_type_name FROM gpkg_geometry_columns "
            "WHERE table_name = ?",
            (table,),
        ).fetchone()
        if not geometry or geometry["geometry_type_name"].upper() != "POINT":
            raise ValueError("Expected a point geometry layer")

        columns = [
            row["name"]
            for row in connection.execute(f'PRAGMA table_info("{table}")')
            if row["name"] not in ("fid", geometry["column_name"])
        ]
        missing_fields = sorted(set(MAP_FIELDS) - set(columns))
        if missing_fields:
            raise ValueError("Required source fields are missing: " + ", ".join(missing_fields))

        detail_fields = columns
        rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
        features = []
        detail_records = defaultdict(dict)
        counters = Counter()
        occurrence_ids = set()
        individual_ids = set()
        year_counts = Counter()
        dates = []

        for row in rows:
            counters["source_records"] += 1
            occurrence_id = str(row["Identificador da ocorrência"] or "").strip()
            individual_id = str(row["Identificador do indivíduo"] or "").strip()
            if occurrence_id:
                counters["duplicate_occurrence_ids"] += occurrence_id in occurrence_ids
                occurrence_ids.add(occurrence_id)
            if individual_id:
                counters["duplicate_individual_ids"] += individual_id in individual_ids
                individual_ids.add(individual_id)

            point = gpkg_point(row[geometry["column_name"]])
            if point is None or not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                counters["discarded_invalid_coordinates"] += 1
                continue
            longitude = row["Ponto - Long"]
            latitude = row["Ponto - Lat"]
            if longitude is None or latitude is None:
                counters["records_missing_coordinate_attributes"] += 1
            elif abs(point[0] - longitude) > 1e-6 or abs(point[1] - latitude) > 1e-6:
                counters["coordinate_attribute_mismatches"] += 1
            if not occurrence_id:
                raise ValueError("A record with valid coordinates has no occurrence identifier")

            record_date = parse_date(row["Data/Hora"]) or parse_date(row["Data"])
            year = str(record_date.year) if record_date else "sem-data"
            year_counts[year] += 1
            if record_date:
                dates.append(record_date)

            properties = {field: row[field] for field in MAP_FIELDS if row[field] is not None}
            properties["__detailsYear"] = year
            # SIRGAS 2000 (EPSG:4674) and WGS 84 are effectively coincident at this map scale.
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": point},
                "properties": properties,
            })
            detail_records[year][occurrence_id] = [row[field] for field in detail_fields]

        if counters["duplicate_occurrence_ids"] or counters["duplicate_individual_ids"]:
            raise ValueError("Duplicate record identifiers prevent safe detail lookup")

        output_dir.mkdir(parents=True, exist_ok=True)
        collection = {
            "type": "FeatureCollection",
            "name": "ocorrencias_fauna_individual_apabf_2015-2025",
            "features": features,
        }
        map_path = output_dir / "ocorrencias-fauna-2015-2025.js"
        map_path.write_text(
            "var json_OcorrnciasdeFaunaindividual_1 = "
            + compact_json(collection)
            + ";\n",
            encoding="utf-8",
        )

        for year, records in detail_records.items():
            detail = {"fields": detail_fields, "records": records}
            detail_path = output_dir / f"fauna-detalhes-{year}.js"
            detail_path.write_text(
                "window.FaunaOccurrenceDetailsData = "
                "window.FaunaOccurrenceDetailsData || Object.create(null);\n"
                f"window.FaunaOccurrenceDetailsData[{json.dumps(year)}] = "
                + compact_json(detail)
                + ";\n",
                encoding="utf-8",
            )

        popular = connection.execute(
            f'SELECT COUNT(*) FROM "{table}" '
            'WHERE "Nome Popular" IS NULL OR TRIM("Nome Popular") = \'\''
        ).fetchone()[0]
        species_missing = connection.execute(
            f'SELECT COUNT(*) FROM "{table}" '
            'WHERE "Espécies - Espécie" IS NULL OR TRIM("Espécies - Espécie") = \'\''
        ).fetchone()[0]
        higher_rank_only = connection.execute(
            f'SELECT COUNT(*) FROM "{table}" '
            'WHERE ("Espécies - Espécie" IS NULL OR TRIM("Espécies - Espécie") = \'\') '
            'AND ("Espécies - Gênero" IS NOT NULL OR "Espécies - Família" IS NOT NULL)'
        ).fetchone()[0]
        distinct_species = connection.execute(
            f'SELECT COUNT(DISTINCT NULLIF(TRIM("Espécies - Espécie"), \'\')) FROM "{table}"'
        ).fetchone()[0]
        distinct_popular = connection.execute(
            f'SELECT COUNT(DISTINCT NULLIF(TRIM("Nome Popular"), \'\')) FROM "{table}"'
        ).fetchone()[0]
        geometry_srs = layer["srs_id"]
        return {
            "gpkg_layers": [
                {"name": item["table_name"], "type": item["data_type"], "srs_id": item["srs_id"]}
                for item in layers
            ],
            "source_records": counters["source_records"],
            "incorporated_records": len(features),
            "discarded_invalid_coordinates": counters["discarded_invalid_coordinates"],
            "records_missing_coordinate_attributes": counters["records_missing_coordinate_attributes"],
            "coordinate_attribute_mismatches": counters["coordinate_attribute_mismatches"],
            "duplicate_occurrence_ids": counters["duplicate_occurrence_ids"],
            "duplicate_individual_ids": counters["duplicate_individual_ids"],
            "records_missing_common_name": popular,
            "records_missing_species": species_missing,
            "records_identified_to_genus_or_family_only": higher_rank_only,
            "distinct_species_names": distinct_species,
            "distinct_common_names": distinct_popular,
            "coordinate_reference_system": geometry_srs,
            "date_range": [min(dates).isoformat(), max(dates).isoformat()] if dates else None,
            "records_by_year": dict(sorted(year_counts.items())),
            "generated_map_file": str(map_path),
            "generated_detail_files": len(detail_records),
        }
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpkg", type=Path, default=DEFAULT_GPKG)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(json.dumps(export(args.gpkg, args.output_dir), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
