-- Rotina: checa os @ 1x por dia (10:13 UTC = 07:13 em Fortaleza) e baixa a fila a cada 5 minutos.
select cron.schedule('baixador-checar', '13 10 * * *', $$
  select net.http_post(
    url := 'https://nohwejlxdnjsjmsnmftv.supabase.co/functions/v1/baixador',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('acao','cron_checar','secret',(select cron_secret from public.bx_config where id = 1)),
    timeout_milliseconds := 150000)
$$);
select cron.schedule('baixador-processar', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://nohwejlxdnjsjmsnmftv.supabase.co/functions/v1/baixador',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('acao','cron_processar','secret',(select cron_secret from public.bx_config where id = 1)),
    timeout_milliseconds := 150000)
$$);
