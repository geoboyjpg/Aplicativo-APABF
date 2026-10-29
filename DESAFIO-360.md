# Desafio 360° da APABF

## Teste local

Na raiz do aplicativo, inicie um servidor estático:

```powershell
python -m http.server 8000
```

Abra `http://localhost:8000/desafio-360.html`. Ao carregar, o jogo sorteia um dos cenários com fotografia local cadastrada. Cada partida tem três rodadas aleatórias e não repete o cenário imediatamente quando há alternativas. **Nova localização** só avança depois de registrar a tentativa; se a fotografia falhar, é possível tentar novamente ou selecionar outro cenário sem pontuar a rodada. No fim, a tela resume os pontos e distâncias.

Pannellum 2.5.6, Leaflet e os mapas-base do OpenStreetMap são carregados externamente e precisam de conexão. Não é necessária chave da API do Google Maps. O mapa requer que a página seja servida via HTTP, não aberta como arquivo local.

## Cenários e imagens atuais

Os caminhos e dados dos locais estão em `dados/desafio-360-locais.js`. A seleção aleatória inclui somente registros com identificador, nome, caminho local com extensão de imagem reconhecida e coordenadas válidas. A imagem só é carregada quando o cenário é sorteado; arquivos com erro são retirados temporariamente da seleção desta sessão.

| Identificador | Nome | Arquivo em `fotos_360/` | Coordenadas (latitude, longitude) |
|---|---|---|---|
| `lagoa-paes-leme` | Lagoa do Paes Leme | `DJI_0222-web.jpg` | `-28.255493, -48.678423` |
| `arroio_corrente` | Arroio Corrente | `lagoa_arroio_corrente.jpg` | `-28.686896, -49.028741` |
| `sambaqui` | Sambaqui | `sambaqui.jpg` | `-28.625851, -48.892682` |
| `itapiruba_promontorio` | Promontório de Itapirubá | `itapiruba_promontorio.jpg` | `-28.3384457, -48.6974602` |
| `dunas_itapiruba` | Dunas de Itapirubá | `dunas-itapiruba.jpg` | `-28.313261, -48.7165489` |
| `praia_dagua` | Praia D’Água | `praia_dagua.jpg` | `-28.2148418, -48.6668129` |
| `dunas_riba` | Dunas da Ribanceira | `dunas_riba.jpg` | `-28.1855583, -48.6653938` |

O original `DJI_0222.JPG` foi preservado; o jogo utiliza a versão web `DJI_0222-web.jpg`. A foto `dunas_riba.jpg` atualiza a coordenada do registro existente das Dunas da Ribanceira, evitando duplicar a localidade. Porto de Imbituba continua cadastrado com sua coordenada e referência externa, mas não é sorteado até haver uma fotografia local apropriada.

As fotografias novas são JPEG equiretangulares, aproximadamente 2:1, compatíveis com o visualizador e verificadas no acervo. Autoria/fonte de fotografia não informada no cadastro é exibida como não informada. Não foram inventadas descrições educativas para os novos cenários; após a resposta, o jogo informa que dados específicos aguardam validação e cadastro de fontes. Para as Dunas da Ribanceira, a página [Sobre a APA](sobre-apa.html) registra a menção a butiazais na Zona de Uso Restrito.

## Adicionar uma localidade

1. Coloque a fotografia equiretangular 360° em `fotos_360/`. Prefira proporção 2:1 e dimensões/tamanho adequados para dispositivos móveis; preserve o original e crie uma versão otimizada separada se necessário.
2. Adicione um registro a `window.APABF_DESAFIO_360_LOCAIS` em `dados/desafio-360-locais.js`, com `id` único, `nome`, caminho relativo `panoramaPath` (por exemplo, `fotos_360/minha_foto.jpg`), latitude/longitude, orientação inicial opcional (`panoramaYaw` e `panoramaPitch`), descrição, importância, curiosidade, `autoriaFotografia`, `fonteFotografia`, `fontes` e `panoramaUrl`.
3. Use `null` como caminho para cenários sem foto. Eles permanecem cadastrados como referência, mas não entram no sorteio. Preencha textos e fontes apenas com informação verificada.
4. Confirme se caminho e nome correspondem exatamente ao arquivo (inclusive maiúsculas/minúsculas) e abra o cenário através de um servidor HTTP. O caminho relativo à raiz também funciona sob o subdiretório de publicação do GitHub Pages.

## Regras e mapa

A pontuação é `arredondar(5.000 × max(0, 1 − distância_em_metros / 20.000))`, limitada entre zero e 5.000 pontos por rodada. A distância usa a fórmula de Haversine. O mapa Leaflet aparece inicialmente compacto; **Ampliar mapa** abre um diálogo acessível e mantém o marcador e a tentativa ao retornar.

O mapa usa tiles do OpenStreetMap, com atribuição exibida. Os tiles e o CDN do Pannellum dependem de rede. Localizações ainda precisam de conferência de campo/documental onde isso estiver indicado no conteúdo.
