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
