-- Baixador de vídeos (Compre na Fronteira) — tabelas com prefixo bx_ para não misturar com o Superlime
create extension if not exists pgcrypto;

create table if not exists public.bx_perfis (
  id bigint generated always as identity primary key,
  plataforma text not null default 'instagram',
  usuario text not null,
  user_id text,
  ativo boolean not null default true,
  ultima_checagem timestamptz,
  ultimo_erro text,
  criado_em timestamptz not null default now(),
  unique (plataforma, usuario)
);

create table if not exists public.bx_posts (
  id bigint generated always as identity primary key,
  perfil_id bigint references public.bx_perfis(id) on delete set null,
  plataforma text not null default 'instagram',
  post_id text not null,
  url text,
  autor text,
  legenda text,
  views bigint,
  likes bigint,
  publicado_em timestamptz,
  video_origem text,
  thumb_origem text,
  arquivo text,
  thumb text,
  status text not null default 'pendente', -- pendente | baixado | erro | apagado
  tentativas int not null default 0,
  erro text,
  guardar boolean not null default false,
  postado boolean not null default false,
  criado_em timestamptz not null default now(),
  unique (plataforma, post_id)
);
create index if not exists bx_posts_status_idx on public.bx_posts (status);
create index if not exists bx_posts_criado_idx on public.bx_posts (criado_em desc);

create table if not exists public.bx_config (
  id int primary key default 1 check (id = 1),
  cron_secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  dias_guardar int not null default 15,
  max_por_perfil int not null default 12,
  debug jsonb
);
insert into public.bx_config (id) values (1) on conflict do nothing;

-- Tudo fechado: só as funções do servidor (service role) leem e escrevem.
alter table public.bx_perfis enable row level security;
alter table public.bx_posts enable row level security;
alter table public.bx_config enable row level security;

-- Pasta privada para os vídeos (até 100 MB por arquivo)
insert into storage.buckets (id, name, public, file_size_limit)
values ('baixador', 'baixador', false, 104857600)
on conflict (id) do nothing;
