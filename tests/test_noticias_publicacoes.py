import importlib.util
import gzip
import json
import unittest
from pathlib import Path


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

    def test_existing_item_reclassification_is_detected_as_json_change(self):
        item = self.item("Qualidade da água no Rio Tubarão")
        original = json.loads(json.dumps(item))
        collector.classify(item, self.config)
        self.assertTrue(collector.items_changed([original], [item]))


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


if __name__ == "__main__":
    unittest.main()
