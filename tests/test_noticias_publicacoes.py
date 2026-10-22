import importlib.util
import gzip
import json
import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "noticias_publicacoes", ROOT / "scripts" / "noticias_publicacoes.py"
)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class RelevanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / "config" / "noticias-publicacoes.json").open(encoding="utf-8") as handle:
            cls.config = json.load(handle)

    def item(self, title, summary="", source_type="noticia"):
        return {
            "title": title,
            "summary": summary,
            "url": "https://example.org/noticia",
            "source": {"name": "Teste", "type": source_type},
            "category": "noticia",
            "relevance": {},
        }

    def test_apabf_and_environmental_theme_is_high(self):
        item = self.item("Conservação na APABF", "Projeto de biodiversidade")
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "alta")
        self.assertIn("APABF ou nome completo da unidade no título/resumo", item["relevance"]["reason"])

    def test_municipality_without_relevant_theme_is_not_public(self):
        item = self.item("Obras em Imbituba", "Mudanças no trânsito do centro")
        self.assertFalse(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "baixa")

    def test_generic_research_does_not_make_municipality_relevant(self):
        item = self.item("Tempo e intriga na constituição do mundo", "Pesquisa acadêmica em Florianópolis", "repositorio")
        self.assertFalse(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "baixa")

    def test_municipality_with_relevant_theme_is_medium(self):
        item = self.item("Conservação em Imbituba", "Ação na Lagoa de Ibiraquera")
        self.assertTrue(collector.classify(item, self.config))
        self.assertIn(item["relevance"]["level"], {"alta", "media"})
        self.assertIn("Imbituba", item["locations"])

    def test_keywords_without_summary_recover_scientific_and_regional_work(self):
        item = self.item(
            "Ecologia da baleia-franca-austral",
            source_type="academica",
        )
        item["keywords"] = ["Eubalaena australis", "Santa Catarina"]
        self.assertTrue(collector.classify(item, self.config))
        self.assertIn(item["relevance"]["level"], {"alta", "media"})

    def test_english_marine_science_without_apabf_name_is_complementary(self):
        item = self.item(
            "Southern right whale habitat and marine conservation",
            "A synthesis of coastal biodiversity in Brazil.",
            source_type="academica",
        )
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "complementar")
        self.assertTrue(any("contexto científico complementar" in reason
                            for reason in item["relevance"]["reason"]))

    def test_spanish_species_and_coastal_conservation_terms_are_normalized(self):
        item = self.item(
            "Ecología de la ballena franca austral",
            "Conservación marina y biodiversidad costera en Brasil.",
            source_type="academica",
        )
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "complementar")

    def test_generic_context_in_an_unrelated_region_is_not_complementary(self):
        item = self.item(
            "Marine conservation in Bahia",
            "A study of coastal biodiversity.",
            source_type="academica",
        )
        self.assertFalse(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "baixa")

    def test_isolated_whale_mention_is_penalized(self):
        item = self.item("Baleia-franca é vista no oceano", "Espécie observada em águas distantes")
        self.assertFalse(collector.classify(item, self.config))
        self.assertIn("menção isolada a baleia-franca sem relação regional identificada", item["relevance"]["reason"])

    def test_whales_at_praia_do_rosa_are_highly_relevant(self):
        item = self.item("Baleias-francas são avistadas na Praia do Rosa")
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "alta")
        self.assertIn("Praia do Rosa", item["locations"])
        self.assertTrue(any("+7 local costeiro com contexto ambiental" in reason for reason in item["relevance"]["reason"]))

    def test_whale_watching_at_gamboa_is_highly_relevant(self):
        item = self.item("Observação de baleias na Praia da Gamboa")
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "alta")
        self.assertIn("Praia da Gamboa", item["locations"])

    def test_coastal_erosion_at_silveira_is_relevant(self):
        item = self.item("Erosão costeira preocupa moradores da Praia do Silveira")
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "alta")
        self.assertIn("Praia do Silveira", item["locations"])

    def test_fauna_observation_route_at_vigia_is_relevant(self):
        item = self.item("Trilha da Vigia ganha roteiro de observação de fauna")
        self.assertTrue(collector.classify(item, self.config))
        self.assertIn(item["relevance"]["level"], {"alta", "media"})
        self.assertIn("Trilha da Vigia", item["locations"])

    def test_caminhos_da_baleia_franca_with_visitors_is_relevant(self):
        item = self.item("Caminhos da Baleia Franca recebe visitantes")
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(item["relevance"]["level"], "media")
        self.assertTrue(any("+5 local costeiro com turismo de natureza" in reason for reason in item["relevance"]["reason"]))

    def test_guided_caminhos_route_is_not_confused_with_regional_trail(self):
        item = self.item("Trilha Caminhos da Baleia Franca recebe visitantes")
        self.assertTrue(collector.classify(item, self.config))
        self.assertEqual(
            [match["name"] for match in item["territorial_matches"]],
            ["Trilha Caminhos da Baleia Franca"],
        )

    def test_geographic_reference_is_context_only_without_local_municipality(self):
        item = self.item("Qualidade da água do Rio Tubarão")
        self.assertFalse(collector.classify(item, self.config))
        self.assertIn("referência geográfica auxiliar: Rio Tubarão", item["relevance"]["reason"])

    def test_beach_name_alone_does_not_add_environmental_relevance(self):
        for title in (
            "Praia do Rosa recebe campeonato de surf",
            "Evento gastronômico na Praia da Gamboa",
            "Rosa vence competição esportiva",
        ):
            with self.subTest(title=title):
                item = self.item(title)
                self.assertFalse(collector.classify(item, self.config))
                self.assertEqual(item["relevance"]["level"], "baixa")

    def test_place_name_in_another_region_is_not_apabf_evidence(self):
        for title in (
            "Baleias-francas são avistadas na Praia do Rosa, Bahia",
            "Observação de baleias na Praia da Gamboa, Bahia",
        ):
            with self.subTest(title=title):
                item = self.item(title)
                self.assertFalse(collector.classify(item, self.config))
                self.assertFalse(item["territorial_matches"])

    def test_barra_without_full_place_name_is_not_a_territorial_match(self):
        item = self.item("Barras de areia mudam após a tempestade")
        self.assertFalse(collector.classify(item, self.config))
        self.assertFalse(item["territorial_matches"])

    def test_rede_trilhas_alone_is_not_a_strong_relevance_signal(self):
        item = self.item("Rede Trilhas anuncia novos percursos pelo Brasil")
        self.assertFalse(collector.classify(item, self.config))
        self.assertFalse(item["territorial_matches"])

    def test_territorial_queries_and_catalogue_relationships_are_scoped(self):
        territorial = self.config["territorial"]
        for query in (
            "Praia do Rosa baleias-francas",
            "Praia da Gamboa baleias-francas",
            "Caminhos da Baleia Franca",
        ):
            self.assertIn(query, self.config["openalex_queries"])
            self.assertIn(query, self.config["crossref_queries"])
        vigia = next(entry for entry in territorial["trilhas"] if entry["name"] == "Trilha da Vigia")
        rota = next(entry for entry in territorial["trilhas"] if entry["name"] == "Rota da Baleia Franca")
        caminhos = next(entry for entry in territorial["trilhas"] if entry["name"] == "Caminhos da Baleia Franca")
        self.assertIn("Trilha do Casqueiro", vigia["aliases"])
        self.assertNotIn("Rota da Baleia Franca", caminhos["aliases"])
        self.assertEqual(rota["category"], "cicloturismo")
        for query in (
            "Eubalaena australis Santa Catarina",
            "marine mammal strandings Santa Catarina",
            "coastal biodiversity southern Brazil",
            "conservación marina costa de Santa Catarina",
        ):
            self.assertIn(query, self.config["openalex_queries"])
            self.assertIn(query, self.config["crossref_queries"])
        self.assertIn("southern right whale", self.config["contextual_publication_topics"])

    def test_existing_item_reclassification_is_detected_as_json_change(self):
        item = self.item("Qualidade da água no Rio Tubarão")
        original = json.loads(json.dumps(item))
        collector.classify(item, self.config)
        self.assertTrue(collector.items_changed([original], [item]))

    def test_contextual_assessment_handles_real_dataset_examples(self):
        with (ROOT / "dados" / "noticias-publicacoes.json").open(encoding="utf-8") as handle:
            records = json.load(handle)["items"]
        motorcycle = next(item for item in records if "motociclista" in item["title"])
        farol = next(item for item in records if item["title"] == "Farol de Santa Marta terá visitação")
        study = next(
            item for item in records
            if item["title"].startswith("Etnoecologia comportamental da baleia-franca-austral")
        )

        motorcycle_result = collector.assess_candidate(motorcycle, self.config)
        farol_result = collector.assess_candidate(farol, self.config)
        study_result = collector.assess_candidate(study, self.config)

        self.assertEqual(motorcycle_result["decision"], "discarded")
        self.assertEqual(
            motorcycle_result["evidence"]["territory"]["municipalities"],
            ["Florianópolis"],
        )
        self.assertIn(
            "monitoramento",
            motorcycle_result["evidence"]["topics"]["ambiguous_activity_terms"],
        )
        self.assertEqual(farol_result["decision"], "review")
        self.assertIn(
            "Farol de Santa Marta",
            farol_result["evidence"]["territory"]["localities"],
        )
        self.assertTrue(farol_result["evidence"]["topics"]["ambiguous_activity_terms"])
        self.assertEqual(study_result["decision"], "accepted")
        self.assertTrue(study_result["evidence"]["territory"]["unit_terms"])
        self.assertTrue(study_result["evidence"]["topics"]["concrete_evidence"])

    def test_contextual_assessment_and_publication_filter_reject_traffic_camera_noise(self):
        with (ROOT / "dados" / "noticias-publicacoes.json").open(encoding="utf-8") as handle:
            records = json.load(handle)["items"]
        motorcycle = next(item for item in records if "motociclista" in item["title"])
        self.assertFalse(collector.classify(motorcycle, self.config))
        original_reason = list(motorcycle["relevance"]["reason"])
        evaluation = collector.assess_candidate(motorcycle, self.config)

        self.assertEqual(evaluation["decision"], "discarded")
        self.assertIn("monitoramento", evaluation["evidence"]["summary"]["matched_terms"])
        self.assertEqual(motorcycle["relevance"]["reason"], original_reason)

    def test_traffic_camera_monitoring_is_not_environmental_evidence(self):
        item = self.item(
            "Acidente na SC-401: câmera de monitoramento registra colisão",
            "O trânsito foi interrompido em Florianópolis após a batida.",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["decision"], "discarded")
        self.assertEqual(result["thematic_status"], "incerta")
        self.assertEqual(result["territorial_relation"], "incerta")
        self.assertIn(
            "câmera de monitoramento",
            result["evidence"]["topics"]["non_environmental_contexts"],
        )
        self.assertTrue(result["evidence"]["topics"]["negative_or_ambiguous"])

    def test_explicit_apabf_conservation_study_is_thematically_and_territorially_direct(self):
        item = self.item(
            "Estudo de conservação costeira na APABF",
            "Análise da restinga e da dinâmica costeira da unidade.",
            source_type="academica",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["decision"], "accepted")
        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "direta")
        self.assertIn(
            "ecossistemas_costeiros",
            [topic["id"] for topic in result["evidence"]["topics"]["positive"]],
        )
        self.assertTrue(any("APABF" in evidence for evidence in result["evidence"]["territory"]["positive"]))

    def test_english_unit_name_and_scientific_topic_are_recognized_diagnostically(self):
        item = self.item(
            "Geodiversity and landscape of the Right Whale Environmental Protection Area",
            "An interpretive study of coastal geodiversity.",
            source_type="academica",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["decision"], "accepted")
        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "direta")
        self.assertIn(
            "ecossistemas_costeiros",
            [topic["id"] for topic in result["evidence"]["topics"]["positive"]],
        )

    def test_farol_visitation_without_environmental_evidence_requires_review(self):
        item = self.item(
            "Farol de Santa Marta terá visitação",
            "Acesso será liberado mediante doação de alimentos.",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["decision"], "review")
        self.assertEqual(result["territorial_relation"], "incerta")
        self.assertIn(
            "Farol de Santa Marta",
            result["evidence"]["territory"]["localities"],
        )
        self.assertTrue(result["needs_review"])

    def test_coastal_erosion_at_catalogued_regional_locality_is_not_direct(self):
        item = self.item("Erosão costeira na Praia do Rosa")
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "regional")
        self.assertEqual(result["decision"], "accepted")
        self.assertFalse(result["evidence"]["territory"]["unit_terms"])

    def test_marine_fauna_research_elsewhere_is_not_direct_apabf_evidence(self):
        item = self.item(
            "Monitoramento de fauna marinha na Bahia",
            "Estudo de cetáceos em área costeira do estado.",
            source_type="academica",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "tematica_contextual")
        self.assertEqual(result["decision"], "review")
        self.assertFalse(result["evidence"]["territory"]["unit_terms"])
        self.assertTrue(result["evidence"]["territory"]["ambiguous"])

    def test_isolated_whale_mention_is_topical_but_not_automatically_apabf_relevant(self):
        item = self.item("Baleia-franca é avistada em águas distantes")
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "incerta")
        self.assertEqual(result["decision"], "review")

    def test_fishing_without_identified_locality_is_territorially_uncertain(self):
        item = self.item(
            "Pesca artesanal em comunidade litorânea",
            "Pescadores discutem mudanças na atividade.",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "incerta")
        self.assertEqual(result["decision"], "review")

    def test_apabf_licensing_and_urbanization_are_recognized_contextually(self):
        item = self.item(
            "Licenciamento ambiental de loteamento na APABF",
            "Análise de ocupação e uso do solo em área da unidade.",
        )
        result = collector.assess_candidate(item, self.config)

        topic_ids = [topic["id"] for topic in result["evidence"]["topics"]["positive"]]
        self.assertEqual(result["decision"], "accepted")
        self.assertEqual(result["territorial_relation"], "direta")
        self.assertIn("gestao_politicas_ambientais", topic_ids)
        self.assertIn("ocupacao_uso_solo", topic_ids)

    def test_sparse_record_remains_uncertain_without_invented_evidence(self):
        result = collector.assess_candidate(self.item("APABF"), self.config)

        self.assertEqual(result["decision"], "review")
        self.assertEqual(result["territorial_relation"], "direta")
        self.assertIn("metadados insuficientes", result["reasons"][0])
        self.assertEqual(result["evidence"]["topics"]["concrete_evidence"], [])

    def test_university_location_is_not_inferred_as_study_location(self):
        item = self.item(
            "Estudo sobre erosão costeira",
            "Pesquisa da Universidade Federal de Santa Catarina, sediada em Florianópolis.",
            source_type="academica",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "incerta")
        self.assertEqual(result["decision"], "review")
        self.assertEqual(
            result["evidence"]["territory"]["municipalities"],
            ["Florianópolis"],
        )
        self.assertTrue(any("não comprova o local do estudo" in note for note in result["evidence"]["territory"]["ambiguous"]))
        self.assertIn("source", result["excluded_metadata"])

    def test_thematically_relevant_but_unlocated_content_stays_distinctly_uncertain(self):
        item = self.item(
            "Erosão costeira em praias estudadas",
            "O resumo não informa municípios ou unidade amostral.",
            source_type="academica",
        )
        result = collector.assess_candidate(item, self.config)

        self.assertEqual(result["thematic_status"], "pertinente")
        self.assertEqual(result["territorial_relation"], "incerta")
        self.assertEqual(result["decision"], "review")

    def test_existing_report_compares_filters_without_mutating_public_items(self):
        with (ROOT / "dados" / "noticias-publicacoes.json").open(encoding="utf-8") as handle:
            records = json.load(handle)["items"]
        original_motorcycle_relevance = json.loads(json.dumps(
            next(item["relevance"] for item in records if "motociclista" in item["title"])
        ))

        report = collector.evaluate_existing(self.config, records)

        self.assertEqual(report["total"], 95)
        self.assertEqual(report["mode"], "contextual-evaluation-only")
        self.assertEqual(
            report["comparison"]["agreements"]
            + report["comparison"]["definite_divergences"]
            + report["comparison"]["diagnostic_review"],
            report["total"],
        )
        self.assertIn("possible_false_positives", report["comparison"])
        self.assertIn("ecossistemas_costeiros", report["topic_distribution"])
        self.assertIn("direta", report["territorial_distribution"])
        motorcycle = next(item for item in records if "motociclista" in item["title"])
        self.assertEqual(motorcycle["relevance"], original_motorcycle_relevance)


class NormalizationTests(unittest.TestCase):
    def test_gzip_response_is_decoded(self):
        self.assertEqual(
            collector.decode_content(gzip.compress(b"<rss />"), "gzip"),
            b"<rss />",
        )

    def test_tracking_parameters_are_removed(self):
        self.assertEqual(
            collector.normalize_url("https://www.example.org/story/?utm_source=news&fbclid=abc&id=2"),
            "https://example.org/story?id=2",
        )

    def test_different_article_urls_are_not_deduplicated_by_topic(self):
        first = {"_doi": "", "_guid": "", "url": "https://g1.globo.com/materia-a", "title": "Mesmo assunto", "published_at": "2026-01-01"}
        second = {"_doi": "", "_guid": "", "url": "https://diariodosul.com.br/materia-b", "title": "Mesmo assunto", "published_at": "2026-01-01"}
        self.assertNotEqual(collector.dedup_key(first), collector.dedup_key(second))

    def test_same_url_deduplicates_even_if_feed_guids_differ(self):
        first = collector.make_item(
            "Uma notícia", "", "https://example.org/story?utm_source=rss",
            {"name": "Feed A", "type": "noticia"}, "2026-01-01", guid="feed-a-guid",
        )
        second = collector.make_item(
            "Uma notícia", "", "https://www.example.org/story",
            {"name": "Feed B", "type": "noticia"}, "2026-01-01", guid="feed-b-guid",
        )
        merged, duplicates, added = collector.merge_items([], [first, second], "2026-01-02T00:00:00+00:00")
        self.assertEqual(len(merged), 1)
        self.assertEqual(duplicates, 1)
        self.assertEqual(added, 1)

    def test_same_doi_merges_cross_source_metadata_but_similar_distinct_works_remain(self):
        first = collector.make_item(
            "Estudo costeiro", "Resumo curto", "https://doi.org/10.1234/alpha",
            {"name": "OpenAlex", "type": "academica"}, "2026-01-01",
            doi="10.1234/alpha", keywords=["coastal ecology"],
            authors=["Ana Silva"], journal="Marine Ecology",
        )
        second = collector.make_item(
            "Estudo costeiro", "Resumo detalhado sobre a biodiversidade local.",
            "https://publisher.example/alpha",
            {"name": "Crossref", "type": "academica"}, "2026-01-01",
            doi="https://doi.org/10.1234/alpha", keywords=["coastal biodiversity"],
            authors=["João Costa"],
        )
        distinct = collector.make_item(
            "Estudo costeiro", "Outro trabalho", "https://doi.org/10.1234/beta",
            {"name": "Crossref", "type": "academica"}, "2026-01-01",
            doi="10.1234/beta",
        )
        merged, duplicates, added = collector.merge_items(
            [], [first, second, distinct], "2026-01-02T00:00:00+00:00"
        )
        alpha = next(item for item in merged if item["doi"] == "https://doi.org/10.1234/alpha")

        self.assertEqual(len(merged), 2)
        self.assertEqual(duplicates, 1)
        self.assertEqual(added, 2)
        self.assertIn("Resumo detalhado", alpha["summary"])
        self.assertEqual(set(alpha["authors"]), {"Ana Silva", "João Costa"})
        self.assertIn("coastal biodiversity", alpha["keywords"])
        self.assertEqual(alpha["journal"], "Marine Ecology")
        self.assertEqual(set(alpha["sources"]), {"OpenAlex", "Crossref"})


class CollectionSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / "config" / "noticias-publicacoes.json").open(encoding="utf-8") as handle:
            cls.config = json.load(handle)

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.config_path = self.root / "config.json"
        self.output_path = self.root / "news.json"
        self.diagnostics_path = self.root / "diagnostics"
        config = dict(self.config)
        config["rss_feeds"] = [
            {"name": "Fonte falha", "url": "https://fail.example/rss", "type": "noticia", "category": "noticia"},
            {"name": "Fonte válida", "url": "https://ok.example/rss", "type": "noticia", "category": "noticia"},
        ]
        self.config_path.write_text(json.dumps(config), encoding="utf-8")
        self.patches = [
            mock.patch.object(collector, "CONFIG_PATH", self.config_path),
            mock.patch.object(collector, "OUTPUT_PATH", self.output_path),
            mock.patch.object(collector, "DIAGNOSTICS_PATH", self.diagnostics_path),
            mock.patch.object(collector.time, "sleep"),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary_directory.cleanup)

    def write_previous(self, items):
        self.output_path.write_text(
            json.dumps({"schema_version": 1, "generated_at": "2026-10-01T00:00:00+00:00", "items": items}),
            encoding="utf-8",
        )

    def existing_item(self, title="Registro anterior"):
        return {
            "id": "stable-existing-id",
            "title": title,
            "summary": "Metadados existentes",
            "url": "https://example.org/previous",
            "source": {"name": "Fonte anterior", "type": "academica"},
            "published_at": "2026-01-01T00:00:00+00:00",
            "category": "academico",
            "keywords": ["conservação"],
            "authors": [],
            "locations": ["Garopaba"],
            "relevance": {"level": "alta", "score": 10, "reason": ["evidência anterior"]},
            "collected_at": "2026-10-01T00:00:00+00:00",
            "doi": "10.1234/example",
        }

    def candidate(self, url="https://example.org/new"):
        return collector.make_item(
            "Conservação na APABF",
            "Projeto de biodiversidade na APA da Baleia Franca",
            url,
            {"name": "Fonte válida", "type": "noticia", "category": "noticia"},
            "2026-10-20",
        )

    def fake_feed(self, source, metrics):
        metric = collector.new_source_metric(source["name"], "rss:feed", source["url"])
        metric["attempts"] = 1
        metric["pages_consulted"] = 1
        metrics.append(metric)
        if source["name"] == "Fonte falha":
            metric["attempts"] = 1
            metric["request_status"] = "failed"
            metric["collection_status"] = "failed"
            metric["errors"].append("HTTP 503")
            return []
        metric["attempts"] = 1
        metric["requests_succeeded"] = 1
        metric["request_status"] = "success"
        metric["collection_status"] = "complete"
        metric["raw_results"] = 1
        metric["results_retrieved"] = 1
        metric["valid_records"] = 1
        metric["unique_records"] = 1
        metric["pages_consulted"] = 1
        item = self.candidate()
        item["_diagnostic_metric_id"] = metric["query_id"]
        return [item]

    def read_report(self):
        paths = sorted(self.diagnostics_path.glob("coleta-*.json"))
        self.assertTrue(paths)
        return json.loads(paths[-1].read_text(encoding="utf-8"))

    def test_backup_is_byte_identical_and_public_json_stays_compatible(self):
        source = ROOT / "dados" / "noticias-publicacoes.json"
        backup = ROOT / "backups" / "noticias-publicacoes-20261021.json"
        self.assertTrue(backup.exists())
        self.assertEqual(
            hashlib.sha256(source.read_bytes()).digest(),
            hashlib.sha256(backup.read_bytes()).digest(),
        )
        data = json.loads(source.read_text(encoding="utf-8"))
        self.assertEqual(len(data["items"]), 95)
        self.assertTrue(all(item.get("id") and item.get("title") and item.get("url") for item in data["items"]))

    def test_one_source_failure_publishes_complete_source_and_preserves_old_records(self):
        previous = [self.existing_item()]
        self.write_previous(previous)
        original_bytes = self.output_path.read_bytes()
        with mock.patch.object(collector, "collect_feed", side_effect=self.fake_feed):
            status = collector.run("news")

        updated = json.loads(self.output_path.read_text(encoding="utf-8"))
        report = self.read_report()
        self.assertEqual(status, "partial")
        self.assertNotEqual(self.output_path.read_bytes(), original_bytes)
        self.assertEqual(len(updated["items"]), 2)
        self.assertIn(previous[0]["id"], [item["id"] for item in updated["items"]])
        self.assertEqual(updated["collection_status"], "partial")
        self.assertTrue(report["data_written"])
        self.assertEqual(report["summary"]["candidate_records_not_published"], 0)
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["summary"]["raw_results"], 1)
        self.assertEqual(report["summary"]["valid_records"], 1)
        self.assertEqual(report["summary"]["requests_attempted"], 2)
        self.assertEqual(report["summary"]["requests_succeeded"], 1)
        self.assertEqual(report["summary"]["results_retrieved"], 1)
        self.assertEqual(report["summary"]["unique_query_records"], 1)
        self.assertEqual(report["summary"]["preserved_previous_records"], 1)
        self.assertEqual(len(report["sources"]), 2)
        self.assertEqual(report["source_summaries"]["Fonte válida"]["status"], "complete")
        self.assertEqual(report["source_summaries"]["Fonte falha"]["status"], "failed")

    def test_all_sources_failing_preserves_snapshot_and_publishes_failure_status(self):
        previous = [self.existing_item()]
        self.write_previous(previous)
        original_bytes = self.output_path.read_bytes()

        def fail_feed(source, metrics):
            metric = collector.new_source_metric(source["name"], "rss:feed", source["url"])
            metric["request_status"] = "failed"
            metric["collection_status"] = "failed"
            metric["errors"].append("HTTP 503")
            metrics.append(metric)
            return []

        with mock.patch.object(collector, "collect_feed", side_effect=fail_feed):
            status = collector.run("news")

        self.assertEqual(status, "failed")
        updated = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertNotEqual(self.output_path.read_bytes(), original_bytes)
        self.assertEqual(updated["items"], previous)
        self.assertEqual(updated["collection_status"], "failed")
        report = self.read_report()
        self.assertTrue(report["data_written"])
        self.assertEqual(report["summary"]["failed_or_partial_requests"], 2)

    def test_partial_page_can_enrich_existing_record_without_losing_its_identity(self):
        previous = [self.existing_item()]
        self.write_previous(previous)
        original_bytes = self.output_path.read_bytes()
        duplicate = self.candidate("https://example.org/previous")
        duplicate["title"] = "Conservação atualizada na APABF"
        duplicate["summary"] = "Resumo que não deve substituir os metadados anteriores"

        def partial_feed(source, metrics):
            metric = collector.new_source_metric(source["name"], "rss:feed", source["url"])
            metrics.append(metric)
            if source["name"] == "Fonte falha":
                metric["request_status"] = "success"
                metric["collection_status"] = "partial"
                metric["pages_consulted"] = 1
                metric["raw_results"] = 1
                metric["valid_records"] = 1
                duplicate["_diagnostic_metric_id"] = metric["query_id"]
                return [duplicate]
            metric["request_status"] = "success"
            metric["collection_status"] = "complete"
            return []

        with mock.patch.object(collector, "collect_feed", side_effect=partial_feed):
            status = collector.run("news")

        updated = json.loads(self.output_path.read_text(encoding="utf-8"))
        report = self.read_report()
        self.assertEqual(status, "partial")
        self.assertNotEqual(self.output_path.read_bytes(), original_bytes)
        self.assertEqual(len(updated["items"]), 1)
        self.assertEqual(updated["items"][0]["id"], previous[0]["id"])
        self.assertEqual(updated["items"][0]["title"], duplicate["title"])
        self.assertEqual(updated["collection_status"], "partial")
        self.assertEqual(report["summary"]["candidate_records_not_published"], 0)

    def test_successful_partial_page_publishes_valid_records_with_partial_status(self):
        previous = [self.existing_item()]
        self.write_previous(previous)
        original_bytes = self.output_path.read_bytes()
        item = self.candidate("https://example.org/partial-result")

        def partial_page(source, metrics):
            metric = collector.new_source_metric(source["name"], "rss:feed", source["url"])
            metrics.append(metric)
            if source["name"] == "Fonte falha":
                metric["request_status"] = "partial"
                metric["collection_status"] = "partial"
                metric["pages_consulted"] = 1
                metric["raw_results"] = 1
                metric["valid_records"] = 1
                item["_diagnostic_metric_id"] = metric["query_id"]
                return [item]
            metric["request_status"] = "failed"
            metric["collection_status"] = "failed"
            return []

        with mock.patch.object(collector, "collect_feed", side_effect=partial_page):
            status = collector.run("news")

        updated = json.loads(self.output_path.read_text(encoding="utf-8"))
        report = self.read_report()
        self.assertEqual(status, "partial")
        self.assertNotEqual(self.output_path.read_bytes(), original_bytes)
        self.assertEqual(len(updated["items"]), 2)
        self.assertIn(item["title"], [record["title"] for record in updated["items"]])
        self.assertEqual(updated["collection_status"], "partial")
        self.assertTrue(report["data_written"])
        self.assertEqual(report["summary"]["candidate_records_not_published"], 0)

    def test_complete_empty_run_preserves_existing_records(self):
        previous = [self.existing_item()]
        self.write_previous(previous)

        def empty_success(source, metrics):
            metric = collector.new_source_metric(source["name"], "rss:feed", source["url"])
            metric["request_status"] = "success"
            metric["collection_status"] = "complete"
            metric["attempts"] = 1
            metric["pages_consulted"] = 1
            metrics.append(metric)
            return []

        with mock.patch.object(collector, "collect_feed", side_effect=empty_success):
            status = collector.run("news")

        updated = json.loads(self.output_path.read_text(encoding="utf-8"))
        report = self.read_report()
        self.assertEqual(status, "complete")
        self.assertEqual(len(updated["items"]), 1)
        self.assertEqual(updated["items"][0]["id"], previous[0]["id"])
        self.assertEqual(updated["items"][0]["title"], previous[0]["title"])
        self.assertTrue(report["data_written"])
        self.assertEqual(updated["last_checked_at"], report["run_id"])

    def test_reexecution_deduplicates_and_preserves_identifiers(self):
        previous = [self.existing_item()]
        self.write_previous(previous)

        with mock.patch.object(collector, "collect_feed", side_effect=self.fake_feed):
            first_status = collector.run("news")
            first = json.loads(self.output_path.read_text(encoding="utf-8"))
            second_status = collector.run("news")

        second = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(first_status, "partial")
        self.assertEqual(second_status, "partial")
        self.assertEqual(len(first["items"]), 2)
        self.assertEqual(len(second["items"]), 2)
        self.assertEqual(
            {item["id"] for item in first["items"]},
            {item["id"] for item in second["items"]},
        )

    def test_partial_collection_returns_failure_exit_code(self):
        self.write_previous([self.existing_item()])
        with mock.patch.object(collector, "collect_feed", side_effect=self.fake_feed), mock.patch.object(
            collector.sys, "argv", ["noticias_publicacoes.py", "--mode", "news"]
        ):
            with self.assertRaises(SystemExit) as raised:
                collector.main()
        self.assertEqual(raised.exception.code, 1)
        self.assertTrue(self.read_report())

    def test_http_rate_limit_error_is_reported_without_echoing_request_url(self):
        error = collector.urllib.error.HTTPError(
            "https://api.example/items?api_key=secret-value",
            429,
            "Too Many Requests",
            {},
            None,
        )
        metric = collector.new_source_metric("Fonte", "query-1", "consulta")
        collector.add_metric_error(metric, error)

        self.assertEqual(metric["rate_limit_events"], 1)
        self.assertEqual(metric["errors"], ["HTTP 429"])
        self.assertNotIn("secret-value", json.dumps(metric))

    def test_diagnostic_filename_is_scoped_to_github_run(self):
        with mock.patch.object(collector, "DIAGNOSTICS_PATH", self.diagnostics_path), mock.patch.dict(
            collector.os.environ, {"GITHUB_RUN_ID": "123456"}
        ):
            path = collector.write_diagnostics({"schema_version": 1})
        self.assertRegex(path.name, r"^coleta-123456-\d{8}T\d{12}Z\.json$")


class PaginationTests(unittest.TestCase):
    def openalex_config(self, **overrides):
        options = {
            "retry_attempts": 2,
            "retry_base_seconds": 0,
            "retry_max_seconds": 0,
            "request_interval_seconds": 0,
            "openalex_per_page": 2,
            "openalex_max_pages_per_query": 3,
            "openalex_max_results_per_query": 6,
            "crossref_rows_per_page": 2,
            "crossref_max_pages_per_query": 3,
            "crossref_max_results_per_query": 6,
        }
        options.update(overrides)
        return {
            "pagination": options,
            "openalex_queries": ["query"],
            "crossref_queries": ["query"],
        }

    def openalex_work(self, doi, title=None):
        return {
            "doi": f"https://doi.org/{doi}",
            "title": title or doi,
            "publication_date": "2026-01-01",
            "abstract_inverted_index": {},
            "primary_location": {"landing_page_url": f"https://example.org/{doi}"},
            "authorships": [],
            "keywords": [],
            "type": "article",
        }

    def openalex_response(self, records, count, **meta):
        return {"results": records, "meta": {"count": count, **meta}}

    def crossref_record(self, doi, title=None):
        return {
            "DOI": doi,
            "title": [title or doi],
            "URL": f"https://doi.org/{doi}",
            "published": {"date-parts": [[2026, 1, 1]]},
            "subject": ["coastal ecology"],
            "author": [{"given": "Ada", "family": "Silva"}],
        }

    def crossref_response(self, records, total, cursor=None):
        message = {"items": records, "total-results": total}
        if cursor is not None:
            message["next-cursor"] = cursor
        return {"message": message}

    def test_openalex_single_page_and_empty_end(self):
        config = self.openalex_config()
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            return_value=self.openalex_response(
                [self.openalex_work("10.1234/one")], 1
            ),
        ) as fetch:
            items = collector.collect_openalex(config, None, metrics)

        self.assertEqual(len(items), 1)
        self.assertEqual(metrics[0]["pages_consulted"], 1)
        self.assertEqual(metrics[0]["results_announced"], 1)
        self.assertEqual(metrics[0]["collection_status"], "complete")
        first_query = collector.urllib.parse.parse_qs(
            collector.urllib.parse.urlsplit(fetch.call_args.args[0]).query
        )
        self.assertEqual(first_query["page"], ["1"])
        self.assertEqual(first_query["per_page"], ["2"])

        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            return_value=self.openalex_response([], 0),
        ):
            self.assertEqual(collector.collect_openalex(config, None, metrics), [])
        self.assertEqual(metrics[0]["results_retrieved"], 0)
        self.assertEqual(metrics[0]["collection_status"], "complete")

    def test_openalex_multiple_pages_counts_duplicates_and_uses_basic_page_parameter(self):
        config = self.openalex_config()
        metrics = []
        pages = [
            self.openalex_response([
                self.openalex_work("10.1234/one"),
                self.openalex_work("10.1234/two"),
            ], 3),
            self.openalex_response([
                self.openalex_work("10.1234/two"),
            ], 3),
        ]
        with mock.patch.object(collector, "fetch_json", side_effect=pages) as fetch:
            items = collector.collect_openalex(config, None, metrics)

        self.assertEqual(len(items), 2)
        self.assertEqual(metrics[0]["raw_results"], 3)
        self.assertEqual(metrics[0]["valid_records"], 3)
        self.assertEqual(metrics[0]["duplicates"], 1)
        self.assertEqual(metrics[0]["unique_records"], 2)
        self.assertEqual(metrics[0]["results_retrieved"], 3)
        self.assertEqual(metrics[0]["collection_status"], "complete")
        pages_requested = [
            collector.urllib.parse.parse_qs(
                collector.urllib.parse.urlsplit(call.args[0]).query
            )["page"][0]
            for call in fetch.call_args_list
        ]
        self.assertEqual(pages_requested, ["1", "2"])

    def test_openalex_short_page_before_announced_total_is_partial(self):
        config = self.openalex_config()
        metrics = []
        response = self.openalex_response([self.openalex_work("10.1234/one")], 3)
        with mock.patch.object(collector, "fetch_json", return_value=response):
            items = collector.collect_openalex(config, None, metrics)

        self.assertEqual(len(items), 1)
        self.assertEqual(metrics[0]["collection_status"], "partial")
        self.assertEqual(metrics[0]["interruption_reason"], "short_page_before_announced_total")

    def test_openalex_retries_transient_failure_and_reports_attempts(self):
        config = self.openalex_config()
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            side_effect=[
                collector.urllib.error.URLError("temporary"),
                self.openalex_response([self.openalex_work("10.1234/a")], 1),
            ],
        ), mock.patch.object(collector.time, "sleep"):
            items = collector.collect_openalex(config, None, metrics)

        self.assertEqual(len(items), 1)
        self.assertEqual(metrics[0]["attempts"], 2)
        self.assertEqual(metrics[0]["retries"], 1)
        self.assertEqual(metrics[0]["transient_failures"], 1)
        self.assertEqual(metrics[0]["requests_succeeded"], 1)
        self.assertEqual(metrics[0]["collection_status"], "complete")

    def test_openalex_persistent_failure_and_invalid_response_are_reported(self):
        config = self.openalex_config()
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            side_effect=collector.urllib.error.URLError("offline"),
        ), mock.patch.object(collector.time, "sleep"):
            self.assertEqual(collector.collect_openalex(config, None, metrics), [])
        self.assertEqual(metrics[0]["attempts"], 2)
        self.assertEqual(metrics[0]["transient_failures"], 2)
        self.assertEqual(metrics[0]["collection_status"], "failed")

        metrics = []
        with mock.patch.object(collector, "fetch_json", return_value={"unexpected": []}):
            self.assertEqual(collector.collect_openalex(config, None, metrics), [])
        self.assertEqual(metrics[0]["collection_status"], "failed")
        self.assertEqual(metrics[0]["interruption_reason"], "ValueError")
        self.assertEqual(metrics[0]["permanent_failures"], 1)

        metrics = []
        not_found = collector.urllib.error.HTTPError(
            "https://api.openalex.org/works", 404, "not found", {}, None
        )
        with mock.patch.object(collector, "fetch_json", side_effect=not_found), mock.patch.object(
            collector.time, "sleep"
        ) as sleep:
            collector.collect_openalex(config, None, metrics)
        self.assertEqual(metrics[0]["attempts"], 1)
        self.assertEqual(metrics[0]["permanent_failures"], 1)
        self.assertEqual(metrics[0]["transient_failures"], 0)
        sleep.assert_not_called()

    def test_openalex_page_limit_and_later_page_failure_preserve_partial_results(self):
        config = self.openalex_config(openalex_max_pages_per_query=1)
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            return_value=self.openalex_response([
                self.openalex_work("10.1234/a"),
                self.openalex_work("10.1234/b"),
            ], 5),
        ):
            items = collector.collect_openalex(config, None, metrics)
        self.assertEqual(len(items), 2)
        self.assertEqual(metrics[0]["collection_status"], "partial")
        self.assertTrue(metrics[0]["limit_reached"])
        self.assertEqual(metrics[0]["interruption_reason"], "configured_page_limit")

        config = self.openalex_config()
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            side_effect=[
                self.openalex_response([
                    self.openalex_work("10.1234/a"),
                    self.openalex_work("10.1234/b"),
                ], 5),
                collector.urllib.error.URLError("offline"),
                collector.urllib.error.URLError("offline"),
            ],
        ), mock.patch.object(collector.time, "sleep"):
            items = collector.collect_openalex(config, None, metrics)
        self.assertEqual(len(items), 2)
        self.assertEqual(metrics[0]["collection_status"], "partial")
        self.assertEqual(metrics[0]["raw_results"], 2)
        self.assertEqual(metrics[0]["interruption_reason"], "falha de conexão: str")

    def test_source_queries_respect_configured_request_interval(self):
        config = self.openalex_config(request_interval_seconds=0.5)
        config["openalex_queries"] = ["query one", "query two"]
        with mock.patch.object(
            collector, "fetch_json",
            return_value=self.openalex_response([], 0),
        ), mock.patch.object(collector.time, "sleep") as sleep:
            collector.collect_openalex(config, None, [])
        sleep.assert_called_once_with(0.5)

        config = self.openalex_config(request_interval_seconds=0.5)
        config["crossref_queries"] = ["query one", "query two"]
        with mock.patch.object(
            collector, "fetch_json",
            return_value=self.crossref_response([], 0),
        ), mock.patch.object(collector.time, "sleep") as sleep:
            collector.collect_crossref(config, [])
        sleep.assert_called_once_with(0.5)

    def test_crossref_cursor_pagination_duplicates_and_metadata(self):
        config = self.openalex_config()
        metrics = []
        pages = [
            self.crossref_response([
                self.crossref_record("10.2345/one"),
                self.crossref_record("10.2345/two"),
            ], 3, "cursor-next"),
            self.crossref_response([
                self.crossref_record("10.2345/two"),
            ], 3),
        ]
        with mock.patch.object(collector, "fetch_json", side_effect=pages) as fetch:
            items = collector.collect_crossref(config, metrics)

        self.assertEqual(len(items), 2)
        self.assertEqual(metrics[0]["raw_results"], 3)
        self.assertEqual(metrics[0]["valid_records"], 3)
        self.assertEqual(metrics[0]["duplicates"], 1)
        self.assertEqual(metrics[0]["unique_records"], 2)
        self.assertEqual(metrics[0]["collection_status"], "complete")
        query_pages = [
            collector.urllib.parse.parse_qs(
                collector.urllib.parse.urlsplit(call.args[0]).query
            )
            for call in fetch.call_args_list
        ]
        self.assertEqual(query_pages[0]["cursor"], ["*"])
        self.assertEqual(query_pages[1]["cursor"], ["cursor-next"])
        self.assertEqual(items[0]["doi"], "10.2345/one")
        self.assertEqual(items[0]["keywords"], ["coastal ecology"])
        self.assertEqual(items[0]["authors"], ["Ada Silva"])

    def test_crossref_requests_author_and_journal_fields(self):
        config = self.openalex_config()
        metrics = []
        response = self.crossref_response([{
            **self.crossref_record("10.2345/journal"),
            "container-title": ["Journal of Coastal Ecology"],
            "author": [{"given": "Ana", "family": "Silva"}],
        }], 1)
        with mock.patch.object(collector, "fetch_json", return_value=response) as fetch:
            items = collector.collect_crossref(config, metrics)
        params = collector.urllib.parse.parse_qs(
            collector.urllib.parse.urlsplit(fetch.call_args.args[0]).query
        )
        self.assertIn("container-title", params["select"][0])
        self.assertIn("author", params["select"][0])
        self.assertEqual(items[0]["journal"], "Journal of Coastal Ecology")
        self.assertEqual(items[0]["authors"], ["Ana Silva"])

    def test_crossref_short_and_empty_pages_complete_normally(self):
        config = self.openalex_config()
        for response, expected_count in (
            (self.crossref_response([], 0), 0),
            (self.crossref_response([self.crossref_record("10.2345/one")], 1), 1),
        ):
            metrics = []
            with self.subTest(expected_count=expected_count), mock.patch.object(
                collector, "fetch_json", return_value=response
            ):
                items = collector.collect_crossref(config, metrics)
            self.assertEqual(len(items), expected_count)
            self.assertEqual(metrics[0]["collection_status"], "complete")
            self.assertEqual(metrics[0]["pages_consulted"], 1)

    def test_crossref_incomplete_page_or_missing_cursor_is_partial(self):
        config = self.openalex_config()
        cases = (
            (
                self.crossref_response([self.crossref_record("10.2345/short")], 3),
                "short_page_before_announced_total",
            ),
            (
                self.crossref_response([
                    self.crossref_record("10.2345/one"),
                    self.crossref_record("10.2345/two"),
                ], 5),
                "missing_cursor_before_announced_total",
            ),
        )
        for response, reason in cases:
            metrics = []
            with self.subTest(reason=reason), mock.patch.object(
                collector, "fetch_json", return_value=response
            ):
                collector.collect_crossref(config, metrics)
            self.assertEqual(metrics[0]["collection_status"], "partial")
            self.assertEqual(metrics[0]["interruption_reason"], reason)

    def test_crossref_announced_total_completes_without_following_repeated_cursor(self):
        config = self.openalex_config()
        metrics = []
        response = self.crossref_response([
            self.crossref_record("10.2345/one"),
            self.crossref_record("10.2345/two"),
        ], 2, "cursor-next")
        with mock.patch.object(
            collector, "fetch_json", return_value=response
        ) as fetch:
            collector.collect_crossref(config, metrics)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(metrics[0]["collection_status"], "complete")

    def test_crossref_retries_errors_and_records_partial_after_later_failure(self):
        config = self.openalex_config()
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            side_effect=[
                collector.urllib.error.HTTPError("https://api.crossref.org", 429, "limited", {"Retry-After": "0"}, None),
                self.crossref_response([
                    self.crossref_record("10.2345/one"),
                    self.crossref_record("10.2345/two"),
                ], 4, "cursor-next"),
                collector.urllib.error.URLError("offline"),
                collector.urllib.error.URLError("offline"),
            ],
        ), mock.patch.object(collector.time, "sleep"):
            items = collector.collect_crossref(config, metrics)

        self.assertEqual(len(items), 2)
        self.assertEqual(metrics[0]["rate_limit_events"], 1)
        self.assertEqual(metrics[0]["retries"], 2)
        self.assertEqual(metrics[0]["collection_status"], "partial")
        self.assertEqual(metrics[0]["pages_consulted"], 1)
        self.assertEqual(metrics[0]["attempts"], 4)
        self.assertEqual(metrics[0]["resume_status"], "restart_required")

    def test_crossref_page_limit_and_repeated_cursor_are_partial(self):
        config = self.openalex_config(crossref_max_pages_per_query=1)
        metrics = []
        with mock.patch.object(
            collector, "fetch_json",
            return_value=self.crossref_response([
                self.crossref_record("10.2345/one"),
                self.crossref_record("10.2345/two"),
            ], 5, "cursor-next"),
        ):
            collector.collect_crossref(config, metrics)
        self.assertEqual(metrics[0]["collection_status"], "partial")
        self.assertEqual(metrics[0]["interruption_reason"], "configured_page_limit")
        self.assertTrue(metrics[0]["limit_reached"])

        config = self.openalex_config()
        metrics = []
        pages = [
            self.crossref_response([
                self.crossref_record("10.2345/one"),
                self.crossref_record("10.2345/two"),
            ], 5, "same-cursor"),
            self.crossref_response([
                self.crossref_record("10.2345/three"),
                self.crossref_record("10.2345/four"),
            ], 5, "same-cursor"),
        ]
        with mock.patch.object(collector, "fetch_json", side_effect=pages):
            collector.collect_crossref(config, metrics)
        self.assertEqual(metrics[0]["collection_status"], "partial")
        self.assertEqual(metrics[0]["interruption_reason"], "repeated_cursor")
        self.assertFalse(metrics[0]["limit_reached"])

    def test_openalex_extracts_primary_journal_name(self):
        config = self.openalex_config()
        work = self.openalex_work("10.1234/journal")
        work["primary_location"] = {
            "landing_page_url": "https://example.org/work",
            "source": {"display_name": "Marine Ecology"},
        }
        with mock.patch.object(
            collector, "fetch_json", return_value=self.openalex_response([work], 1)
        ):
            items = collector.collect_openalex(config, None, [])
        self.assertEqual(items[0]["journal"], "Marine Ecology")


class OaiContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temporary_directory.name) / "oai-state.json"
        self.addCleanup(self.temporary_directory.cleanup)
        self.state_patch = mock.patch.object(collector, "OAI_STATE_PATH", self.state_path)
        self.sleep_patch = mock.patch.object(collector.time, "sleep")
        self.state_patch.start()
        self.sleep_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.addCleanup(self.sleep_patch.stop)
        self.repository = {
            "name": "Teste OAI",
            "url": "https://repo.example/oai",
            "type": "repositorio",
        }
        self.config = {
            "oai_initial_lookback_days": 30,
            "oai_incremental_lookback_days": 21,
            "oai_max_pages_per_repository": 2,
            "oai_repositories": [self.repository],
            "pagination": {
                "retry_attempts": 2,
                "retry_base_seconds": 0,
                "retry_max_seconds": 0,
                "request_interval_seconds": 0,
                "oai_resume_max_age_days": 7,
            },
        }

    def record_xml(self, identifier, title):
        return (
            "<record><metadata><oai_dc>"
            f"<title>{title}</title><identifier>https://example.org/{identifier}</identifier>"
            "</oai_dc></metadata></record>"
        )

    def response_xml(self, records=(), token=None, token_attributes="", error=None):
        if error:
            payload = f'<error code="{error}">protocol error</error>'
        else:
            token_xml = (
                f"<resumptionToken {token_attributes}>{token}</resumptionToken>"
                if token is not None else ""
            )
            payload = "".join(records) + token_xml
            payload = f"<ListRecords>{payload}</ListRecords>"
        return f"<OAI-PMH>{payload}</OAI-PMH>".encode("utf-8")

    def state_entry(self, token, **overrides):
        entry = {
            "repository_name": self.repository["name"],
            "repository_url": self.repository["url"],
            "metadata_prefix": "oai_dc",
            "from_date": "2026-10-01",
            "resumption_token": token,
            "expiration_date": None,
            "updated_at": collector.utc_now(),
        }
        entry.update(overrides)
        return entry

    def collect(self, responses):
        metrics = []
        with mock.patch.object(collector, "request_bytes", side_effect=responses) as request:
            items = collector.collect_oai(self.config, None, metrics)
        return items, metrics[0], request

    def test_single_batch_and_empty_resumption_token_complete(self):
        self.assertFalse(self.state_path.exists())
        payload = self.response_xml([self.record_xml("one", "Conservação costeira")], token="")
        items, metric, _ = self.collect([payload])

        self.assertEqual(len(items), 1)
        self.assertEqual(metric["collection_status"], "complete")
        self.assertEqual(metric["raw_results"], 1)
        self.assertEqual(metric["unique_records"], 1)
        self.assertFalse(metric["resume_possible"])
        self.assertFalse(self.state_path.exists())

    def test_page_limit_persists_token_and_next_run_resumes_without_duplicate(self):
        self.config["oai_max_pages_per_repository"] = 1
        first, first_metric, _ = self.collect([
            self.response_xml(
                [self.record_xml("one", "Conservação costeira")],
                "opaque-token",
                'completeListSize="2"',
            )
        ])
        self.assertEqual(first_metric["collection_status"], "partial")
        self.assertEqual(first_metric["interruption_reason"], "configured_page_limit")
        self.assertTrue(first_metric["resume_possible"])
        self.assertEqual(first_metric["results_announced"], 2)
        self.assertTrue(self.state_path.exists())

        self.config["oai_max_pages_per_repository"] = 2
        second, second_metric, requests = self.collect([
            self.response_xml([self.record_xml("two", "Dunas costeiras")])
        ])
        self.assertEqual(second_metric["resume_status"], "completed")
        self.assertTrue(second_metric["resume_attempted"])
        request_params = collector.urllib.parse.parse_qs(
            collector.urllib.parse.urlsplit(requests.call_args.args[0]).query
        )
        self.assertEqual(request_params["resumptionToken"], ["opaque-token"])
        self.assertNotIn("from", request_params)
        merged, duplicates, added = collector.merge_items(first, second, "2026-10-21")
        self.assertEqual(len(merged), 2)
        self.assertEqual((duplicates, added), (0, 1))
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["repositories"], {})

    def test_failure_after_first_page_keeps_results_and_persisted_continuation(self):
        responses = [
            self.response_xml(
                [self.record_xml("one", "Conservação costeira")],
                "retry-token",
            ),
            collector.urllib.error.HTTPError("https://repo.example/oai", 503, "unavailable", {}, None),
            collector.urllib.error.HTTPError("https://repo.example/oai", 503, "unavailable", {}, None),
        ]
        items, metric, _ = self.collect(responses)
        self.assertEqual(len(items), 1)
        self.assertEqual(metric["collection_status"], "partial")
        self.assertEqual(metric["raw_results"], 1)
        self.assertTrue(metric["resume_possible"])
        self.assertEqual(metric["attempts"], 3)
        self.assertEqual(metric["retries"], 1)
        self.assertNotIn("retry-token", json.dumps(metric))
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(
            next(iter(state["repositories"].values()))["resumption_token"],
            "retry-token",
        )

    def test_bad_token_restarts_original_window_once(self):
        state = {
            "schema_version": 1,
            "repositories": {
                collector.oai_repository_state_id(self.repository):
                    self.state_entry("expired-token")
            },
        }
        collector.save_oai_state(state)
        page = self.response_xml([self.record_xml("one", "Lagoa costeira")])
        items, metric, request = self.collect([
            self.response_xml(error="badResumptionToken"),
            page,
        ])

        self.assertEqual(len(items), 1)
        self.assertEqual(metric["resume_status"], "completed")
        self.assertEqual(metric.get("restart_count"), 1)
        first = collector.urllib.parse.parse_qs(
            collector.urllib.parse.urlsplit(request.call_args_list[0].args[0]).query
        )
        restarted = collector.urllib.parse.parse_qs(
            collector.urllib.parse.urlsplit(request.call_args_list[1].args[0]).query
        )
        self.assertEqual(first["resumptionToken"], ["expired-token"])
        self.assertEqual(restarted["from"], ["2026-10-01"])
        self.assertNotIn("resumptionToken", restarted)
        self.assertEqual(
            json.loads(self.state_path.read_text(encoding="utf-8"))["repositories"],
            {},
        )

    def test_failed_restart_does_not_restore_an_invalid_token(self):
        state = {
            "schema_version": 1,
            "repositories": {
                collector.oai_repository_state_id(self.repository):
                    self.state_entry("expired-token")
            },
        }
        collector.save_oai_state(state)
        items, metric, _ = self.collect([
            self.response_xml(error="badResumptionToken"),
            self.response_xml(error="badArgument"),
        ])
        self.assertEqual(items, [])
        self.assertEqual(metric["collection_status"], "failed")
        self.assertEqual(
            json.loads(self.state_path.read_text(encoding="utf-8"))["repositories"],
            {},
        )

    def test_stale_token_is_discarded_and_collection_restarts(self):
        state = {
            "schema_version": 1,
            "repositories": {
                collector.oai_repository_state_id(self.repository): {
                    **self.state_entry(
                        "stale-token",
                        updated_at="2020-01-01T00:00:00+00:00",
                    ),
                }
            },
        }
        collector.save_oai_state(state)
        _, metric, request = self.collect([
            self.response_xml([self.record_xml("one", "Lagoa costeira")])
        ])
        params = collector.urllib.parse.parse_qs(
            collector.urllib.parse.urlsplit(request.call_args.args[0]).query
        )
        self.assertEqual(metric["resume_status"], "completed")
        self.assertFalse(metric["resume_attempted"])
        self.assertIn("from", params)
        self.assertNotIn("resumptionToken", params)

    def test_duplicate_records_across_batches_are_counted(self):
        first, metric, _ = self.collect([
            self.response_xml(
                [self.record_xml("same", "Conservação costeira")],
                "next-token",
            ),
            self.response_xml([self.record_xml("same", "Conservação costeira")]),
        ])
        self.assertEqual(len(first), 1)
        self.assertEqual(metric["raw_results"], 2)
        self.assertEqual(metric["valid_records"], 2)
        self.assertEqual(metric["unique_records"], 1)
        self.assertEqual(metric["duplicates"], 1)

    def test_token_without_timestamp_is_only_resumable_within_configured_age(self):
        entry = {
            "resumption_token": "token",
            "updated_at": "2026-10-21T00:00:00+00:00",
        }
        self.assertTrue(collector.oai_state_is_fresh(entry, 7))
        self.assertFalse(collector.oai_state_is_fresh(
            {"resumption_token": "token", "updated_at": "invalid"}, 7
        ))
        future = (collector.dt.datetime.now(collector.dt.timezone.utc) + collector.dt.timedelta(days=1))
        self.assertFalse(collector.oai_state_is_fresh({
            "resumption_token": "token",
            "updated_at": future.isoformat(),
        }, 7))

    def test_invalid_state_entries_are_ignored_without_losing_valid_entries(self):
        valid_id = collector.oai_repository_state_id(self.repository)
        state = {
            "schema_version": 1,
            "updated_at": collector.utc_now(),
            "repositories": {
                valid_id: self.state_entry("valid-token"),
                "invalid": self.state_entry("invalid-token"),
            },
        }
        collector.save_oai_state(state | {
            "repositories": {valid_id: self.state_entry("valid-token")}
        })
        raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        raw["repositories"]["invalid"] = self.state_entry("invalid-token")
        self.state_path.write_text(json.dumps(raw), encoding="utf-8")

        loaded = collector.load_oai_state()
        self.assertEqual(list(loaded["repositories"]), [valid_id])
        self.assertEqual(
            loaded["repositories"][valid_id]["resumption_token"],
            "valid-token",
        )

    def test_atomic_state_write_failure_preserves_previous_file(self):
        state = {
            "schema_version": 1,
            "repositories": {
                collector.oai_repository_state_id(self.repository):
                    self.state_entry("original-token")
            },
        }
        collector.save_oai_state(state)
        original_bytes = self.state_path.read_bytes()
        replacement = {
            "schema_version": 1,
            "repositories": {
                collector.oai_repository_state_id(self.repository):
                    self.state_entry("replacement-token")
            },
        }
        with mock.patch.object(collector.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                collector.save_oai_state(replacement)
        self.assertEqual(self.state_path.read_bytes(), original_bytes)
        self.assertEqual(
            list(self.state_path.parent.glob(self.state_path.name + ".*.tmp")),
            [],
        )

    def test_invalid_state_is_rejected_before_it_can_replace_file(self):
        original = {
            "schema_version": 1,
            "repositories": {
                collector.oai_repository_state_id(self.repository):
                    self.state_entry("original-token")
            },
        }
        collector.save_oai_state(original)
        original_bytes = self.state_path.read_bytes()
        invalid = {
            "schema_version": 1,
            "repositories": {"invalid-id": self.state_entry("bad-token")},
        }
        with self.assertRaises(ValueError):
            collector.save_oai_state(invalid)
        self.assertEqual(self.state_path.read_bytes(), original_bytes)


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (
            ROOT / ".github" / "workflows" / "atualizar-noticias.yml"
        ).read_text(encoding="utf-8")

    def test_workflow_serializes_runs_and_always_uploads_diagnostics(self):
        self.assertIn("concurrency:", self.workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)
        self.assertIn("if: always()", self.workflow)
        self.assertIn("Preparar estado do relatório", self.workflow)
        self.assertIn("Armazenar métricas da coleta", self.workflow)
        self.assertIn("upload-artifact@v4", self.workflow)
        self.assertIn('f"diagnosticos/coletas/coleta-{run_id}-*.json"', self.workflow)
        self.assertIn('f"diagnosticos/coletas/workflow-{run_id}.json"', self.workflow)
        self.assertIn("collector_outcome", self.workflow)

    def test_workflow_persists_state_and_only_publishes_collector_validated_data(self):
        self.assertIn(
            "git add -- .github/state/noticias-oai-continuations.json",
            self.workflow,
        )
        self.assertIn('if [[ -f .github/state/noticias-oai-continuations.json ]]', self.workflow)
        self.assertIn('if [[ "$DATA_WRITTEN" == "true" && -f dados/noticias-publicacoes.json ]]', self.workflow)
        self.assertIn("git add -- dados/noticias-publicacoes.json", self.workflow)
        self.assertIn('git push origin "HEAD:${BRANCH}"', self.workflow)
        self.assertNotIn("--force", self.workflow)
        self.assertNotIn("OPENALEX_API_KEY", self.workflow)


if __name__ == "__main__":
    unittest.main()
