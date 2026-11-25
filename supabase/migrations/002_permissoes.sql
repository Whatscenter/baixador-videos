-- Projetos novos do Supabase não dão acesso automático às tabelas novas: libera só para a função do servidor.
grant select, insert, update, delete on public.bx_perfis, public.bx_posts, public.bx_config to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke truncate, references, trigger on public.bx_perfis, public.bx_posts, public.bx_config from anon, authenticated;

update public.bx_config set dias_guardar = 7, max_por_perfil = 6 where id = 1;

create or replace function public.bx_uso() returns bigint language sql security definer set search_path = '' as $$
  select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects where bucket_id = 'baixador'
$$;
revoke all on function public.bx_uso() from public, anon, authenticated;
grant execute on function public.bx_uso() to service_role;
