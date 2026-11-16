DO $migration$
DECLARE
  occurrence_id_type text;
BEGIN
  SELECT format_type(attribute.atttypid, attribute.atttypmod)
  INTO occurrence_id_type
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.ocorrencias_trilhas'::regclass
    AND attribute.attname = 'ocorrencia_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF occurrence_id_type IS NULL THEN
    RAISE EXCEPTION 'public.ocorrencias_trilhas.ocorrencia_id was not found';
  END IF;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.ocorrencias_trilhas_fotografias (
      foto_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ocorrencia_id %s NOT NULL REFERENCES public.ocorrencias_trilhas (ocorrencia_id) ON DELETE CASCADE,
      arquivo text NOT NULL UNIQUE,
      miniatura text,
      miniatura_tipo_mime text CHECK (
        miniatura_tipo_mime IS NULL OR miniatura_tipo_mime IN (''image/jpeg'', ''image/png'', ''image/webp'')
      ),
      nome_original text NOT NULL,
      tipo_mime text NOT NULL CHECK (tipo_mime IN (''image/jpeg'', ''image/png'', ''image/webp'')),
      tamanho_bytes bigint NOT NULL CHECK (tamanho_bytes BETWEEN 1 AND 5242880),
      data_upload timestamptz NOT NULL DEFAULT now()
    )',
    occurrence_id_type
  );
END
$migration$;

CREATE INDEX IF NOT EXISTS ocorrencias_trilhas_fotografias_ocorrencia_idx
  ON public.ocorrencias_trilhas_fotografias (ocorrencia_id);
