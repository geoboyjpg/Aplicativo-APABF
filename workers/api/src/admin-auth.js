async function tokenMatches(candidate, expected) {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  const candidateBytes = new Uint8Array(candidateHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= candidateBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

export async function validateAdminRequest(request, env) {
  if (!env.OCCURRENCE_ADMIN_TOKEN) {
    return { status: 503, message: 'A autorização administrativa não está configurada.' };
  }
  if (!env.OCCURRENCE_ADMIN_LIMITER || typeof env.OCCURRENCE_ADMIN_LIMITER.limit !== 'function') {
    return { status: 503, message: 'A proteção das operações administrativas não está configurada.' };
  }

  try {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    const result = await env.OCCURRENCE_ADMIN_LIMITER.limit({ key });
    if (!result || !result.success) {
      return { status: 429, message: 'Muitas tentativas administrativas. Aguarde e tente novamente.' };
    }
  } catch {
    console.error('Falha ao verificar o limite de operações administrativas.');
    return { status: 503, message: 'Não foi possível verificar o acesso administrativo.' };
  }

  const authorization = request.headers.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(authorization);
  if (!match) {
    return { status: 401, message: 'Autorização administrativa necessária.' };
  }

  try {
    return await tokenMatches(match[1], env.OCCURRENCE_ADMIN_TOKEN)
      ? null
      : { status: 401, message: 'Autorização administrativa inválida.' };
  } catch {
    console.error('Falha ao validar a autorização administrativa.');
    return { status: 503, message: 'Não foi possível validar o acesso administrativo.' };
  }
}
