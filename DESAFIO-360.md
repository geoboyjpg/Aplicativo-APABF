# Desafio 360° da APABF

## Teste local

Na pasta raiz do aplicativo, inicie um servidor estático, por exemplo:

```powershell
python -m http.server 8000
```

Abra `http://localhost:8000/desafio-360.html`. O mapa Leaflet e os mapas-base do OpenStreetMap precisam de conexão com a internet. Sem configurar a API do Google, a rodada continua permitindo palpites e pontuação; o panorama fica claramente indisponível e há um link para abrir o panorama de referência diretamente no Google Maps.

## Configuração do Street View

1. Crie ou selecione um projeto no [Google Cloud Console](https://console.cloud.google.com/).
2. Ative faturamento e habilite a **Maps JavaScript API** no projeto.
3. Crie uma chave de API para navegador e restrinja-a por HTTP referrer aos domínios realmente utilizados, como `localhost:8000/*` para desenvolvimento e `https://SEU-USUARIO.github.io/*` para o GitHub Pages. Restrinja também a chave à Maps JavaScript API e acompanhe os limites e custos no Google Cloud.
4. Insira a chave pública restrita em `config/desafio-360.js`, no campo `googleMapsApiKey`.

A chave de navegador fica visível ao público, como é esperado para uso client-side; não use uma chave privada ou sem restrições. A API oficial renderiza o Street View com os créditos e controles do Google. Se um panorama específico não estiver disponível pela API, o jogo mostra uma mensagem e mantém o link para a referência no Google Maps.

## Pontuação e referências

A pontuação de cada rodada é `arredondar(5.000 × max(0, 1 − distância_em_metros / 20.000))`, limitada entre zero e 5.000 pontos. A distância é calculada pela fórmula de Haversine; a faixa de 20 km foi escolhida para a escala regional dos três pontos iniciais.

As coordenadas foram transcritas dos links fornecidos e ainda não foram validadas como posições exatas das câmeras nem como resposta pretendida. Essa ressalva também é exibida após a revelação. Os textos educativos e links de referência de cada local estão em `dados/desafio-360-locais.js`. Para as Dunas da Ribanceira, a página [Sobre a APA](sobre-apa.html) registra os butiazais das dunas da Ribanceira na Zona de Uso Restrito. Para os outros pontos, a relação local específica com o zoneamento e os dados históricos/ambientais estão identificados como pendentes de validação, sem presumir classificação patrimonial.

O mapa do palpite usa Leaflet e tiles do OpenStreetMap, com atribuição exibida no próprio mapa; ambos dependem de serviços externos. Nenhum panorama ou imagem do Google é copiado ou armazenado pelo aplicativo.
