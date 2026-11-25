# Baixador CNF

App para acompanhar perfis do Instagram e baixar os reels novos automaticamente, com legenda, prontos para postar ou salvar no celular. Também baixa reels do Instagram e vídeos do Kwai por link.

- **Tela:** `index.html` (GitHub Pages). Funciona no celular e no computador.
- **Servidor:** Supabase (projeto `nohwejlxdnjsjmsnmftv`): função `baixador`, tabelas `bx_*`, pasta privada `baixador`.
- **Rotina:** checa os @ 1x por dia (07:13 em Fortaleza) e baixa a fila a cada 5 min. Vídeos se apagam após 7 dias, menos os marcados como "Guardar".
- **Dados do Instagram:** ScrapeCreators (1 crédito por @ por dia; 2 na primeira vez; 1 por link colado). Kwai por link é grátis.

## Segredos (Supabase > Edge Functions > Secrets)
| Nome | O que é |
|---|---|
| `SCRAPECREATORS_API_KEY` | chave da API do ScrapeCreators |
| (login) | e-mail e senha de uma conta da tabela `admins` do Supabase |

Nenhum segredo fica neste repositório. A chave `sb_publishable_...` no `index.html` é pública por natureza e não dá acesso às tabelas.

## Estrutura
```
index.html                          tela do app
supabase/functions/baixador/        função do servidor (Deno)
supabase/migrations/                tabelas, permissões e rotina
baixador-local/                     versão para rodar no computador (Python + yt-dlp)
```

## Ajustes
- Dias para guardar / vídeos na primeira checagem: `update bx_config set dias_guardar = 7, max_por_perfil = 6;`
- Horário da rotina: `select cron.alter_job((select jobid from cron.job where jobname='baixador-checar'), schedule := '13 10 * * *');`
