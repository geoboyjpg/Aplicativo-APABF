/**
 * Recebe o formulário público e grava cada submissão em uma pasta do SharePoint.
 * Segredos ficam exclusivamente no Cloudflare Worker (env.CLIENT_SECRET).
 */

const MAX_TOTAL_BYTES = 90 * 1024 * 1024;
const ALLOWED_FILES = {
  mapa: { maxFiles: 5, maxSize: 90 * 1024 * 1024 },
  copia_cpf: { maxFiles: 1, maxSize: 10 * 1024 * 1024 },
  copia_rg: { maxFiles: 1, maxSize: 10 * 1024 * 1024 },
  oficio: { maxFiles: 2, maxSize: 10 * 1024 * 1024 },
  demais_arquivos: { maxFiles: 10, maxSize: 90 * 1024 * 1024 },
};

const ALLOWED_EXTENSIONS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
  'jpg', 'jpeg', 'png', 'gif', 'mp4', 'mp3',
]);

const REQUIRED_FIELDS = [
  'cpf_cnpj_solicitante', 'nome_solicitante', 'endereco_solicitante',
  'telefone_solicitante', 'email_solicitante', 'objetivo', 'data_inicio',
  'data_fim', 'descricao_minuciosa', 'infraestrutura', 'impactos', 'mitigacao',
  'data_nascimento', 'rg_responsavel',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const corsHeaders = getCorsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/formulario') {
      return json({ success: false, error: 'Rota não encontrada.' }, 404, corsHeaders);
    }
    if (!origin || origin !== env.ALLOWED_ORIGIN) {
      return json({ success: false, error: 'Origem não autorizada.' }, 403, corsHeaders);
    }
    if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data')) {
      return json({ success: false, error: 'Envie os dados como multipart/form-data.' }, 415, corsHeaders);
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > MAX_TOTAL_BYTES) {
      return json({ success: false, error: 'O total de anexos excede 90 MB.' }, 413, corsHeaders);
    }

    try {
      assertConfiguration(env);
      const formData = await request.formData();
      const submission = parseSubmission(formData);
      validateSubmission(submission);

      const requestId = createRequestId();
      const token = await getGraphToken(env);
      const rootFolder = sanitizePathPart(env.SHAREPOINT_ROOT_FOLDER || 'Entradas-Autorizacao-Direta');
      const parentId = await ensureFolderPath(env.DRIVE_ID, rootFolder, token);
      const folderId = await createFolder(env.DRIVE_ID, parentId, requestId, token);

      const metadata = {
        requestId,
        submittedAt: submission.submittedAt,
        fields: submission.fields,
        attachments: submission.files.map(({ field, file }) => ({
          field,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
        })),
      };

      await uploadTextFile(env.DRIVE_ID, folderId, 'formulario.json', JSON.stringify(metadata, null, 2), token);
      for (const [index, attachment] of submission.files.entries()) {
        const fileName = `${attachment.field}-${index + 1}-${sanitizeFileName(attachment.file.name)}`;
        await uploadFile(env.DRIVE_ID, folderId, fileName, attachment.file, token);
      }

      return json({ success: true, requestId }, 201, corsHeaders);
    } catch (error) {
      console.error('Falha no formulário:', error instanceof Error ? error.message : 'erro desconhecido');
      const status = error instanceof ValidationError ? 400 : 502;
      const message = error instanceof ValidationError
        ? error.message
        : 'Não foi possível registrar a solicitação. Tente novamente mais tarde.';
      return json({ success: false, error: message }, status, corsHeaders);
    }
  },
};

function parseSubmission(formData) {
  const fields = {};
  const files = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') fields[key] = value.trim();
    else files.push({ field: key.replace(/\[\]$/, ''), file: value });
  }
  return { fields, files, submittedAt: fields.submittedAt || new Date().toISOString() };
}

function validateSubmission(submission) {
  for (const field of REQUIRED_FIELDS) {
    if (!submission.fields[field]) throw new ValidationError(`Preencha o campo obrigatório: ${field}.`);
  }
  const fileCounts = {};
  let totalBytes = 0;
  for (const { field, file } of submission.files) {
    const rules = ALLOWED_FILES[field];
    if (!rules) throw new ValidationError('Campo de anexo não permitido.');
    fileCounts[field] = (fileCounts[field] || 0) + 1;
    if (fileCounts[field] > rules.maxFiles) throw new ValidationError(`Quantidade inválida de arquivos em ${field}.`);
    if (!file.name || file.size === 0 || file.size > rules.maxSize) throw new ValidationError(`Tamanho inválido para ${file.name || 'anexo'}.`);
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !ALLOWED_EXTENSIONS.has(extension)) throw new ValidationError(`Tipo de arquivo não permitido: ${file.name}.`);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new ValidationError('O total de anexos excede 90 MB.');
  if (!fileCounts.mapa || !fileCounts.copia_cpf) throw new ValidationError('Anexe o mapa/croqui e a cópia do CPF ou CNPJ.');
}

async function getGraphToken(env) {
  const body = new URLSearchParams({
    client_id: env.CLIENT_ID,
    client_secret: env.CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('Não foi possível autenticar no Microsoft Graph.');
  return data.access_token;
}

async function ensureFolderPath(driveId, folderPath, token) {
  let parent = await graph(`/drives/${driveId}/root`, token);
  const parts = folderPath.split('/').filter(Boolean);
  for (const [index, part] of parts.entries()) {
    try {
      const currentPath = encodeGraphPath(parts.slice(0, index + 1).join('/'));
      parent = await graph(`/drives/${driveId}/root:/${currentPath}`, token);
    } catch (error) {
      if (error.status !== 404) throw error;
      parent = await createFolder(driveId, parent.id, part, token);
    }
  }
  return parent.id;
}

async function createFolder(driveId, parentId, name, token) {
  return graph(`/drives/${driveId}/items/${parentId}/children`, token, {
    method: 'POST',
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
}

async function uploadTextFile(driveId, parentId, name, text, token) {
  return uploadFile(driveId, parentId, name, new Blob([text], { type: 'application/json' }), token);
}

async function uploadFile(driveId, parentId, name, file, token) {
  return graph(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content`, token, {
    method: 'PUT', body: file.stream(), headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
}

async function graph(path, token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type') && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers });
  if (!response.ok) {
    const error = new Error(`Microsoft Graph retornou ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function createRequestId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `AUT-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}
function sanitizeFileName(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }
function sanitizePathPart(name) { return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Entradas-Autorizacao-Direta'; }
function encodeGraphPath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
function assertConfiguration(env) {
  for (const key of ['TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'DRIVE_ID']) {
    if (!env[key]) throw new Error(`Configuração ausente: ${key}.`);
  }
}
function getCorsHeaders(origin, allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? allowedOrigin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
class ValidationError extends Error {}
