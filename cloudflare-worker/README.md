# Formulário público → Cloudflare Worker → SharePoint

## 1. Preparar Microsoft Entra e SharePoint

1. No portal Microsoft Entra, registre uma aplicação de uso único para este formulário.
2. Em **API permissions > Microsoft Graph > Application permissions**, solicite `Sites.Selected` e peça ao administrador para conceder consentimento.
3. O administrador deve conceder permissão `write` desta aplicação apenas ao site `apabf2`. Não use `Sites.ReadWrite.All` em produção.
4. Crie uma biblioteca/pasta de destino, por exemplo `DocumentosAutorizacao/Entradas-Autorizacao-Direta`.
5. Obtenha o `DRIVE_ID` da biblioteca e o `SITE_ID` do site no Graph Explorer ou via Microsoft Graph.
6. Em **Certificates & secrets**, crie um segredo de cliente. Copie seu valor agora: ele não poderá ser visto depois.

## 2. Criar e publicar o Worker

1. Instale o Wrangler (`npm install -g wrangler`) e autentique-se com `wrangler login`.
2. Ajuste `ALLOWED_ORIGIN` em `wrangler.toml` para o domínio exato onde o formulário será publicado. Não use `*`.
3. Dentro desta pasta, cadastre os segredos (um comando por segredo):

   ```powershell
   wrangler secret put TENANT_ID
   wrangler secret put CLIENT_ID
   wrangler secret put CLIENT_SECRET
   wrangler secret put SITE_ID
   wrangler secret put DRIVE_ID
   ```

4. Publique com `wrangler deploy`.
5. Copie a URL devolvida, por exemplo `https://apabf-formulario.seu-subdominio.workers.dev`.

## 3. Ligar o formulário

Em `../autorizacao-direta.html`, substitua `https://SEU-WORKER.seu-subdominio.workers.dev/api/formulario` pela URL publicada, seguida de `/api/formulario`.

## Comportamento e limites

- O Worker aceita campos e anexos em `multipart/form-data`.
- Cada solicitação cria uma pasta `AUT-AAAAMMDD-XXXXXXXX` e grava `formulario.json` junto aos anexos.
- O limite agregado é 90 MB para preservar margem abaixo do teto de 100 MB do Cloudflare gratuito.
- O Worker valida campos obrigatórios, quantidade, tamanho total e extensões permitidas. A validação no navegador é apenas uma conveniência; a validação do Worker é a que protege o serviço.
- O arquivo `.dev.vars` e qualquer segredo não devem ser versionados.
