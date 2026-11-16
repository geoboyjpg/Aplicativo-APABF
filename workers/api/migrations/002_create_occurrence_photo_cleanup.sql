CREATE TABLE IF NOT EXISTS public.ocorrencias_trilhas_fotografias_cleanup (
  cleanup_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ocorrencia_id text NOT NULL,
  arquivo text NOT NULL UNIQUE,
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro text,
  data_criacao timestamptz NOT NULL DEFAULT now(),
  ultima_tentativa timestamptz
);

CREATE INDEX IF NOT EXISTS ocorrencias_trilhas_fotografias_cleanup_ocorrencia_idx
  ON public.ocorrencias_trilhas_fotografias_cleanup (ocorrencia_id);
