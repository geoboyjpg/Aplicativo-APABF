# Desafio 360° da APABF

## Teste local

Na pasta raiz do aplicativo, inicie um servidor estático, por exemplo:

```powershell
python -m http.server 8000
```

Abra `http://localhost:8000/desafio-360.html`. O primeiro desafio carrega `fotos_360/DJI_0222-web.jpg` com Pannellum; Porto de Imbituba e Dunas da Ribanceira ainda não têm imagens locais cadastradas e exibem um aviso e link de referência no Google Maps. O mapa Leaflet, os tiles do OpenStreetMap e os arquivos CSS/JavaScript do Pannellum via jsDelivr precisam de conexão com a internet. Não é necessária uma chave da API do Google Maps.

## Panorama local

O arquivo original `fotos_360/DJI_0222.JPG` é uma imagem JPEG de 14.400 × 7.200 pixels (proporção 2:1), compatível com panorama equiretangular. Ele foi preservado. Para reduzir a transferência e memória em celulares, o jogo utiliza a cópia web otimizada `fotos_360/DJI_0222-web.jpg` (8.192 × 4.096 pixels).

Para adicionar novas fotografias:

1. Coloque o arquivo panorâmico dentro de `fotos_360/`, preferencialmente equiretangular 2:1 em JPEG, com dimensões e tamanho adequados para publicação web. Preserve o original e, se necessário, gere uma versão otimizada para navegadores.
2. No registro correspondente em `dados/desafio-360-locais.js`, defina `panoramaPath` com o caminho relativo a partir da raiz do site, por exemplo `fotos_360/nova-foto-web.jpg`. Caminhos relativos funcionam em publicação GitHub Pages sob subdiretório.
3. Configure `latitude`, `longitude`, `panoramaYaw` e `panoramaPitch`, além do nome, informações educativas, fontes e `panoramaUrl` externo. Use `panoramaPath: null` quando não houver fotografia local; não atribua imagem de outro cenário.
4. Verifique a imagem em um servidor HTTP estático; o Pannellum e os controles de zoom/carregamento são servidos pelo CDN jsDelivr e dependem de conexão.

O primeiro desafio usa como resposta exatamente latitude `-28.255493` e longitude `-48.678423`. Sua descrição se limita à paisagem visível; relações ambientais ou históricas específicas permanecem pendentes de validação. Os demais locais continuam com coordenadas e conteúdo cadastrado, e usam fallback externo até receberem fotografias próprias.

## Pontuação e fontes

A pontuação de cada rodada é `arredondar(5.000 × max(0, 1 − distância_em_metros / 20.000))`, limitada entre zero e 5.000 pontos. A distância é calculada pela fórmula de Haversine; a faixa de 20 km foi escolhida para a escala regional dos três pontos iniciais.

Os textos educativos e links de referência de cada local estão em `dados/desafio-360-locais.js`. Para as Dunas da Ribanceira, a página [Sobre a APA](sobre-apa.html) registra os butiazais das dunas da Ribanceira na Zona de Uso Restrito. Para os outros pontos, a relação local específica com o zoneamento e os dados históricos/ambientais estão identificados como pendentes de validação, sem presumir classificação patrimonial.

O mapa do palpite usa Leaflet e tiles do OpenStreetMap, com atribuição exibida no próprio mapa; ambos dependem de serviços externos. O cenário local é servido a partir dos arquivos deste projeto. Não são extraídas nem armazenadas imagens do Google Maps.
