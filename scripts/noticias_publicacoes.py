#!/usr/bin/env python3
"""Collect structured APABF-related feeds, scholarly metadata, and OAI-PMH records."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import gzip
import hashlib
import html
import json
import os
import re
import sys
import tempfile
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
DIAGNOSTICS_PATH = ROOT / "diagnosticos" / "coletas"
OAI_STATE_PATH = ROOT / ".github" / "state" / "noticias-oai-continuations.json"
USER_AGENT = "APABF-Publicacoes/1.0 (GitHub Actions; metadata-only collector)"
TRACKING_PARAMS = {
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
}
TIMEOUT_SECONDS = 25
OAI_TIMEOUT_SECONDS = 90
MAX_RETRY_ATTEMPTS = 3
CONTENT_CATEGORIES = {"noticia", "academico", "pesquisa", "institucional"}


def log(message: str) -> None:
    print(f"[{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}] {message}", flush=True)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def safe_error(error: Exception) -> str:
    if isinstance(error, urllib.error.HTTPError):
        return f"HTTP {error.code}"
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        return f"falha de conexão: {type(reason).__name__}"
    if isinstance(error, TimeoutError):
        return "tempo limite excedido"
    if isinstance(error, ET.ParseError):
        return "resposta XML inválida"
    if isinstance(error, json.JSONDecodeError):
        return "resposta JSON inválida"
    return type(error).__name__


def new_source_metric(
    source: str,
    query_id: str,
    query: str,
    limit: int | None = None,
) -> dict:
    return {
        "source": source,
        "query_id": query_id,
        "query": query,
        "attempted_at": utc_now(),
        "request_status": "pending",
        "raw_results": 0,
        "valid_records": 0,
        "accepted": 0,
        "review": 0,
        "discarded": 0,
        "relevance_accepted": 0,
        "relevance_discarded": 0,
        "duplicates": 0,
        "transient_failures": 0,
        "permanent_failures": 0,
        "rate_limit_events": 0,
        "discard_reasons": {},
        "decision_reasons": {},
        "category_metrics": {},
        "category_raw_results": {},
        "pages_consulted": 0,
        "requests_succeeded": 0,
        "results_announced": None,
        "results_retrieved": 0,
        "unique_records": 0,
        "duration_seconds": 0.0,
        "collection_status": "pending",
        "limit": limit,
        "limit_reached": False,
        "attempts": 0,
        "retries": 0,
        "interruption_reason": None,
        "continuation_available": False,
        "resume_possible": False,
        "resume_attempted": False,
        "resume_status": "not_applicable",
        "errors": [],
    }


def add_metric_error(metric: dict, error: Exception) -> None:
    message = safe_error(error)
    if message not in metric["errors"]:
        metric["errors"].append(message)
    if isinstance(error, urllib.error.HTTPError) and error.code == 429:
        metric["rate_limit_events"] += 1


def retry_delay(error: Exception, attempt: int, config: dict) -> float:
    base = max(0.0, float(config.get("retry_base_seconds", 1)))
    cap = max(base, float(config.get("retry_max_seconds", 20)))
    if isinstance(error, urllib.error.HTTPError):
        retry_after = error.headers.get("Retry-After") if error.headers else None
        if retry_after:
            try:
                return min(cap, max(0.0, float(retry_after)))
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(retry_after)
                    return min(cap, max(
                        0.0,
                        (retry_at - dt.datetime.now(retry_at.tzinfo or dt.timezone.utc)).total_seconds(),
                    ))
                except (TypeError, ValueError, OverflowError):
                    pass
    return min(cap, base * (2 ** max(0, attempt - 1)))


def is_retryable(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or 500 <= error.code < 600
    return (
        isinstance(error, (urllib.error.URLError, TimeoutError, OSError))
    )


def fetch_json_with_retries(url: str, metric: dict, config: dict) -> dict:
    max_attempts = max(1, min(
        MAX_RETRY_ATTEMPTS,
        int(config.get("retry_attempts", MAX_RETRY_ATTEMPTS)),
    ))
    for attempt in range(1, max_attempts + 1):
        metric["attempts"] += 1
        try:
            data = fetch_json(url)
            if not isinstance(data, dict):
                raise ValueError("resposta JSON deve ser um objeto")
            metric["requests_succeeded"] += 1
            return data
        except (
            urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            OSError, json.JSONDecodeError, ValueError,
        ) as exc:
            add_metric_error(metric, exc)
            failure_key = "transient_failures" if is_retryable(exc) else "permanent_failures"
            metric[failure_key] += 1
            if not is_retryable(exc) or attempt >= max_attempts:
                raise
            metric["retries"] += 1
            time.sleep(retry_delay(exc, attempt, config))
    raise RuntimeError("tentativas de requisição esgotadas")


def request_bytes_with_retries(
    url: str,
    metric: dict,
    config: dict,
    timeout: int = TIMEOUT_SECONDS,
) -> bytes:
    max_attempts = max(1, min(
        MAX_RETRY_ATTEMPTS,
        int(config.get("retry_attempts", MAX_RETRY_ATTEMPTS)),
    ))
    for attempt in range(1, max_attempts + 1):
        metric["attempts"] += 1
        try:
            payload = request_bytes(url, timeout=timeout)
            metric["requests_succeeded"] += 1
            return payload
        except (
            urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError,
        ) as exc:
            add_metric_error(metric, exc)
            failure_key = "transient_failures" if is_retryable(exc) else "permanent_failures"
            metric[failure_key] += 1
            if not is_retryable(exc) or attempt >= max_attempts:
                raise
            metric["retries"] += 1
            time.sleep(retry_delay(exc, attempt, config))
    raise RuntimeError("tentativas de requisição esgotadas")


def positive_int(config: dict, key: str, default: int, maximum: int | None = None) -> int:
    value = config.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"configuração {key} deve ser inteiro positivo")
    if maximum is not None and value > maximum:
        raise ValueError(f"configuração {key} não pode exceder {maximum}")
    return value


def validate_pagination_config(config: dict) -> None:
    positive_int(config, "retry_attempts", MAX_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS)
    for key, default in (("retry_base_seconds", 1), ("retry_max_seconds", 20)):
        value = config.get(key, default)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            raise ValueError(f"configuração {key} deve ser número não negativo")
    if config.get("retry_max_seconds", 20) < config.get("retry_base_seconds", 1):
        raise ValueError("retry_max_seconds não pode ser menor que retry_base_seconds")
    interval = config.get("request_interval_seconds", 1)
    if not isinstance(interval, (int, float)) or isinstance(interval, bool) or interval < 0:
        raise ValueError("request_interval_seconds deve ser número não negativo")


def record_identity(item: dict) -> str:
    keys = dedup_keys(item)
    return keys[0] if keys else ""


def metric_duration_start() -> float:
    return time.monotonic()


def finish_metric(metric: dict, started_at: float) -> None:
    metric["duration_seconds"] = round(max(0.0, time.monotonic() - started_at), 3)


def count_raw_category(metric: dict | None, category: str) -> None:
    if metric is None:
        return
    category_counts = metric.setdefault("category_raw_results", {})
    category_counts[category] = category_counts.get(category, 0) + 1


def normalized_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = value.casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)).strip()


def category_for_document(
    source: dict,
    default_category: str | None = None,
    document_type: str = "",
) -> str:
    source_type = str(source.get("type") or "").casefold()
    category = default_category or source.get("category")
    separated_type = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(document_type))
    normalized_type = normalized_text(separated_type)

    if source_type in {"academica", "repositorio"}:
        research_document_types = (
            "thesis", "dissertation", "tese", "dissertacao", "monografia",
            "trabalho de conclusao", "technical report", "research report",
            "relatorio tecnico", "relatorio de pesquisa", "relatorio final", "report",
            "relatorio",
        )
        if any(phrase_in_text(term, normalized_type) for term in research_document_types):
            return "pesquisa"

    if category in CONTENT_CATEGORIES:
        return category
    if source_type == "institucional":
        return "institucional"
    if source_type == "noticia":
        return "noticia"
    return "academico"


def category_for_feed_item(source: dict, publisher_url: str = "") -> str:
    host = (urllib.parse.urlsplit(publisher_url).hostname or "").casefold()
    publisher_categories = source.get("publisher_categories", {})
    if isinstance(publisher_categories, dict):
        for domain, category in sorted(
            publisher_categories.items(), key=lambda item: len(item[0]), reverse=True
        ):
            normalized_domain = str(domain).casefold().lstrip(".")
            if (
                category in CONTENT_CATEGORIES
                and host
                and (host == normalized_domain or host.endswith("." + normalized_domain))
            ):
                return category
    return category_for_document(source, source.get("category"))


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
    journal: str = "",
    document_type: str = "",
    publisher: str = "",
    publisher_url: str = "",
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
        "journal": clean_text(journal, 180),
        "document_type": clean_text(document_type, 120),
        "publisher": clean_text(publisher, 120),
        "publisher_url": normalize_url(publisher_url),
        "locations": [],
        "relevance": {"level": "baixa", "score": 0, "reason": []},
        "collected_at": "",
        "guid": guid.strip(),
        "doi": doi.strip(),
        "_guid": guid.strip(),
        "_doi": doi.strip(),
    }


def reclassify_source_categories(items: list[dict], feeds: list[dict]) -> int:
    source_by_name = {
        feed["name"]: feed
        for feed in feeds
        if feed.get("name") and feed.get("category") in CONTENT_CATEGORIES
    }
    changed = 0
    for item in items:
        source = item.get("source") or {}
        feed = source_by_name.get(source.get("name"))
        if feed is None:
            continue
        resolved_type = feed.get("type", source.get("type", ""))
        resolved_category = category_for_feed_item(
            feed,
            item.get("publisher_url", ""),
        )
        item_changed = False
        if source.get("type") != resolved_type:
            source["type"] = resolved_type
            item["source"] = source
            item_changed = True
        if item.get("category") != resolved_category:
            item["category"] = resolved_category
            item_changed = True
        changed += item_changed
    return changed


def parse_feed(payload: bytes, source: dict, metric: dict | None = None) -> list[dict]:
    root = ET.fromstring(payload)
    items = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1].casefold() not in {"item", "entry"}:
            continue
        if metric is not None:
            metric["raw_results"] += 1
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
        publisher_node = find_child(node, "source")
        publisher = text_of(publisher_node)
        publisher_url = normalize_url(
            publisher_node.attrib.get("url", "") if publisher_node is not None else ""
        )
        if publisher_url and any(token in publisher.casefold() for token in ("sans-serif", "{", "}", ";")):
            publisher = urllib.parse.urlsplit(publisher_url).hostname or publisher
            if publisher.startswith("www."):
                publisher = publisher[4:]
        item_category = category_for_feed_item(source, publisher_url)
        count_raw_category(metric, item_category)
        if re.fullmatch(
            r"(?:[\w -]+\s+)?[\w-]+\.(?:png|jpe?g|webp|gif|svg)",
            title,
            re.IGNORECASE,
        ):
            if metric is not None:
                metric["discard_reasons"]["non_article_media_entry"] = (
                    metric["discard_reasons"].get("non_article_media_entry", 0) + 1
                )
            continue
        entry = make_item(
            title,
            description,
            link or guid,
            source,
            pubdate,
            category=item_category,
            guid=guid,
            doi=doi,
            publisher=publisher,
            publisher_url=publisher_url,
        )
        if entry:
            items.append(entry)
        elif metric is not None:
            metric["discard_reasons"]["missing_title_or_valid_url"] = (
                metric["discard_reasons"].get("missing_title_or_valid_url", 0) + 1
            )
    if metric is not None:
        metric["valid_records"] = len(items)
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
    keywords = " ".join(str(value) for value in item.get("keywords", []) if value)
    journal = str(item.get("journal") or "")
    saved_locations = " ".join(str(value) for value in item.get("locations", []) if value)
    content = normalized_text(f"{title} {summary} {keywords} {journal} {saved_locations}")
    excluded_content = matching_terms(
        config.get("classification_validation", {}).get("excluded_content_terms", []),
        content,
    )
    if excluded_content:
        item["relevance"] = {
            "level": "baixa",
            "score": 0,
            "reason": [
                "tipo de comunicado fora do escopo de notícias e publicações: "
                + ", ".join(excluded_content[:3])
            ],
        }
        return False
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

    non_environmental_contexts = matching_terms(
        config.get("classification_validation", {}).get("non_environmental_contexts", []),
        content,
    )
    remaining_after_noise = remove_phrases(content, non_environmental_contexts)
    clear_environmental_evidence = matching_terms(
        territorial.get("environmental_terms", [])
        + config.get("contextual_publication_topics", []),
        remaining_after_noise,
    )
    if non_environmental_contexts and not clear_environmental_evidence:
        score = min(score, points["medium_threshold"] - 1)
        reasons.append(
            "contexto não ambiental desconsiderado: "
            + ", ".join(non_environmental_contexts[:2])
        )

    contextual_topics = matching_terms(
        config.get("contextual_publication_topics", []), topic_content
    )
    contextual_regions = matching_terms(
        config.get("contextual_region_terms", []), content
    )
    academic_source = item.get("source", {}).get("type") in {
        "academica", "repositorio", "institucional"
    }
    complementary = bool(
        academic_source
        and contextual_topics
        and not other_regions
        and not has_geographic_evidence
        and (contextual_regions or matching_terms(
            config.get("distinctive_context_species", []), topic_content
        ))
    )
    if complementary:
        score = max(score, points.get("complementary_threshold", 3))
        reasons.append(
            "contexto científico complementar: "
            + ", ".join((contextual_topics + contextual_regions)[:3])
        )

    item["locations"] = sorted(set(locations))
    item["territorial_matches"] = territorial_matches
    item["relevance"] = {
        "level": (
            "alta" if score >= points["high_threshold"]
            else "media" if score >= points["medium_threshold"]
            else "complementar" if complementary
            else "baixa"
        ),
        "score": score,
        "reason": reasons,
    }
    return score >= points["medium_threshold"] or complementary


def assess_candidate(item: dict, config: dict) -> dict:
    title = str(item.get("title") or "")
    summary = str(item.get("summary") or "")
    keywords = item.get("keywords", [])
    if not isinstance(keywords, list):
        keywords = []
    keyword_text = " ".join(str(value) for value in keywords if value)
    content_fields = {
        "title": title,
        "summary": summary,
        "keywords": keyword_text,
        "journal": str(item.get("journal") or ""),
    }
    content = normalized_text(" ".join(content_fields.values()))
    validation = config.get("classification_validation", {})
    ambiguous_terms = validation.get(
        "ambiguous_activity_terms",
        config.get("generic_themes", []) + ["monitoramento", "visitação"],
    )
    legacy_terms = list(dict.fromkeys(
        config.get("territorial", {}).get("environmental_terms", [])
        + config.get("ecosystems_and_species", [])
        + config.get("themes", [])
        + config.get("contextual_publication_topics", [])
    ))
    title_terms = matching_terms(legacy_terms, normalized_text(title))
    summary_terms = matching_terms(legacy_terms, normalized_text(summary))
    keyword_terms = matching_terms(legacy_terms, normalized_text(keyword_text))
    ambiguous_hits = matching_terms(ambiguous_terms, content)
    non_environmental_contexts = matching_terms(
        validation.get("non_environmental_contexts", []), content
    )

    positive_topics = []
    all_topic_evidence = []
    uncertain_topic_evidence = []
    document_type_matches = []
    for topic_id, topic in validation.get("contextual_topics", {}).items():
        strong_hits = matching_terms(topic.get("strong_terms", []), content)
        support_hits = matching_terms(topic.get("support_terms", []), content)
        document_type_matches.extend(
            matching_terms(topic.get("document_type_terms", []), content)
        )
        supported = bool(strong_hits or len(support_hits) >= 2)
        topic_evidence = {
            "id": topic_id,
            "label": topic.get("label", topic_id),
            "strong_terms": strong_hits,
            "support_terms": support_hits,
        }
        if supported:
            positive_topics.append(topic_evidence)
            all_topic_evidence.extend(strong_hits or support_hits)
        elif support_hits:
            uncertain_topic_evidence.append(topic_evidence)

    thematic_status = (
        "pertinente" if positive_topics
        else "incerta" if ambiguous_hits or uncertain_topic_evidence
        else "nao_evidenciada"
    )
    contextual_publication_hits = matching_terms(
        config.get("contextual_publication_topics", []), content
    )
    if contextual_publication_hits and not positive_topics:
        thematic_status = "pertinente"

    unit_hits = matching_terms(
        config.get("unit_terms", []) + validation.get("unit_aliases", []),
        content,
    )
    inside_hits = matching_terms(config.get("inside_area_phrases", []), content)
    municipality_hits = matching_terms(config.get("municipalities", []), content)
    locality_hits = matching_terms(config.get("localities", []), content)
    regional_term_hits = matching_terms(config.get("regional_terms", []), content)
    other_region_hits = matching_terms(config.get("other_region_terms", []), content)
    catalogue_matches = find_territorial_matches(
        content, config.get("territorial", {})
    )
    confirmed_matches = [
        match for match in catalogue_matches
        if match.get("evidence_level") == "oficial"
        and match.get("territorial_relation") in {"limite_legal", "trecho_confirmado"}
    ]
    regional_matches = [
        match for match in catalogue_matches
        if match.get("territorial_relation") == "associado_regionalmente"
        and match.get("evidence_level") in {"oficial", "secundaria"}
    ]
    direct_territory = bool(unit_hits or inside_hits or confirmed_matches)
    has_territorial_clue = bool(
        municipality_hits or locality_hits or catalogue_matches or regional_term_hits
    )
    if direct_territory:
        territorial_relation = "direta"
    elif regional_matches:
        territorial_relation = "regional"
    elif has_territorial_clue or (other_region_hits and direct_territory):
        territorial_relation = "incerta"
    elif thematic_status == "pertinente" and other_region_hits:
        territorial_relation = "tematica_contextual"
    else:
        territorial_relation = "incerta"

    sparse_metadata = len(content) < 24 or not (title.strip() or summary.strip())
    territory_positive = []
    if unit_hits:
        territory_positive.append("menção explícita à APABF/unidade: " + ", ".join(unit_hits))
    if inside_hits:
        territory_positive.append("expressão explícita de localização dentro da unidade: " + ", ".join(inside_hits))
    if confirmed_matches:
        territory_positive.extend(
            f"{match['name']} consta em catálogo territorial oficial ({match['territorial_relation']})"
            for match in confirmed_matches
        )
    if regional_matches:
        territory_positive.extend(
            f"{match['name']} tem associação regional catalogada"
            for match in regional_matches
        )
    territory_ambiguous = []
    if municipality_hits:
        territory_ambiguous.append(
            "menção municipal não comprova o local do estudo nem interseção com a APABF: "
            + ", ".join(municipality_hits)
        )
    if locality_hits and not (confirmed_matches or regional_matches):
        territory_ambiguous.append(
            "localidade identificada sem evidência territorial suficiente no catálogo: "
            + ", ".join(locality_hits)
        )
    if regional_term_hits:
        territory_ambiguous.append(
            "referência regional ampla não comprova relação espacial com a unidade: "
            + ", ".join(regional_term_hits)
        )
    if other_region_hits and not direct_territory:
        territory_ambiguous.append(
            "o conteúdo menciona outra região; não foi inferida relação direta com a APABF: "
            + ", ".join(other_region_hits)
        )

    topic_negative = []
    if ambiguous_hits and not positive_topics:
        topic_negative.append(
            "termos genéricos sem corroboração temática: " + ", ".join(ambiguous_hits)
        )
    if non_environmental_contexts:
        topic_negative.append(
            "contexto não ambiental identificado: " + ", ".join(non_environmental_contexts)
        )
    if sparse_metadata:
        topic_negative.append("metadados textuais insuficientes para uma avaliação segura")

    evidence = {
        "title": {"matched_terms": title_terms},
        "summary": {"text": summary, "matched_terms": summary_terms},
        "keywords": {"matched_terms": keyword_terms},
        "territory": {
            "unit_terms": unit_hits,
            "inside_area_phrases": inside_hits,
            "localities": locality_hits,
            "municipalities": municipality_hits,
            "catalogue_matches": catalogue_matches,
            "positive": territory_positive,
            "ambiguous": territory_ambiguous,
            "relationship": territorial_relation,
        },
        "topics": {
            "concrete_evidence": list(dict.fromkeys(all_topic_evidence)),
            "contextual_publication_terms": contextual_publication_hits,
            "ambiguous_activity_terms": ambiguous_hits,
            "positive": positive_topics,
            "uncertain": uncertain_topic_evidence,
            "negative_or_ambiguous": topic_negative,
            "non_environmental_contexts": non_environmental_contexts,
            "document_type": list(dict.fromkeys(document_type_matches)),
        },
    }

    if thematic_status == "pertinente" and territorial_relation in {"direta", "regional"}:
        decision = "accepted"
        reasons = [
            "tema contextual corroborado: "
            + ", ".join(topic["label"] for topic in positive_topics),
            "relação territorial sustentada como " + territorial_relation,
        ]
    elif not positive_topics and non_environmental_contexts and not sparse_metadata:
        decision = "discarded"
        reasons = [
            "contexto identificado não demonstra pauta ambiental ou socioambiental",
            "evidência contextual: " + ", ".join(non_environmental_contexts),
        ]
    elif thematic_status == "nao_evidenciada" and not ambiguous_hits and not sparse_metadata:
        decision = "discarded"
        reasons = ["não foram identificadas evidências temáticas socioambientais suficientes"]
    elif sparse_metadata:
        decision = "review"
        reasons = ["metadados insuficientes; a avaliação não infere tema ou território"]
    elif thematic_status == "incerta":
        decision = "review"
        reasons = ["há termos ambíguos sem evidência contextual suficiente"]
    elif territorial_relation in {"incerta", "tematica_contextual"}:
        decision = "review"
        reasons = ["tema pertinente, mas a relação territorial com a APABF não foi comprovada"]
    else:
        decision = "review"
        reasons = ["evidências insuficientes para uma decisão automática"]

    return {
        "decision": decision,
        "thematic_status": thematic_status,
        "territorial_relation": territorial_relation,
        "needs_review": decision == "review",
        "fields_used": [
            field for field, value in content_fields.items() if value.strip()
        ],
        "excluded_metadata": [
            field for field in ("authors", "source", "locations")
            if item.get(field)
        ],
        "reasons": reasons,
        "evidence": evidence,
    }


def abstract_from_openalex(work: dict) -> str:
    inverted = work.get("abstract_inverted_index") or {}
    words: dict[int, str] = {}
    for word, positions in inverted.items():
        for position in positions:
            words[position] = word
    return " ".join(words[index] for index in sorted(words))


def collect_feed(source: dict, metrics: list[dict] | None = None) -> list[dict]:
    started_at = metric_duration_start()
    metric = new_source_metric(source["name"], "rss:feed", source["url"])
    if metrics is not None:
        metrics.append(metric)
    for attempt in range(1, 4):
        metric["attempts"] = attempt
        try:
            payload = request_bytes(source["url"])
            metric["requests_succeeded"] += 1
            metric["pages_consulted"] = 1
            items = parse_feed(payload, source, metric)
            metric["results_retrieved"] = metric["raw_results"]
            metric["unique_records"] = metric["valid_records"]
            metric["request_status"] = "success"
            metric["collection_status"] = "complete"
            finish_metric(metric, started_at)
            for item in items:
                item["_diagnostic_metric_id"] = metric["query_id"]
            return items
        except (urllib.error.URLError, TimeoutError, OSError, ET.ParseError, ValueError) as exc:
            add_metric_error(metric, exc)
            retryable = is_retryable(exc)
            if retryable:
                metric["transient_failures"] += 1
            else:
                metric["permanent_failures"] += 1
            if retryable and attempt < 3:
                metric["retries"] += 1
                log(f"Tentativa {attempt}/3 falhou para {source['name']}: {safe_error(exc)}; tentando novamente")
                time.sleep(attempt)
            elif not retryable:
                break
    metric["request_status"] = "failed"
    metric["collection_status"] = "failed"
    finish_metric(metric, started_at)
    return []


def collect_openalex(
    config: dict,
    api_key: str | None,
    metrics: list[dict] | None = None,
) -> list[dict]:
    items = []
    fields = "id,doi,title,publication_date,abstract_inverted_index,primary_location,authorships,keywords,type"
    options = config.get("pagination", {})
    validate_pagination_config(options)
    page_limit = positive_int(options, "openalex_per_page", 100, maximum=100)
    max_pages = positive_int(options, "openalex_max_pages_per_query", 3)
    max_results = positive_int(
        options, "openalex_max_results_per_query", page_limit * max_pages
    )
    effective_pages = min(max_pages, (max_results + page_limit - 1) // page_limit)
    if effective_pages * page_limit > 10_000 or max_results > 10_000:
        raise ValueError("paginação OpenAlex com page/per-page deve permanecer nos primeiros 10.000 resultados")
    for query_index, query in enumerate(config["openalex_queries"], start=1):
        if query_index > 1:
            time.sleep(max(0.0, float(options.get("request_interval_seconds", 1.0))))
        started_at = metric_duration_start()
        query_id = f"openalex:{query_index:02d}"
        metric = new_source_metric("OpenAlex", query_id, query, max_results)
        if metrics is not None:
            metrics.append(metric)
        params = {
            "search": query,
            "per_page": str(page_limit),
            "select": fields,
            "page": "1",
        }
        if api_key:
            params["api_key"] = api_key
        seen: set[str] = set()
        pages = 0
        total_announced = None
        has_more = True
        while has_more and pages < max_pages and metric["results_retrieved"] < max_results:
            params["page"] = str(pages + 1)
            remaining = max_results - metric["results_retrieved"]
            params["per_page"] = str(min(page_limit, remaining))
            url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
            response_received = False
            try:
                data = fetch_json_with_retries(url, metric, options)
                response_received = True
                results = data.get("results")
                meta = data.get("meta")
                if not isinstance(results, list) or not isinstance(meta, dict):
                    raise ValueError("resposta OpenAlex sem results/meta válidos")
                count = meta.get("count")
                if isinstance(count, int) and count >= 0:
                    total_announced = count
                    metric["results_announced"] = count
                pages += 1
                metric["pages_consulted"] = pages
                metric["raw_results"] += len(results)
                metric["results_retrieved"] += len(results)
                for work in results:
                    work_type = work.get("type", "") if isinstance(work, dict) else ""
                    count_raw_category(
                        metric,
                        category_for_document(
                            {"type": "academica", "category": "academico"},
                            document_type=work_type,
                        ),
                    )
                    if not isinstance(work, dict):
                        metric["discard_reasons"]["invalid_result_shape"] = (
                            metric["discard_reasons"].get("invalid_result_shape", 0) + 1
                        )
                        continue
                    location = work.get("primary_location") or {}
                    landing = location.get("landing_page_url") or ""
                    doi = work.get("doi") or ""
                    link = doi or landing or work.get("id", "")
                    keywords = [
                        entry.get("display_name", "")
                        for entry in work.get("keywords", [])
                        if isinstance(entry, dict)
                    ]
                    primary_source = (location.get("source") or {})
                    item = make_item(
                        work.get("title", ""),
                        abstract_from_openalex(work),
                        link,
                        {"name": "OpenAlex", "type": "academica", "category": "academico"},
                        work.get("publication_date", ""),
                        category=category_for_document(
                            {"type": "academica", "category": "academico"},
                            document_type=work.get("type", ""),
                        ),
                        keywords=keywords,
                        doi=doi,
                        authors=[
                            (authorship.get("author") or {}).get("display_name", "")
                            for authorship in work.get("authorships", [])
                            if isinstance(authorship, dict)
                        ],
                        journal=primary_source.get("display_name", ""),
                        document_type=work.get("type", ""),
                    )
                    if not item:
                        metric["discard_reasons"]["missing_title_or_valid_url"] = (
                            metric["discard_reasons"].get("missing_title_or_valid_url", 0) + 1
                        )
                        continue
                    metric["valid_records"] += 1
                    identity = record_identity(item)
                    if identity in seen:
                        metric["duplicates"] += 1
                        continue
                    seen.add(identity)
                    item["_diagnostic_metric_id"] = query_id
                    items.append(item)
                    metric["unique_records"] += 1
                if total_announced is not None and metric["results_retrieved"] >= total_announced:
                    has_more = False
                elif not results or len(results) < int(params["per_page"]):
                    has_more = False
                    if total_announced is not None and metric["results_retrieved"] < total_announced:
                        metric["interruption_reason"] = "short_page_before_announced_total"
                        metric["resume_status"] = "restart_required"
                        metric["request_status"] = "partial"
                        metric["collection_status"] = "partial"
                else:
                    has_more = total_announced is None or metric["results_retrieved"] < total_announced
                if has_more and pages < max_pages and metric["results_retrieved"] < max_results:
                    time.sleep(max(0.0, float(options.get("request_interval_seconds", 0.2))))
            except (
                urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                OSError, json.JSONDecodeError, ValueError, KeyError, TypeError,
            ) as exc:
                if response_received:
                    add_metric_error(metric, exc)
                    metric["permanent_failures"] += 1
                metric["interruption_reason"] = safe_error(exc)
                metric["resume_status"] = "restart_required"
                metric["request_status"] = "partial" if pages else "failed"
                metric["collection_status"] = "partial" if pages else "failed"
                has_more = False
        limit_hit = bool(
            has_more
            and (
                pages >= max_pages
                or metric["results_retrieved"] >= max_results
            )
        )
        if limit_hit:
            metric["limit_reached"] = True
            metric["interruption_reason"] = (
                "configured_page_limit" if pages >= max_pages else "configured_result_limit"
            )
            metric["continuation_available"] = True
            metric["resume_status"] = "restart_required"
            metric["request_status"] = "partial"
            metric["collection_status"] = "partial"
        elif pages and metric["collection_status"] != "partial":
            metric["request_status"] = "success"
            metric["collection_status"] = "complete"
            metric["resume_status"] = "not_needed"
        elif not pages and metric["collection_status"] == "pending":
            metric["request_status"] = "failed"
            metric["collection_status"] = "failed"
        finish_metric(metric, started_at)
        log(
            f"OpenAlex consulta '{query}': brutos={metric['raw_results']}; "
            f"únicos={metric['unique_records']}; páginas={pages}; "
            f"estado={metric['collection_status']}"
        )
    return items


def collect_crossref(
    config: dict,
    metrics: list[dict] | None = None,
) -> list[dict]:
    items = []
    options = config.get("pagination", {})
    validate_pagination_config(options)
    page_limit = positive_int(options, "crossref_rows_per_page", 100, maximum=1000)
    max_pages = positive_int(options, "crossref_max_pages_per_query", 3)
    max_results = positive_int(
        options, "crossref_max_results_per_query", page_limit * max_pages
    )
    for query_index, query in enumerate(config["crossref_queries"], start=1):
        if query_index > 1:
            time.sleep(max(0.0, float(options.get("request_interval_seconds", 1.0))))
        started_at = metric_duration_start()
        query_id = f"crossref:{query_index:02d}"
        metric = new_source_metric("Crossref", query_id, query, max_results)
        if metrics is not None:
            metrics.append(metric)
        params = {
            "query.bibliographic": query,
            "rows": str(page_limit),
            "select": "DOI,title,URL,published,published-print,published-online,created,abstract,subject,type,author,container-title",
            "cursor": "*",
        }
        seen: set[str] = set()
        pages = 0
        total_announced = None
        has_more = True
        previous_cursor = ""
        while has_more and pages < max_pages and metric["results_retrieved"] < max_results:
            remaining = max_results - metric["results_retrieved"]
            params["rows"] = str(min(page_limit, remaining))
            url = "https://api.crossref.org/works?" + urllib.parse.urlencode(params)
            response_received = False
            try:
                data = fetch_json_with_retries(url, metric, options)
                response_received = True
                message = data.get("message")
                if not isinstance(message, dict) or not isinstance(message.get("items"), list):
                    raise ValueError("resposta Crossref sem message/items válidos")
                records = message["items"]
                count = message.get("total-results")
                if isinstance(count, int) and count >= 0:
                    total_announced = count
                    metric["results_announced"] = count
                pages += 1
                metric["pages_consulted"] = pages
                metric["raw_results"] += len(records)
                metric["results_retrieved"] += len(records)
                for record in records:
                    record_type = record.get("type", "") if isinstance(record, dict) else ""
                    count_raw_category(
                        metric,
                        category_for_document(
                            {"type": "academica", "category": "academico"},
                            document_type=record_type,
                        ),
                    )
                    if not isinstance(record, dict):
                        metric["discard_reasons"]["invalid_result_shape"] = (
                            metric["discard_reasons"].get("invalid_result_shape", 0) + 1
                        )
                        continue
                    title = (record.get("title") or [""])[0]
                    published = (
                        record.get("published-print") or record.get("published-online")
                        or record.get("published") or record.get("created") or {}
                    )
                    date_parts = published.get("date-parts", [[]])[0]
                    published_at = "-".join(
                        str(part).zfill(2) if index > 0 else str(part)
                        for index, part in enumerate(date_parts)
                    )
                    doi = record.get("DOI", "")
                    abstract = clean_text(record.get("abstract", ""), 420)
                    keywords = record.get("subject", [])
                    authors = [
                        " ".join(part for part in (author.get("given", ""), author.get("family", "")) if part).strip()
                        for author in record.get("author", [])
                        if isinstance(author, dict)
                    ]
                    item = make_item(
                        title,
                        abstract,
                        record.get("URL") or (f"https://doi.org/{doi}" if doi else ""),
                        {"name": "Crossref", "type": "academica", "category": "academico"},
                        published_at,
                        category=category_for_document(
                            {"type": "academica", "category": "academico"},
                            document_type=record.get("type", ""),
                        ),
                        keywords=keywords,
                        doi=doi,
                        authors=authors,
                        journal=(record.get("container-title") or [""])[0],
                        document_type=record.get("type", ""),
                    )
                    if not item:
                        metric["discard_reasons"]["missing_title_or_valid_url"] = (
                            metric["discard_reasons"].get("missing_title_or_valid_url", 0) + 1
                        )
                        continue
                    metric["valid_records"] += 1
                    identity = record_identity(item)
                    if identity in seen:
                        metric["duplicates"] += 1
                        continue
                    seen.add(identity)
                    item["_diagnostic_metric_id"] = query_id
                    items.append(item)
                    metric["unique_records"] += 1
                next_cursor = message.get("next-cursor")
                if (
                    not records
                    or len(records) < int(params["rows"])
                    or (
                        total_announced is not None
                        and metric["results_retrieved"] >= total_announced
                    )
                ):
                    has_more = False
                    if total_announced is not None and metric["results_retrieved"] < total_announced:
                        metric["interruption_reason"] = "short_page_before_announced_total"
                        metric["resume_status"] = "restart_required"
                        metric["request_status"] = "partial"
                        metric["collection_status"] = "partial"
                elif isinstance(next_cursor, str) and next_cursor and next_cursor != previous_cursor:
                    previous_cursor = next_cursor
                    params["cursor"] = next_cursor
                    has_more = total_announced is None or metric["results_retrieved"] < total_announced
                elif not isinstance(next_cursor, str) or not next_cursor:
                    has_more = False
                    metric["interruption_reason"] = "missing_cursor_before_announced_total"
                    metric["resume_status"] = "restart_required"
                    metric["request_status"] = "partial"
                    metric["collection_status"] = "partial"
                elif next_cursor == previous_cursor:
                    metric["interruption_reason"] = "repeated_cursor"
                    has_more = True
                    break
                elif total_announced is not None and metric["results_retrieved"] >= total_announced:
                    has_more = False
                else:
                    previous_cursor = next_cursor
                    params["cursor"] = next_cursor
                    has_more = True
                if has_more and pages < max_pages and metric["results_retrieved"] < max_results:
                    time.sleep(max(0.0, float(options.get("request_interval_seconds", 1.0))))
            except (
                urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                OSError, json.JSONDecodeError, ValueError, KeyError, TypeError,
            ) as exc:
                if response_received:
                    add_metric_error(metric, exc)
                    metric["permanent_failures"] += 1
                metric["interruption_reason"] = safe_error(exc)
                metric["resume_status"] = "restart_required"
                metric["request_status"] = "partial" if pages else "failed"
                metric["collection_status"] = "partial" if pages else "failed"
                has_more = False
        stalled = metric["interruption_reason"] == "repeated_cursor"
        limit_hit = bool(
            has_more
            and (
                pages >= max_pages
                or metric["results_retrieved"] >= max_results
            )
        )
        if limit_hit or stalled:
            metric["limit_reached"] = pages >= max_pages or metric["results_retrieved"] >= max_results
            if not metric["interruption_reason"]:
                metric["interruption_reason"] = (
                    "configured_page_limit" if pages >= max_pages else "configured_result_limit"
                )
            metric["continuation_available"] = limit_hit
            metric["resume_status"] = "restart_required"
            metric["request_status"] = "partial"
            metric["collection_status"] = "partial"
        elif pages and metric["collection_status"] != "partial":
            metric["request_status"] = "success"
            metric["collection_status"] = "complete"
            metric["resume_status"] = "not_needed"
        elif not pages and metric["collection_status"] == "pending":
            metric["request_status"] = "failed"
            metric["collection_status"] = "failed"
        finish_metric(metric, started_at)
        log(
            f"Crossref consulta '{query}': brutos={metric['raw_results']}; "
            f"únicos={metric['unique_records']}; páginas={pages}; "
            f"estado={metric['collection_status']}"
        )
    return items


def oai_record_to_item(
    record: ET.Element,
    repository: dict,
    metric: dict | None = None,
) -> dict | None:
    def invalid_record(reason: str) -> None:
        if metric is not None:
            metric["discard_reasons"][reason] = (
                metric["discard_reasons"].get(reason, 0) + 1
            )

    metadata = find_child(record, "metadata")
    if metadata is None:
        count_raw_category(
            metric,
            category_for_document(repository, repository.get("category")),
        )
        invalid_record("missing_metadata")
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
        invalid_record("missing_url")
        return None
    summary = " ".join(fields.get("description") or [])
    keywords = fields.get("subject", [])
    type_text = " ".join(fields.get("type", []))
    category = category_for_document(repository, "academico", type_text)
    count_raw_category(metric, category)
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
        document_type=type_text,
    )
    if metric is not None and item is None:
        metric["discard_reasons"]["missing_title_or_valid_url"] = (
            metric["discard_reasons"].get("missing_title_or_valid_url", 0) + 1
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


def load_oai_state() -> dict:
    if not OAI_STATE_PATH.exists():
        return {"schema_version": 1, "updated_at": utc_now(), "repositories": {}}
    try:
        state = json.loads(OAI_STATE_PATH.read_text(encoding="utf-8"))
        if (
            isinstance(state, dict)
            and state.get("schema_version") == 1
            and isinstance(state.get("repositories"), dict)
        ):
            valid_repositories = {
                state_id: entry
                for state_id, entry in state["repositories"].items()
                if valid_oai_state_entry(state_id, entry)
            }
            if len(valid_repositories) != len(state["repositories"]):
                log("Entradas OAI-PMH inválidas ignoradas; os tokens não serão reutilizados")
            return {
                "schema_version": 1,
                "updated_at": state.get("updated_at", utc_now()),
                "repositories": valid_repositories,
            }
    except (OSError, json.JSONDecodeError):
        pass
    log("Estado OAI-PMH inválido; será reconstruído sem tokens anteriores")
    return {"schema_version": 1, "updated_at": utc_now(), "repositories": {}}


def valid_oai_state_entry(state_id: str, entry: object) -> bool:
    if not isinstance(state_id, str) or not isinstance(entry, dict):
        return False
    name = entry.get("repository_name")
    url = entry.get("repository_url")
    from_date = entry.get("from_date")
    token = entry.get("resumption_token")
    updated_at = entry.get("updated_at")
    try:
        parsed_url = urllib.parse.urlsplit(url)
        dt.date.fromisoformat(from_date)
        updated = dt.datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        expiration = entry.get("expiration_date")
        if expiration is not None:
            dt.datetime.fromisoformat(expiration.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError, OverflowError):
        return False
    return bool(
        name
        and isinstance(name, str)
        and parsed_url.scheme in {"http", "https"}
        and parsed_url.netloc
        and entry.get("metadata_prefix") == "oai_dc"
        and isinstance(token, str)
        and token.strip()
        and updated.tzinfo is not None
        and state_id == oai_repository_state_id({"url": url, "name": name})
    )


def save_oai_state(state: dict) -> None:
    """Atomically replace the validated continuation snapshot.

    A crash before replacement keeps the previous snapshot; a crash after a
    response but before its checkpoint may refetch that page. The workflow
    serializes runs and persists checkpoints after both complete and failed
    collections. A runner lost before its final push can still lose its latest
    local checkpoint, so a later collection must safely restart and deduplicate.
    """
    if (
        not isinstance(state, dict)
        or not isinstance(state.get("repositories"), dict)
        or state.get("schema_version", 1) != 1
        or any(
            not valid_oai_state_entry(state_id, entry)
            for state_id, entry in state["repositories"].items()
        )
    ):
        raise ValueError("estado OAI-PMH inválido; arquivo anterior preservado")
    if not state["repositories"] and not OAI_STATE_PATH.exists():
        return
    state = {
        "schema_version": 1,
        "updated_at": utc_now(),
        "repositories": state["repositories"],
    }
    OAI_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=OAI_STATE_PATH.parent,
            prefix=OAI_STATE_PATH.name + ".",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, OAI_STATE_PATH)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def oai_repository_state_id(repository: dict) -> str:
    return hashlib.sha256(
        (repository["url"].rstrip("/") + "|" + repository["name"]).encode("utf-8")
    ).hexdigest()[:20]


def oai_state_is_fresh(entry: dict, max_age_days: int) -> bool:
    try:
        updated = dt.datetime.fromisoformat(
            entry["updated_at"].replace("Z", "+00:00")
        )
        age = dt.datetime.now(dt.timezone.utc) - updated.astimezone(dt.timezone.utc)
        if age < dt.timedelta(0) or age > dt.timedelta(days=max_age_days):
            return False
        expiration = entry.get("expiration_date")
        if expiration:
            expires = dt.datetime.fromisoformat(expiration.replace("Z", "+00:00"))
            if expires <= dt.datetime.now(dt.timezone.utc):
                return False
        return bool(entry.get("resumption_token"))
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def collect_oai(
    config: dict,
    old_data: dict | None,
    metrics: list[dict] | None = None,
) -> list[dict]:
    items = []
    options = config.get("pagination", {})
    validate_pagination_config(options)
    max_pages = positive_int(config, "oai_max_pages_per_repository", 15)
    retry_config = {
        **options,
        "retry_attempts": options.get("retry_attempts", MAX_RETRY_ATTEMPTS),
    }
    resume_max_age_days = positive_int(options, "oai_resume_max_age_days", 7)
    state = load_oai_state()
    repository_states = state["repositories"]
    for repository in config["oai_repositories"]:
        started_at = metric_duration_start()
        state_id = oai_repository_state_id(repository)
        pending_state = repository_states.get(state_id)
        same_query_state = (
            isinstance(pending_state, dict)
            and pending_state.get("repository_url") == repository["url"]
            and pending_state.get("metadata_prefix") == "oai_dc"
        )
        has_pending = (
            same_query_state
            and oai_state_is_fresh(pending_state, resume_max_age_days)
        )
        if same_query_state and not has_pending:
            repository_states.pop(state_id, None)
            resume_status = "expired_or_invalid_restart"
        else:
            resume_status = "resumed" if has_pending else "not_needed"
        from_date = (
            pending_state["from_date"]
            if same_query_state and pending_state.get("from_date")
            else oai_from_date(config, old_data, repository)
        )
        query_id = "oai:" + normalized_text(repository["name"]).replace(" ", "-")
        metric = new_source_metric(
            repository["name"],
            query_id,
            f"ListRecords metadataPrefix=oai_dc from={from_date}",
            max_pages,
        )
        if metrics is not None:
            metrics.append(metric)
        metric["resume_attempted"] = has_pending
        metric["resume_status"] = resume_status
        params: dict[str, str] = {
            "verb": "ListRecords",
            "metadataPrefix": "oai_dc",
            "from": from_date,
        }
        if has_pending:
            params = {
                "verb": "ListRecords",
                "resumptionToken": pending_state["resumption_token"],
            }
        base_url = repository["url"] + ("&" if "?" in repository["url"] else "?")
        url = base_url + urllib.parse.urlencode(params)
        pages = 0
        complete = False
        token_available = bool(has_pending)
        resumed = has_pending
        restart_after_invalid_token = False
        seen: set[str] = set()
        while url and pages < max_pages:
            response_received = False
            try:
                payload = request_bytes_with_retries(
                    url, metric, retry_config, timeout=OAI_TIMEOUT_SECONDS
                )
                response_received = True
                root = ET.fromstring(payload)
                error = find_child(root, "error")
                if error is not None:
                    if error.attrib.get("code") == "noRecordsMatch":
                        pages += 1
                        metric["pages_consulted"] = pages
                        complete = True
                        url = ""
                        break
                    if (
                        error.attrib.get("code") == "badResumptionToken"
                        and resumed
                        and not restart_after_invalid_token
                    ):
                        repository_states.pop(state_id, None)
                        save_oai_state(state)
                        metric["resume_status"] = "invalid_token_restart"
                        metric["restart_count"] = metric.get("restart_count", 0) + 1
                        params = {
                            "verb": "ListRecords",
                            "metadataPrefix": "oai_dc",
                            "from": from_date,
                        }
                        url = base_url + urllib.parse.urlencode(params)
                        resumed = False
                        restart_after_invalid_token = True
                        continue
                    raise RuntimeError(
                        f"OAI-PMH erro {error.attrib.get('code', '')}"
                    )
                list_records = find_child(root, "ListRecords")
                if list_records is None:
                    raise RuntimeError("resposta OAI-PMH sem ListRecords")
                pages += 1
                metric["pages_consulted"] = pages
                for record in list_records:
                    if record.tag.rsplit("}", 1)[-1] != "record":
                        continue
                    metric["raw_results"] += 1
                    item = oai_record_to_item(record, repository, metric)
                    if item:
                        metric["valid_records"] += 1
                        identity = record_identity(item)
                        if identity in seen:
                            metric["duplicates"] += 1
                            continue
                        seen.add(identity)
                        item["_diagnostic_metric_id"] = query_id
                        items.append(item)
                        metric["unique_records"] += 1
                token = find_child(list_records, "resumptionToken")
                token_value = (
                    "".join(token.itertext()).strip()
                    if token is not None
                    else ""
                )
                if token_value:
                    token_available = True
                    complete_list_size = token.attrib.get("completeListSize") if token is not None else None
                    if complete_list_size and complete_list_size.isdigit():
                        metric["results_announced"] = int(complete_list_size)
                    expiration_date = token.attrib.get("expirationDate") if token is not None else None
                    next_state = {
                        "repository_name": repository["name"],
                        "repository_url": repository["url"],
                        "metadata_prefix": "oai_dc",
                        "from_date": from_date,
                        "resumption_token": token_value,
                        "expiration_date": expiration_date,
                        "updated_at": utc_now(),
                    }
                    repository_states[state_id] = next_state
                    save_oai_state(state)
                    params = {
                        "verb": "ListRecords",
                        "resumptionToken": token_value,
                    }
                    url = base_url + urllib.parse.urlencode(params)
                    if pages < max_pages:
                        time.sleep(max(
                            0.0,
                            float(options.get("request_interval_seconds", 1.0)),
                        ))
                else:
                    url = ""
                    complete = True
                    repository_states.pop(state_id, None)
            except (
                urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                OSError, ET.ParseError, RuntimeError, ValueError, TypeError,
            ) as exc:
                if response_received:
                    add_metric_error(metric, exc)
                    metric["permanent_failures"] += 1
                metric["interruption_reason"] = safe_error(exc)
                url = ""
        limit_hit = bool(url and pages >= max_pages)
        metric["continuation_available"] = token_available and state_id in repository_states
        metric["resume_possible"] = metric["continuation_available"]
        metric["limit_reached"] = limit_hit
        if limit_hit:
            metric["request_status"] = "partial"
            metric["collection_status"] = "partial"
            metric["interruption_reason"] = "configured_page_limit"
            metric["resume_status"] = "continuation_saved"
        elif complete:
            metric["request_status"] = "success"
            metric["collection_status"] = "complete"
            metric["resume_status"] = "completed"
        elif metric["errors"]:
            metric["request_status"] = "partial" if pages else "failed"
            metric["collection_status"] = "partial" if pages else "failed"
            metric["resume_status"] = (
                "continuation_saved"
                if metric["resume_possible"]
                else "restart_required"
            )
        else:
            metric["request_status"] = "failed"
            metric["collection_status"] = "failed"
            metric["interruption_reason"] = "no_progress"
        metric["results_retrieved"] = metric["raw_results"]
        finish_metric(metric, started_at)
        log(
            f"{repository['name']} OAI-PMH desde {from_date}: "
            f"brutos={metric['raw_results']}; páginas={pages}; "
            f"estado={metric['collection_status']}; retomável={metric['resume_possible']}"
        )
    save_oai_state(state)
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
    if (
        not doi
        and item.get("category") in {"noticia", "institucional"}
        and item.get("published_at")
        and item.get("summary")
        and item.get("title")
    ):
        story_signature = "|".join((
            normalized_text(item["title"]),
            str(item["published_at"])[:10],
            normalized_text(item["summary"]),
        ))
        keys.append(
            "story:" + hashlib.sha256(story_signature.encode("utf-8")).hexdigest()
        )
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


def merge_items(
    previous: list[dict],
    new_items: list[dict],
    now: str,
    preserve_existing_duplicates: bool = False,
) -> tuple[list[dict], int, int]:
    merged: dict[str, dict] = {}
    key_index: dict[str, str] = {}
    preserved_previous_duplicates: list[dict] = []
    duplicates = 0
    for candidate in previous:
        candidate_keys = dedup_keys(candidate)
        key = next((key_index[value] for value in candidate_keys if value in key_index), None)
        if key is not None:
            duplicates += 1
            preserved_previous_duplicates.append(dict(candidate))
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
            sources = list(dict.fromkeys(
                (old.get("sources") or [old.get("source", {}).get("name")])
                + [candidate.get("source", {}).get("name")]
            ))
            sources = [source for source in sources if source]
            if preserve_existing_duplicates:
                old["sources"] = sources
                merged[key] = old
            else:
                combined = dict(old)
                for field, value in public.items():
                    if value not in (None, "", [], {}):
                        combined[field] = value
                for field in ("authors", "keywords", "locations"):
                    combined[field] = list(dict.fromkeys(
                        (old.get(field) or []) + (public.get(field) or [])
                    ))
                if len(public.get("summary") or "") < len(old.get("summary") or ""):
                    combined["summary"] = old.get("summary", "")
                if (old.get("relevance", {}).get("score", 0)
                        > public.get("relevance", {}).get("score", 0)):
                    combined["relevance"] = old["relevance"]
                combined["id"] = old.get("id", public["id"])
                combined["source"] = old.get("source", public.get("source", {}))
                combined["sources"] = sources
                combined["collected_at"] = (
                    old.get("collected_at", now)
                    if item_content(public) == item_content(old)
                    else now
                )
                merged[key] = combined
        else:
            public["collected_at"] = now
            merged[key] = public
        for value in candidate_keys:
            key_index[value] = key
    output = [*merged.values(), *preserved_previous_duplicates]
    output.sort(key=lambda entry: (
        0 if entry.get("relevance", {}).get("level") == "alta" else 1,
        -(entry.get("relevance", {}).get("score", 0)),
        entry.get("published_at") or "",
        entry.get("title", "").casefold(),
    ), reverse=False)
    added = len(set(merged) - previous_keys)
    return output, duplicates, added


def write_diagnostics(report: dict, prefix: str = "coleta") -> Path:
    DIAGNOSTICS_PATH.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    workflow_run = os.environ.get("GITHUB_RUN_ID", "").strip()
    run_segment = f"-{workflow_run}" if workflow_run else ""
    path = DIAGNOSTICS_PATH / f"{prefix}{run_segment}-{timestamp}.json"
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def evaluate_existing(config: dict, items: list[dict]) -> dict:
    evaluations = []
    topic_distribution: dict[str, int] = {}
    territorial_distribution = {
        relation: 0
        for relation in ("direta", "regional", "tematica_contextual", "incerta")
    }
    agreements = 0
    divergences = 0
    unresolved = 0
    possible_false_positives = []
    possible_false_negatives = []
    review_candidates = []

    for item in items:
        evaluation = assess_candidate(item, config)
        legacy_accepted = classify(copy.deepcopy(item), config)
        diagnostic_accepted = evaluation["decision"] == "accepted"
        is_review = evaluation["decision"] == "review"
        if is_review:
            unresolved += 1
        elif legacy_accepted == diagnostic_accepted:
            agreements += 1
        else:
            divergences += 1

        record = {
            "id": item.get("id"),
            "url": item.get("url"),
            "category": item.get("category"),
            "source": item.get("source", {}).get("name"),
            "published_at": item.get("published_at"),
            "title": item.get("title", ""),
            "summary": item.get("summary", ""),
            "current_filter": "accepted" if legacy_accepted else "discarded",
            "stored_relevance": item.get("relevance", {}).get("level"),
            **evaluation,
        }
        evaluations.append(record)
        territorial_distribution[evaluation["territorial_relation"]] = (
            territorial_distribution.get(evaluation["territorial_relation"], 0) + 1
        )
        for topic in evaluation["evidence"]["topics"]["positive"]:
            topic_id = topic["id"]
            topic_distribution[topic_id] = topic_distribution.get(topic_id, 0) + 1
        reference = {
            "id": record["id"],
            "title": record["title"],
            "current_filter": record["current_filter"],
            "diagnostic": evaluation["decision"],
            "reasons": evaluation["reasons"],
        }
        if legacy_accepted and evaluation["decision"] == "discarded":
            possible_false_positives.append(reference)
        elif not legacy_accepted and evaluation["decision"] == "accepted":
            possible_false_negatives.append(reference)
        if is_review:
            review_candidates.append(reference)

    def examples(records: list[dict]) -> list[dict]:
        return records[:5]

    return {
        "schema_version": 2,
        "evaluated_at": utc_now(),
        "mode": "contextual-evaluation-only",
        "total": len(evaluations),
        "comparison": {
            "legacy_accepted": sum(
                record["current_filter"] == "accepted" for record in evaluations
            ),
            "legacy_discarded": sum(
                record["current_filter"] == "discarded" for record in evaluations
            ),
            "agreements": agreements,
            "definite_divergences": divergences,
            "diagnostic_review": unresolved,
            "possible_false_positives": {
                "count": len(possible_false_positives),
                "examples": examples(possible_false_positives),
            },
            "possible_false_negatives": {
                "count": len(possible_false_negatives),
                "examples": examples(possible_false_negatives),
            },
            "review_candidates": {
                "count": len(review_candidates),
                "examples": examples(review_candidates),
            },
            "interpretation": (
                "Divergências e candidatos à revisão são hipóteses para validação humana, "
                "não erros confirmados."
            ),
        },
        "decisions": {
            decision: sum(record["decision"] == decision for record in evaluations)
            for decision in ("accepted", "review", "discarded")
        },
        "topic_distribution": topic_distribution,
        "territorial_distribution": territorial_distribution,
        "items": evaluations,
    }


def run(mode: str) -> str:
    with CONFIG_PATH.open(encoding="utf-8") as handle:
        config = json.load(handle)
    previous = load_previous()
    old_data = previous or {}
    if previous:
        reclassify_source_categories(
            old_data.get("items", []),
            config.get("rss_feeds", []),
        )
    new_items: list[dict] = []
    publishable_items: list[dict] = []
    partial_candidates = 0
    source_metrics: list[dict] = []
    category_candidate_ids: dict[str, set[str]] = {}
    metric_category_ids: dict[int, dict[str, set[str]]] = {}
    metric_approved_ids: dict[int, dict[str, set[str]]] = {}
    metric_duplicate_counts: dict[int, dict[str, int]] = {}

    sources: list[tuple[str, object]] = []
    if mode in {"all", "news"}:
        for feed in config["rss_feeds"]:
            sources.append((
                feed["name"],
                lambda metrics, feed=feed: collect_feed(feed, metrics),
            ))
    if mode in {"all", "academic"}:
        key = os.environ.get("OPENALEX_API_KEY", "").strip()
        sources.extend([
            ("OpenAlex", lambda metrics: collect_openalex(config, key or None, metrics)),
            ("Crossref", lambda metrics: collect_crossref(config, metrics)),
        ])
        for repository in config["oai_repositories"]:
            sources.append((
                repository["name"],
                lambda metrics, repository=repository: collect_oai(
                    {**config, "oai_repositories": [repository]},
                    old_data,
                    metrics,
                ),
            ))

    log(f"Início da execução; modo={mode}; fontes={len(sources)}")
    for name, collector in sources:
        log(f"Consultando fonte: {name}")
        metrics: list[dict] = []
        try:
            results = collector(metrics)
            for item in results:
                metric = next(
                    (
                        row for row in metrics
                        if row["query_id"] == item.get("_diagnostic_metric_id")
                    ),
                    metrics[0] if len(metrics) == 1 else None,
                )
                item_category = item.get("category")
                if item_category not in CONTENT_CATEGORIES:
                    item_category = category_for_document(item.get("source") or {})
                    item["category"] = item_category
                identity = record_identity(item)
                category_candidate_ids.setdefault(item_category, set()).add(identity)
                if metric is not None:
                    category_metrics = metric["category_metrics"].setdefault(
                        item_category,
                        {
                            "collected_candidates": 0,
                            "approved_candidates": 0,
                            "discarded_candidates": 0,
                            "unique_records": 0,
                            "published_records": 0,
                        },
                    )
                    category_metrics["collected_candidates"] += 1
                    metric_category_ids.setdefault(id(metric), {}).setdefault(
                        item_category, set()
                    ).add(identity)
                    evaluation = assess_candidate(item, config)
                    metric[evaluation["decision"]] += 1
                    for reason in evaluation["reasons"]:
                        metric["decision_reasons"][reason] = (
                            metric["decision_reasons"].get(reason, 0) + 1
                        )
                    item["_contextual_evaluation"] = evaluation
                if classify(item, config):
                    if metric is not None:
                        metric["relevance_accepted"] += 1
                        category_metrics["approved_candidates"] += 1
                        metric_approved_ids.setdefault(id(metric), {}).setdefault(
                            item_category, set()
                        ).add(identity)
                    new_items.append(item)
                    if metric is None or metric["pages_consulted"] > 0:
                        publishable_items.append(item)
                    else:
                        partial_candidates += 1
                elif metric is not None:
                    metric["relevance_discarded"] += 1
                    category_metrics["discarded_candidates"] += 1
                    reasons = item.get("relevance", {}).get("reason", [])
                    reason = "; ".join(reasons) or "abaixo do limiar atual de relevância"
                    metric["discard_reasons"][reason] = (
                        metric["discard_reasons"].get(reason, 0) + 1
                    )
            if not metrics:
                failed_metric = new_source_metric(name, "source", "execução da fonte")
                failed_metric["request_status"] = "failed"
                failed_metric["collection_status"] = "failed"
                failed_metric["errors"].append("coletor não produziu métricas")
                metrics.append(failed_metric)
            source_metrics.extend(metrics)
            status = ", ".join(sorted({metric["collection_status"] for metric in metrics}))
            log(f"Fonte {name}: status={status or 'falha'}; candidatos={len(results)}")
        except (
            urllib.error.URLError, TimeoutError, OSError, ET.ParseError,
            json.JSONDecodeError, RuntimeError, ValueError, KeyError,
        ) as exc:
            if not metrics:
                metrics.append(new_source_metric(name, "source", "execução da fonte"))
            add_metric_error(metrics[0], exc)
            metrics[0]["request_status"] = "failed"
            metrics[0]["collection_status"] = "failed"
            source_metrics.extend(metrics)
            log(f"FALHA na fonte {name}: {safe_error(exc)}; resultados anteriores preservados")
        if name not in {"OpenAlex", "Crossref"}:
            time.sleep(0.25)

    now = utc_now()
    original_items = json.loads(json.dumps(old_data.get("items", []), ensure_ascii=False))
    successful_metrics = [
        metric for metric in source_metrics
        if metric["request_status"] == "success"
        or (metric["request_status"] == "partial" and metric["pages_consulted"] > 0)
    ]
    failed_metrics = [
        metric for metric in source_metrics
        if metric["request_status"] in {"failed", "partial"}
        or metric["collection_status"] == "partial"
    ]
    if not successful_metrics:
        run_status = "failed"
        merged = original_items
        duplicate_count = 0
        added_count = 0
        changed = False
    else:
        run_status = "partial" if failed_metrics or mode != "all" else "complete"
        merged, duplicate_count, added_count = merge_items(
            original_items,
            publishable_items,
            now,
            preserve_existing_duplicates=False,
        )
        seen_keys: set[str] = set()
        metric_by_source_query = {
            (metric["source"], metric["query_id"]): metric
            for metric in source_metrics
        }
        new_item_ids = {id(item) for item in publishable_items}
        for candidate in [*original_items, *publishable_items]:
            keys = dedup_keys(candidate)
            if any(key in seen_keys for key in keys) and id(candidate) in new_item_ids:
                source_name = (candidate.get("source") or {}).get("name", "")
                metric = metric_by_source_query.get((
                    source_name,
                    candidate.get("_diagnostic_metric_id"),
                ))
                if metric is not None:
                    metric["duplicates"] += 1
                    category = candidate.get("category", "")
                    duplicate_categories = metric_duplicate_counts.setdefault(
                        id(metric), {}
                    )
                    duplicate_categories[category] = (
                        duplicate_categories.get(category, 0) + 1
                    )
            seen_keys.update(keys)
        changed = items_changed(original_items, merged)

    configured_feed_names = {
        feed.get("name")
        for feed in config.get("rss_feeds", [])
        if feed.get("name")
    }
    if mode in {"all", "news"}:
        for item in merged:
            if item.get("source", {}).get("name") in configured_feed_names:
                classify(item, config)
        changed = items_changed(original_items, merged)

    if run_status == "complete":
        for item in merged:
            classify(item, config)
        changed = items_changed(original_items, merged)

    merged_identities = {
        key
        for item in merged
        for key in dedup_keys(item)
    }
    previous_identities = {
        key
        for item in original_items
        for key in dedup_keys(item)
    }
    newly_published_by_source: dict[str, dict[str, set[str]]] = {}
    for item in merged:
        keys = dedup_keys(item)
        if any(key in previous_identities for key in keys):
            continue
        source_name = (item.get("source") or {}).get("name", "")
        category = item.get("category", "")
        if source_name and category in CONTENT_CATEGORIES:
            newly_published_by_source.setdefault(source_name, {}).setdefault(
                category, set()
            ).add(record_identity(item))
    published_by_category = {
        category: sum(item.get("category") == category for item in merged)
        for category in sorted(CONTENT_CATEGORIES)
    }
    for metric in source_metrics:
        category_ids = metric_category_ids.get(id(metric), {})
        approved_ids = metric_approved_ids.get(id(metric), {})
        for category, counts in metric["category_metrics"].items():
            counts["unique_records"] = len(category_ids.get(category, set()))
            counts["published_records"] = len(
                approved_ids.get(category, set()) & merged_identities
            )

    source_category_summaries: dict[str, dict] = {}
    category_summaries = {}
    for category in sorted(CONTENT_CATEGORIES):
        source_rows = {}
        category_collected = 0
        category_approved = 0
        category_discarded = 0
        for source_name in dict.fromkeys(row["source"] for row in source_metrics):
            rows = [row for row in source_metrics if row["source"] == source_name]
            buckets = [
                row["category_metrics"].get(category, {})
                for row in rows
            ]
            raw_collected = sum(
                row["category_raw_results"].get(category, 0)
                for row in rows
            )
            collected = sum(bucket.get("collected_candidates", 0) for bucket in buckets)
            approved = sum(bucket.get("approved_candidates", 0) for bucket in buckets)
            discarded = sum(bucket.get("discarded_candidates", 0) for bucket in buckets)
            identities = set().union(*(
                metric_category_ids.get(id(row), {}).get(category, set())
                for row in rows
            ))
            approved_identities = set().union(*(
                metric_approved_ids.get(id(row), {}).get(category, set())
                for row in rows
            ))
            if raw_collected or collected or approved or discarded:
                source_rows[source_name] = {
                    "raw_records_collected": raw_collected,
                    "valid_candidates": collected,
                    "unique_after_deduplication": len(identities),
                    "new_records": len(
                        newly_published_by_source.get(source_name, {}).get(category, set())
                    ),
                    "duplicates": sum(
                        metric_duplicate_counts.get(id(row), {}).get(category, 0)
                        for row in rows
                    ),
                    "approved_by_relevance": approved,
                    "discarded_by_relevance": discarded,
                    "published_records": len(approved_identities & merged_identities),
                    "discard_reasons": {
                        reason: sum(row["discard_reasons"].get(reason, 0) for row in rows)
                        for reason in dict.fromkeys(
                            reason
                            for row in rows
                            for reason in row["discard_reasons"]
                        )
                    },
                    "decision_reasons": {
                        reason: sum(row["decision_reasons"].get(reason, 0) for row in rows)
                        for reason in dict.fromkeys(
                            reason
                            for row in rows
                            for reason in row["decision_reasons"]
                        )
                    },
                }
                source_category_summaries.setdefault(source_name, {})[category] = source_rows[source_name]
            category_collected += collected
            category_approved += approved
            category_discarded += discarded
        category_summaries[category] = {
            "raw_records_collected": sum(
                metric["category_raw_results"].get(category, 0)
                for metric in source_metrics
            ),
            "valid_candidates": category_collected,
            "unique_after_deduplication": len(category_candidate_ids.get(category, set())),
            "approved_by_relevance": category_approved,
            "discarded_by_relevance": category_discarded,
            "published_records": published_by_category[category],
            "sources": source_rows,
        }

    previous_source_status = old_data.get("source_status", {})
    if not isinstance(previous_source_status, dict):
        previous_source_status = {}
    current_source_status = {
        source_name: dict(status)
        for source_name, status in previous_source_status.items()
        if isinstance(source_name, str) and isinstance(status, dict)
    }
    for source_name in dict.fromkeys(row["source"] for row in source_metrics):
        rows = [row for row in source_metrics if row["source"] == source_name]
        successful = any(
            row["request_status"] == "success"
            or (row["request_status"] == "partial" and row["pages_consulted"] > 0)
            for row in rows
        )
        prior = previous_source_status.get(source_name, {})
        if not isinstance(prior, dict):
            prior = {}
        current_source_status[source_name] = {
            "last_attempt_at": now,
            "last_successful_at": now if successful else prior.get("last_successful_at"),
            "status": (
                "failed" if all(row["collection_status"] == "failed" for row in rows)
                else "partial" if any(row["collection_status"] != "complete" for row in rows)
                else "complete"
            ),
            "errors": list(dict.fromkeys(
                error for row in rows for error in row["errors"]
            )),
        }

    data_written = False
    if run_status != "failed" or previous:
        output = {
            "schema_version": 1,
            "generated_at": now if changed or not previous else previous.get("generated_at", now),
            "last_checked_at": now,
            "collection_status": run_status,
            "collection_scope": mode,
            "source_status": current_source_status,
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
        data_written = True
    elif run_status == "failed":
        output = {
            "schema_version": 1,
            "generated_at": "",
            "last_checked_at": now,
            "collection_status": "failed",
            "collection_scope": mode,
            "source_status": current_source_status,
            "items": [],
        }
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(output, ensure_ascii=False, indent=2) + "\n"
        parsed = json.loads(serialized)
        if parsed.get("schema_version") != 1 or not isinstance(parsed.get("items"), list):
            raise RuntimeError("validação do JSON de falha gerado falhou")
        temporary_path = OUTPUT_PATH.with_suffix(".json.tmp")
        temporary_path.write_text(serialized, encoding="utf-8")
        temporary_path.replace(OUTPUT_PATH)
        data_written = True

    report = {
        "schema_version": 1,
        "run_id": now,
        "mode": mode,
        "status": run_status,
        "data_written": data_written,
        "classification_mode": "multi-evidence contextual relevance; complete-query results publish independently",
        "summary": {
            "source_requests": len(source_metrics),
            "successful_requests": len(successful_metrics),
            "failed_or_partial_requests": len(failed_metrics),
            "requests_attempted": sum(metric["attempts"] for metric in source_metrics),
            "requests_succeeded": sum(metric["requests_succeeded"] for metric in source_metrics),
            "pages_consulted": sum(metric["pages_consulted"] for metric in source_metrics),
            "raw_results": sum(metric["raw_results"] for metric in source_metrics),
            "valid_records": sum(metric["valid_records"] for metric in source_metrics),
            "results_retrieved": sum(metric["results_retrieved"] for metric in source_metrics),
            "unique_query_records": sum(metric["unique_records"] for metric in source_metrics),
            "transient_failures": sum(metric["transient_failures"] for metric in source_metrics),
            "permanent_failures": sum(metric["permanent_failures"] for metric in source_metrics),
            "retries": sum(metric["retries"] for metric in source_metrics),
            "queries_limit_reached": sum(metric["limit_reached"] for metric in source_metrics),
            "announced_result_totals": sum(
                metric["results_announced"]
                for metric in source_metrics
                if isinstance(metric["results_announced"], int)
            ),
            "queries_with_announced_totals": sum(
                isinstance(metric["results_announced"], int)
                for metric in source_metrics
            ),
            "completed_queries": sum(
                metric["collection_status"] == "complete" for metric in source_metrics
            ),
            "interrupted_queries": sum(
                metric["collection_status"] in {"partial", "failed"}
                for metric in source_metrics
            ),
            "resumable_queries": sum(
                metric["resume_possible"] for metric in source_metrics
            ),
            "duration_seconds": round(
                sum(metric["duration_seconds"] for metric in source_metrics), 3
            ),
            "accepted": sum(metric["accepted"] for metric in source_metrics),
            "review": sum(metric["review"] for metric in source_metrics),
            "discarded": sum(metric["discarded"] for metric in source_metrics),
            "accepted_by_relevance_filter": sum(
                metric["relevance_accepted"] for metric in source_metrics
            ),
            "rejected_by_relevance_filter": sum(
                metric["relevance_discarded"] for metric in source_metrics
            ),
            "duplicates": duplicate_count,
            "new_records": added_count,
            "candidate_records_not_published": (
                partial_candidates
            ),
            "preserved_previous_records": len(original_items),
            "published_records": len(merged),
            "frontend_eligible_records": sum(
                item.get("relevance", {}).get("level") in {"alta", "media", "complementar"}
                for item in merged
            ),
            "not_displayed_by_relevance": sum(
                item.get("relevance", {}).get("level") not in {"alta", "media", "complementar"}
                for item in merged
            ),
            "relevance_distribution": {
                level: sum(
                    item.get("relevance", {}).get("level") == level
                    for item in merged
                )
                for level in ("alta", "media", "complementar", "baixa")
            },
            "complementary_relevance": sum(
                item.get("relevance", {}).get("level") == "complementar"
                for item in merged
            ),
            "discard_reasons": {
                reason: sum(
                    metric["discard_reasons"].get(reason, 0)
                    for metric in source_metrics
                )
                for reason in dict.fromkeys(
                    reason
                    for metric in source_metrics
                    for reason in metric["discard_reasons"]
                )
            },
            "category_summaries": category_summaries,
        },
        "source_summaries": {
            source_name: {
                "queries": len(source_rows),
                "status": (
                    "failed" if all(row["collection_status"] == "failed" for row in source_rows)
                    else "partial" if any(row["collection_status"] != "complete" for row in source_rows)
                    else "complete"
                ),
                "requests_attempted": sum(row["attempts"] for row in source_rows),
                "requests_succeeded": sum(row["requests_succeeded"] for row in source_rows),
                "pages_consulted": sum(row["pages_consulted"] for row in source_rows),
                "raw_results": sum(row["raw_results"] for row in source_rows),
                "results_retrieved": sum(row["results_retrieved"] for row in source_rows),
                "valid_records": sum(row["valid_records"] for row in source_rows),
                "unique_query_records": sum(row["unique_records"] for row in source_rows),
                "duplicates": sum(row["duplicates"] for row in source_rows),
                "transient_failures": sum(row["transient_failures"] for row in source_rows),
                "permanent_failures": sum(row["permanent_failures"] for row in source_rows),
                "retries": sum(row["retries"] for row in source_rows),
                "queries_limit_reached": sum(row["limit_reached"] for row in source_rows),
                "queries_with_continuation": sum(
                    row["continuation_available"] for row in source_rows
                ),
                "duration_seconds": round(
                    sum(row["duration_seconds"] for row in source_rows), 3
                ),
                "results_announced": sum(
                    row["results_announced"]
                    for row in source_rows
                    if isinstance(row["results_announced"], int)
                ),
                "queries_with_announced_totals": sum(
                    isinstance(row["results_announced"], int) for row in source_rows
                ),
                "interruption_reasons": {
                    reason: sum(row["interruption_reason"] == reason for row in source_rows)
                    for reason in dict.fromkeys(
                        row["interruption_reason"] for row in source_rows
                        if row["interruption_reason"]
                    )
                },
                "last_successful_at": current_source_status[source_name]["last_successful_at"],
                "urls": list(dict.fromkeys(
                    row["query"]
                    for row in source_rows
                    if row["query"].startswith(("http://", "https://"))
                )),
                "new_records": sum(
                    sum(len(identities) for identities in categories.values())
                    for source, categories in newly_published_by_source.items()
                    if source == source_name
                ),
                "category_metrics": source_category_summaries.get(source_name, {}),
                "discard_reasons": {
                    reason: sum(row["discard_reasons"].get(reason, 0) for row in source_rows)
                    for reason in dict.fromkeys(
                        reason
                        for row in source_rows
                        for reason in row["discard_reasons"]
                    )
                },
                "decision_reasons": {
                    reason: sum(row["decision_reasons"].get(reason, 0) for row in source_rows)
                    for reason in dict.fromkeys(
                        reason
                        for row in source_rows
                        for reason in row["decision_reasons"]
                    )
                },
            }
            for source_name in dict.fromkeys(row["source"] for row in source_metrics)
            for source_rows in [[row for row in source_metrics if row["source"] == source_name]]
        },
        "sources": source_metrics,
    }
    report_path = write_diagnostics(report)
    log(
        f"Execução {run_status}: requisições={len(source_metrics)}; "
        f"brutos={report['summary']['raw_results']}; válidos={report['summary']['valid_records']}; "
        f"novos={added_count}; duplicados={duplicate_count}; "
        f"mantidos={len(merged)}; JSON atualizado={str(data_written).lower()}"
    )
    log(f"Relatório de diagnóstico: {report_path}")
    return run_status


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("all", "news", "academic"), default="all")
    parser.add_argument(
        "--evaluate-existing",
        action="store_true",
        help="gera avaliação contextual dos registros existentes sem alterar dados públicos",
    )
    args = parser.parse_args()
    if args.evaluate_existing:
        with CONFIG_PATH.open(encoding="utf-8") as handle:
            config = json.load(handle)
        previous = load_previous() or {"items": []}
        report = evaluate_existing(config, previous["items"])
        report_path = write_diagnostics(report, prefix="avaliacao-contextual")
        log(
            "Avaliação contextual: "
            + ", ".join(f"{key}={value}" for key, value in report["decisions"].items())
            + f"; divergências={report['comparison']['definite_divergences']}; "
            + f"revisão={report['comparison']['diagnostic_review']}"
        )
        log(f"Relatório de avaliação: {report_path}")
        return
    if run(args.mode) != "complete":
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log(f"Erro fatal: {safe_error(exc)}")
        try:
            path = write_diagnostics({
                "schema_version": 1,
                "run_id": utc_now(),
                "status": "failed",
                "fatal_error": safe_error(exc),
            })
            log(f"Relatório de falha fatal: {path}")
        except OSError as diagnostic_error:
            log(f"Não foi possível gravar o diagnóstico fatal: {safe_error(diagnostic_error)}")
        sys.exit(1)
