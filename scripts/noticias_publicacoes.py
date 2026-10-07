#!/usr/bin/env python3
"""Collect structured APABF-related feeds, scholarly metadata, and OAI-PMH records."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "noticias-publicacoes.json"
OUTPUT_PATH = ROOT / "dados" / "noticias-publicacoes.json"
USER_AGENT = "APABF-Publicacoes/1.0 (GitHub Actions; metadata-only collector)"
TRACKING_PARAMS = {
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
}
TIMEOUT_SECONDS = 25
OAI_TIMEOUT_SECONDS = 90


def log(message: str) -> None:
    print(f"[{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}] {message}", flush=True)


def normalized_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = value.casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)).strip()


def clean_text(value: str, limit: int = 500) -> str:
    if not value:
        return ""
    value = html.unescape(re.sub(r"<[^>]+>", " ", value))
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) > limit:
        value = value[: limit - 1].rsplit(" ", 1)[0].rstrip() + "…"
    return value


def text_of(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return clean_text(" ".join(element.itertext()))


def find_child(element: ET.Element, local_name: str) -> ET.Element | None:
    for child in element.iter():
        if child.tag.rsplit("}", 1)[-1].casefold() == local_name.casefold():
            return child
    return None


def request_bytes(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: int = TIMEOUT_SECONDS,
) -> bytes:
    request_headers = {"User-Agent": USER_AGENT, "Accept": "application/xml, application/json, text/xml, */*"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
        encoding = response.headers.get("Content-Encoding", "").casefold()
    return decode_content(payload, encoding)


def decode_content(payload: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.decompress(payload)
    if encoding == "deflate":
        try:
            return zlib.decompress(payload)
        except zlib.error:
            return zlib.decompress(payload, -zlib.MAX_WBITS)
    return payload


def fetch_json(url: str) -> dict:
    return json.loads(request_bytes(url, {"Accept": "application/json"}).decode("utf-8"))


def parse_date(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec="seconds")
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        return dt.datetime.strptime(value[:10], "%Y-%m-%d").replace(
            tzinfo=dt.timezone.utc
        ).isoformat(timespec="seconds")
    except ValueError:
        return ""


def normalize_url(value: str) -> str:
    value = html.unescape((value or "").strip())
    if not value:
        return ""
    if value.startswith("//"):
        value = "https:" + value
    parts = urllib.parse.urlsplit(value)
    if parts.scheme.casefold() not in {"http", "https"} or not parts.netloc:
        return ""
    host = parts.netloc.casefold()
    if host.startswith("www."):
        host = host[4:]
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if path != "/":
        path = path.rstrip("/")
    query = []
    for key, val in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        lowered = key.casefold()
        if lowered.startswith("utm_") or lowered in TRACKING_PARAMS:
            continue
        query.append((key, val))
    query.sort()
    return urllib.parse.urlunsplit(("https", host, path, urllib.parse.urlencode(query), ""))


def make_item(
    title: str,
    summary: str,
    url: str,
    source: dict,
    published_at: str = "",
    category: str | None = None,
    guid: str = "",
    doi: str = "",
    keywords: list[str] | None = None,
    authors: list[str] | None = None,
) -> dict | None:
    title = clean_text(title, 300)
    url = normalize_url(url)
    if not title or not url:
        return None
    return {
        "title": title,
        "summary": clean_text(summary, 420),
        "url": url,
        "source": {"name": source["name"], "type": source["type"]},
        "published_at": parse_date(published_at),
        "category": category or source.get("category", "academico"),
        "keywords": sorted({clean_text(term, 80) for term in (keywords or []) if clean_text(term, 80)})[:12],
        "authors": sorted({clean_text(author, 120) for author in (authors or []) if clean_text(author, 120)})[:20],
        "locations": [],
        "relevance": {"level": "baixa", "score": 0, "reason": []},
        "collected_at": "",
        "guid": guid.strip(),
        "doi": doi.strip(),
        "_guid": guid.strip(),
        "_doi": doi.strip(),
    }


def parse_feed(payload: bytes, source: dict) -> list[dict]:
    root = ET.fromstring(payload)
    items = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1].casefold() not in {"item", "entry"}:
            continue
        title = text_of(find_child(node, "title"))
        description = (
            text_of(find_child(node, "description"))
            or text_of(find_child(node, "summary"))
            or text_of(find_child(node, "encoded"))
        )
        link_nodes = [
            child for child in node
            if child.tag.rsplit("}", 1)[-1].casefold() == "link"
        ]
        link_node = next(
            (child for child in link_nodes if child.attrib.get("rel", "").casefold() == "canonical"),
            None,
        )
        link_node = link_node or next(
            (child for child in link_nodes if child.attrib.get("rel", "alternate").casefold() == "alternate"),
            link_nodes[0] if link_nodes else None,
        )
        link = (link_node.attrib.get("href", "") or text_of(link_node)) if link_node is not None else ""
        guid = text_of(find_child(node, "guid")) or text_of(find_child(node, "id"))
        pubdate = (
            text_of(find_child(node, "pubDate"))
            or text_of(find_child(node, "published"))
            or text_of(find_child(node, "updated"))
            or text_of(find_child(node, "date"))
        )
        doi = text_of(find_child(node, "doi"))
        entry = make_item(title, description, link or guid, source, pubdate, guid=guid, doi=doi)
        if entry:
            items.append(entry)
    return items


def phrase_in_text(phrase: str, content: str) -> bool:
    phrase = normalized_text(phrase)
    if not phrase:
        return False
    return re.search(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", content) is not None


def matching_terms(terms: list[str], content: str) -> list[str]:
    return [term for term in terms if phrase_in_text(term, content)]


def find_territorial_matches(content: str, territorial: dict) -> list[dict]:
    candidates = []
    for group, records in territorial.items():
        if not isinstance(records, list):
            continue
        for record in records:
            if not isinstance(record, dict) or not record.get("name"):
                continue
            terms = [record["name"], *record.get("aliases", [])]
            found = matching_terms(terms, content)
            if found:
                candidates.append({
                    "category": group,
                    "name": record["name"],
                    "matched_as": max(found, key=len),
                    "territorial_relation": record.get("territorial_relation", ""),
                    "evidence_level": record.get("evidence_level", ""),
                })
    candidates.sort(key=lambda match: len(normalized_text(match["matched_as"])), reverse=True)
    matches = []
    for candidate in candidates:
        candidate_term = normalized_text(candidate["matched_as"])
        if any(
            phrase_in_text(candidate_term, normalized_text(match["matched_as"]))
            for match in matches
        ):
            continue
        matches.append(candidate)
    return matches


def remove_phrases(content: str, phrases: list[str]) -> str:
    for phrase in sorted(set(phrases), key=len, reverse=True):
        normalized = normalized_text(phrase)
        if normalized:
            content = re.sub(
                r"(?<!\w)" + re.escape(normalized) + r"(?!\w)",
                " ",
                content,
            )
    return re.sub(r"\s+", " ", content).strip()


def classify(item: dict, config: dict) -> bool:
    title = normalized_text(item["title"])
    summary = normalized_text(item["summary"])
    content = f"{title} {summary}"
    points = config["scoring"]
    territorial = config.get("territorial", {})
    territorial_points = territorial.get("scoring", {})
    score = 0
    reasons: list[str] = []
    locations: list[str] = []

    unit_terms = matching_terms(config["unit_terms"], content)
    inside_terms = matching_terms(config["inside_area_phrases"], content)
    municipality_terms = matching_terms(config["municipalities"], content)
    raw_territorial_matches = find_territorial_matches(content, territorial)
    ambiguous_regions = matching_terms(
        territorial.get("ambiguous_region_terms", config.get("other_region_terms", [])),
        content,
    )
    ambiguous_other_region = bool(
        ambiguous_regions
        and not unit_terms
        and not inside_terms
        and not municipality_terms
    )
    territorial_matches = [] if ambiguous_other_region else raw_territorial_matches
    matched_names = [match["matched_as"] for match in territorial_matches]
    topic_content = remove_phrases(content, matched_names)
    environmental_terms = matching_terms(
        territorial.get("environmental_terms", []), topic_content
    )
    nature_terms = matching_terms(
        territorial.get("nature_tourism_terms", []), topic_content
    )
    has_domain_topic = bool(environmental_terms or nature_terms)
    primary_matches = [
        match for match in territorial_matches
        if match["category"] != "referencias_geograficas"
    ]
    reference_matches = [
        match for match in territorial_matches
        if match["category"] == "referencias_geograficas"
    ]

    if unit_terms:
        score += points["unit_in_title_or_summary"]
        reasons.append("APABF ou nome completo da unidade no título/resumo")

    if inside_terms:
        score += points["explicitly_inside_unit"]
        reasons.append("estudo ou atividade explicitamente dentro da APABF")

    locality_terms = matching_terms(config["localities"], content)
    if ambiguous_other_region:
        locality_terms = []
    if locality_terms and (not primary_matches or has_domain_topic):
        score += points["known_locality"]
        locations.extend(locality_terms)
        reasons.append("localidade conhecida: " + ", ".join(locality_terms[:3]))

    if municipality_terms:
        score += points["municipality"]
        locations.extend(municipality_terms)
        reasons.append("município da área da APABF: " + ", ".join(municipality_terms[:3]))

    regional_terms = matching_terms(config["regional_terms"], content)
    has_geographic_evidence = bool(
        unit_terms or inside_terms or locality_terms or municipality_terms
        or regional_terms or territorial_matches
    )
    theme_terms = matching_terms(config["themes"], topic_content)
    directly_relevant_themes = [
        term for term in theme_terms
        if normalized_text(term) not in {
            normalized_text(value) for value in config.get("generic_themes", [])
        }
    ]
    if primary_matches and not has_domain_topic:
        directly_relevant_themes = []
    if has_geographic_evidence and directly_relevant_themes:
        score += points["local_theme"]
        reasons.append("tema relacionado à região: " + ", ".join(directly_relevant_themes[:3]))

    if primary_matches and has_domain_topic:
        names = ", ".join(dict.fromkeys(match["name"] for match in primary_matches))
        if environmental_terms:
            bonus = territorial_points.get("environmental_topic_bonus", 0)
            score += bonus
            reasons.append(
                f"+{bonus} local costeiro com contexto ambiental: {names}; "
                + ", ".join(environmental_terms[:2])
            )
        elif nature_terms:
            bonus = territorial_points.get("nature_tourism_bonus", 0)
            score += bonus
            reasons.append(
                f"+{bonus} local costeiro com turismo de natureza: {names}; "
                + ", ".join(nature_terms[:2])
            )
        locations.extend(match["name"] for match in primary_matches)
    elif reference_matches and has_domain_topic:
        names = ", ".join(dict.fromkeys(match["name"] for match in reference_matches))
        reasons.append(f"referência geográfica auxiliar: {names}")
        locations.extend(match["name"] for match in reference_matches)

    species_terms = matching_terms(config["ecosystems_and_species"], topic_content)
    if species_terms:
        score += points["local_species_or_ecosystem"]
        reasons.append("espécie ou ecossistema local: " + ", ".join(species_terms[:3]))

    if item["source"]["type"] in {"institucional", "academica", "repositorio"} and has_geographic_evidence and directly_relevant_themes:
        score += points["relevant_institution_or_university"]
        reasons.append("fonte institucional ou acadêmica relevante")

    whale_terms = matching_terms(["baleia-franca", "Eubalaena australis"], topic_content)
    if whale_terms and not has_geographic_evidence:
        score += points["isolated_whale_mention"]
        reasons.append("menção isolada a baleia-franca sem relação regional identificada")

    other_regions = matching_terms(config["other_region_terms"], content)
    if other_regions and not has_geographic_evidence:
        score += points["explicitly_other_region"]
        reasons.append("contexto explicitamente de outra região: " + ", ".join(other_regions[:2]))

    item["locations"] = sorted(set(locations))
    item["territorial_matches"] = territorial_matches
    item["relevance"] = {
        "level": (
            "alta" if score >= points["high_threshold"]
            else "media" if score >= points["medium_threshold"]
            else "baixa"
        ),
        "score": score,
        "reason": reasons,
    }
    return score >= points["medium_threshold"]


def abstract_from_openalex(work: dict) -> str:
    inverted = work.get("abstract_inverted_index") or {}
    words: dict[int, str] = {}
    for word, positions in inverted.items():
        for position in positions:
            words[position] = word
    return " ".join(words[index] for index in sorted(words))


def collect_feed(source: dict) -> list[dict]:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            return parse_feed(request_bytes(source["url"]), source)
        except (urllib.error.URLError, TimeoutError, OSError, ET.ParseError, ValueError) as exc:
            last_error = exc
            if attempt < 3:
                log(f"Tentativa {attempt}/3 falhou para {source['name']}: {exc}; tentando novamente")
                time.sleep(attempt)
    if last_error:
        raise last_error
    return []


def collect_openalex(config: dict, api_key: str | None) -> list[dict]:
    items = []
    fields = "id,doi,title,publication_date,abstract_inverted_index,primary_location,authorships,keywords,type"
    for query in config["openalex_queries"]:
        params = {
            "search": query,
            "per-page": str(config["openalex_results_per_query"]),
            "select": fields,
        }
        if api_key:
            params["api_key"] = api_key
        url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
        data = fetch_json(url)
        results = data.get("results", [])
        log(f"OpenAlex consulta '{query}': {len(results)} resultados")
        for work in results:
            location = work.get("primary_location") or {}
            landing = location.get("landing_page_url") or ""
            doi = work.get("doi") or ""
            link = doi or landing or work.get("id", "")
            keywords = [entry.get("display_name", "") for entry in work.get("keywords", [])]
            item = make_item(
                work.get("title", ""),
                abstract_from_openalex(work),
                link,
                {"name": "OpenAlex", "type": "academica", "category": "academico"},
                work.get("publication_date", ""),
                keywords=keywords,
                doi=doi,
                authors=[
                    (authorship.get("author") or {}).get("display_name", "")
                    for authorship in work.get("authorships", [])
                ],
            )
            if item:
                items.append(item)
        time.sleep(0.2)
    return items


def collect_crossref(config: dict) -> list[dict]:
    items = []
    for query in config["crossref_queries"]:
        params = {
            "query.bibliographic": query,
            "rows": str(config["crossref_rows_per_query"]),
            "select": "DOI,title,URL,published,published-print,published-online,created,abstract,subject,type",
        }
        url = "https://api.crossref.org/works?" + urllib.parse.urlencode(params)
        data = fetch_json(url)
        records = data.get("message", {}).get("items", [])
        log(f"Crossref consulta '{query}': {len(records)} resultados")
        for record in records:
            title = (record.get("title") or [""])[0]
            published = record.get("published-print") or record.get("published-online") or record.get("published") or record.get("created") or {}
            date_parts = published.get("date-parts", [[]])[0]
            published_at = "-".join(str(part).zfill(2) if index > 0 else str(part) for index, part in enumerate(date_parts))
            doi = record.get("DOI", "")
            abstract = clean_text(record.get("abstract", ""), 420)
            keywords = record.get("subject", [])
            authors = [
                " ".join(part for part in (author.get("given", ""), author.get("family", "")) if part).strip()
                for author in record.get("author", [])
            ]
            item = make_item(
                title,
                abstract,
                record.get("URL") or (f"https://doi.org/{doi}" if doi else ""),
                {"name": "Crossref", "type": "academica", "category": "academico"},
                published_at,
                keywords=keywords,
                doi=doi,
                authors=authors,
            )
            if item:
                items.append(item)
        time.sleep(1.1)
    return items


def oai_record_to_item(record: ET.Element, repository: dict) -> dict | None:
    metadata = find_child(record, "metadata")
    if metadata is None:
        return None
    fields: dict[str, list[str]] = {}
    for child in metadata.iter():
        name = child.tag.rsplit("}", 1)[-1].casefold()
        if name in {"title", "description", "creator", "subject", "date", "identifier", "type"}:
            value = text_of(child)
            if value:
                fields.setdefault(name, []).append(value)
    title = (fields.get("title") or [""])[0]
    identifier_values = fields.get("identifier", [])
    doi = next((value for value in identifier_values if re.search(r"10\.\d{4,9}/\S+", value)), "")
    link = next((value for value in identifier_values if value.startswith(("http://", "https://"))), "")
    if doi and "doi.org" not in doi.casefold():
        doi = re.search(r"10\.\d{4,9}/\S+", doi).group(0)
    if doi:
        link = "https://doi.org/" + doi.removeprefix("https://doi.org/").removeprefix("http://doi.org/")
    if not link:
        return None
    summary = " ".join(fields.get("description") or [])
    keywords = fields.get("subject", [])
    type_text = " ".join(fields.get("type", [])).casefold()
    category = "pesquisa" if any(word in type_text for word in ("thesis", "dissertation", "tcc", "tese", "dissertação", "trabalho")) else "academico"
    date = next(iter(fields.get("date", [])), "")
    item = make_item(
        title,
        summary,
        link,
        {"name": repository["name"], "type": "repositorio", "category": category},
        date,
        category=category,
        doi=doi,
        keywords=keywords,
        authors=fields.get("creator", []),
    )
    return item


def oai_from_date(config: dict, old_data: dict | None, repository: dict) -> str:
    today = dt.datetime.now(dt.timezone.utc).date()
    source_has_previous_items = any(
        item.get("source", {}).get("name") == repository["name"]
        for item in (old_data or {}).get("items", [])
    )
    if not source_has_previous_items:
        return (today - dt.timedelta(days=config["oai_initial_lookback_days"])).isoformat()
    generated_at = (old_data or {}).get("generated_at", "")
    if generated_at:
        try:
            previous = dt.datetime.fromisoformat(generated_at.replace("Z", "+00:00")).date()
            since = max(
                previous - dt.timedelta(days=config["oai_incremental_lookback_days"]),
                today - dt.timedelta(days=config["oai_initial_lookback_days"]),
            )
            return since.isoformat()
        except ValueError:
            pass
    return (today - dt.timedelta(days=config["oai_initial_lookback_days"])).isoformat()


def collect_oai(config: dict, old_data: dict | None) -> list[dict]:
    items = []
    for repository in config["oai_repositories"]:
        from_date = oai_from_date(config, old_data, repository)
        query = urllib.parse.urlencode({
            "verb": "ListRecords",
            "metadataPrefix": "oai_dc",
            "from": from_date,
        })
        url = repository["url"] + ("&" if "?" in repository["url"] else "?") + query
        records_found = 0
        pages = 0
        complete = False
        while url and pages < config["oai_max_pages_per_repository"]:
            payload = request_bytes(url, timeout=OAI_TIMEOUT_SECONDS)
            root = ET.fromstring(payload)
            error = find_child(root, "error")
            if error is not None:
                if error.attrib.get("code") == "noRecordsMatch":
                    log(f"{repository['name']} OAI-PMH desde {from_date}: nenhum registro alterado no período")
                    return items
                raise RuntimeError(f"OAI-PMH erro {error.attrib.get('code', '')}: {text_of(error)}")
            list_records = find_child(root, "ListRecords")
            if list_records is None:
                raise RuntimeError("resposta OAI-PMH sem ListRecords")
            for record in list_records:
                if record.tag.rsplit("}", 1)[-1] != "record":
                    continue
                records_found += 1
                item = oai_record_to_item(record, repository)
                if item:
                    items.append(item)
            token = find_child(list_records, "resumptionToken")
            token_value = text_of(token) if token is not None else ""
            pages += 1
            if token_value:
                url = repository["url"] + "?" + urllib.parse.urlencode({
                    "verb": "ListRecords",
                    "resumptionToken": token_value,
                })
                time.sleep(1.0)
            else:
                url = ""
                complete = True
        status = "completa" if complete else f"parcial (limite de {config['oai_max_pages_per_repository']} páginas)"
        log(f"{repository['name']} OAI-PMH desde {from_date}: {records_found} registros em {pages} páginas; colheita {status}")
    return items


def dedup_keys(item: dict) -> list[str]:
    keys = []
    doi = item.get("_doi") or item.get("doi", "")
    if doi:
        match = re.search(r"10\.\d{4,9}/\S+", doi, re.IGNORECASE)
        if match:
            keys.append("doi:" + match.group(0).rstrip(".,;").casefold())
    guid = item.get("_guid") or item.get("guid", "")
    if guid:
        keys.append(
            "guid:" + normalized_text(guid)
            if not guid.startswith(("http://", "https://"))
            else "guid:" + normalize_url(guid)
        )
    canonical_url = normalize_url(item.get("url", ""))
    if canonical_url:
        keys.append("url:" + canonical_url)
    if not keys:
        title = normalized_text(item.get("title", ""))
        published = (item.get("published_at", "") or "")[:10]
        keys.append("title-date:" + title + "|" + published)
    return keys


def dedup_key(item: dict) -> str:
    return dedup_keys(item)[0]


def public_item(item: dict, existing_id: str | None = None) -> dict:
    result = {key: value for key, value in item.items() if not key.startswith("_")}
    identity = dedup_key(item)
    result["id"] = existing_id or hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return result


def load_previous() -> dict | None:
    if not OUTPUT_PATH.exists():
        return None
    try:
        with OUTPUT_PATH.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"JSON anterior inválido; não será substituído: {exc}") from exc
    if data.get("schema_version") != 1 or not isinstance(data.get("items"), list):
        raise RuntimeError("JSON anterior não corresponde ao schema_version 1; não será substituído")
    for item in data["items"]:
        item["url"] = normalize_url(item.get("url", ""))
        if not item.get("doi"):
            parts = urllib.parse.urlsplit(item["url"])
            if parts.netloc.casefold() == "doi.org":
                item["doi"] = urllib.parse.unquote(parts.path.lstrip("/"))
    return data


def item_content(item: dict) -> str:
    comparable = dict(item)
    comparable.pop("collected_at", None)
    return json.dumps(comparable, ensure_ascii=False, sort_keys=True)


def items_changed(previous: list[dict], current: list[dict]) -> bool:
    return json.dumps(previous, ensure_ascii=False, sort_keys=True) != json.dumps(
        current, ensure_ascii=False, sort_keys=True
    )


def merge_items(previous: list[dict], new_items: list[dict], now: str) -> tuple[list[dict], int, int]:
    merged: dict[str, dict] = {}
    key_index: dict[str, str] = {}
    duplicates = 0
    for candidate in previous:
        candidate_keys = dedup_keys(candidate)
        key = next((key_index[value] for value in candidate_keys if value in key_index), None)
        if key is not None:
            duplicates += 1
        else:
            key = candidate_keys[0]
            merged[key] = dict(candidate)
        for value in candidate_keys:
            key_index[value] = key
    previous_keys = set(merged)
    for candidate in new_items:
        candidate_keys = dedup_keys(candidate)
        key = next((key_index[value] for value in candidate_keys if value in key_index), None)
        if key is None:
            key = candidate_keys[0]
        public = public_item(candidate, merged.get(key, {}).get("id"))
        if key in merged:
            duplicates += 1
            old = merged[key]
            if item_content(public) == item_content(old):
                public["collected_at"] = old.get("collected_at", now)
            else:
                public["collected_at"] = now
            merged[key] = public
        else:
            public["collected_at"] = now
            merged[key] = public
        for value in candidate_keys:
            key_index[value] = key
    output = list(merged.values())
    output.sort(key=lambda entry: (
        0 if entry.get("relevance", {}).get("level") == "alta" else 1,
        -(entry.get("relevance", {}).get("score", 0)),
        entry.get("published_at") or "",
        entry.get("title", "").casefold(),
    ), reverse=False)
    added = len(set(merged) - previous_keys)
    return output, duplicates, added


def run(mode: str) -> None:
    with CONFIG_PATH.open(encoding="utf-8") as handle:
        config = json.load(handle)
    previous = load_previous()
    old_data = previous or {}
    new_items: list[dict] = []
    source_stats = []
    collected = 0
    discarded = 0

    sources: list[tuple[str, object]] = []
    if mode in {"all", "news"}:
        for feed in config["rss_feeds"]:
            sources.append((feed["name"], lambda feed=feed: collect_feed(feed)))
    if mode in {"all", "academic"}:
        key = os.environ.get("OPENALEX_API_KEY", "").strip()
        sources.extend([
            ("OpenAlex", lambda: collect_openalex(config, key or None)),
            ("Crossref", lambda: collect_crossref(config)),
        ])
        for repository in config["oai_repositories"]:
            sources.append((repository["name"], lambda repository=repository: collect_oai({**config, "oai_repositories": [repository]}, old_data)))

    log(f"Início da execução; modo={mode}; fontes={len(sources)}")
    for name, collector in sources:
        log(f"Consultando fonte: {name}")
        try:
            results = collector()
            source_kept = []
            source_discarded = 0
            for item in results:
                if classify(item, config):
                    source_kept.append(item)
                else:
                    source_discarded += 1
            collected += len(results)
            discarded += source_discarded
            new_items.extend(source_kept)
            source_stats.append((name, len(results), len(source_kept), source_discarded, "OK"))
            log(f"Fonte {name}: encontrados={len(results)}, alta/média={len(source_kept)}, baixa descartada={source_discarded}")
        except (urllib.error.URLError, TimeoutError, OSError, ET.ParseError, json.JSONDecodeError, RuntimeError, ValueError, KeyError) as exc:
            source_stats.append((name, 0, 0, 0, f"FALHA: {exc}"))
            log(f"FALHA na fonte {name}: {exc}; resultados anteriores preservados")
        if name not in {"OpenAlex", "Crossref"}:
            time.sleep(0.25)

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    original_items = json.loads(json.dumps(old_data.get("items", []), ensure_ascii=False))
    old_items = []
    discarded_existing = 0
    for item in old_data.get("items", []):
        if classify(item, config):
            old_items.append(item)
        else:
            discarded_existing += 1
    merged, duplicate_count, added_count = merge_items(old_items, new_items, now)
    high_count = sum(item.get("relevance", {}).get("level") == "alta" for item in merged)
    medium_count = sum(item.get("relevance", {}).get("level") == "media" for item in merged)
    changed = items_changed(original_items, merged)
    output = {
        "schema_version": 1,
        "generated_at": now if changed or not previous else previous.get("generated_at", now),
        "items": merged,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(output, ensure_ascii=False, indent=2) + "\n"
    parsed = json.loads(serialized)
    if parsed.get("schema_version") != 1 or not isinstance(parsed.get("items"), list):
        raise RuntimeError("validação do JSON gerado falhou")
    temporary_path = OUTPUT_PATH.with_suffix(".json.tmp")
    temporary_path.write_text(serialized, encoding="utf-8")
    temporary_path.replace(OUTPUT_PATH)

    log("Resumo por fonte:")
    for name, found, relevant, low, status in source_stats:
        log(f"  {name}: encontrados={found}; relevantes={relevant}; baixa descartada={low}; {status}")
    log(
        f"Totais: encontrados={collected}; descartados_por_relevancia={discarded}; "
        f"duplicados={duplicate_count}; novos={added_count}; alta={high_count}; "
        f"média={medium_count}; antigos_descartados={discarded_existing}; "
        f"total_publicado={len(merged)}; alterado={str(changed).lower()}"
    )
    if not source_stats or all(status.startswith("FALHA") for _, _, _, _, status in source_stats):
        log("Nenhuma fonte respondeu; o JSON anterior foi preservado sem perda de itens.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("all", "news", "academic"), default="all")
    args = parser.parse_args()
    run(args.mode)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log(f"Erro fatal: {exc}")
        sys.exit(1)
