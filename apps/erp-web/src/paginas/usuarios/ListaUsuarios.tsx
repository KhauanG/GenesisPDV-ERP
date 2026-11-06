import type { Pagina, PerfilResumo, UsuarioResumo } from '@genesis/shared';
import { Anchor, Badge } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { formatarDataHora } from '../../util/formato';

export const ROTA_USUARIOS = '/cadastros/usuarios';

export function usePerfis() {
  const pode = usePode();
  return useQuery({
    queryKey: ['perfis', 'todos'],
    queryFn: () => apiErp.get<Pagina<PerfilResumo>>('/perfis?tamanho=todos'),
    enabled: pode('perfis.ver'),
    staleTime: 60_000,
  });
}

/** Usuários – listagem (ERP 11.1). */
export function ListaUsuarios() {
  const eu = useEu();
  const perfis = usePerfis();

  const config = useMemo<ConfigListagem<UsuarioResumo>>(
    () => ({
      recurso: 'usuarios',
      titulo: 'Usuários',
      ordenacaoPadrao: 'nome:asc',
      rotaNovo: `${ROTA_USUARIOS}/novo`,
      rotuloNovo: 'Novo usuário',
      rotaEdicao: (u) => `${ROTA_USUARIOS}/${u.id}`,
      chaveLinha: (u) => u.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto', placeholder: 'Nome, login ou código' },
        {
          campo: 'situacao',
          rotulo: 'Situação',
          tipo: 'selecao',
          padrao: 'ativos',
          opcoes: [
            { value: 'ativos', label: 'Ativos' },
            { value: 'inativos', label: 'Inativos' },
            { value: 'todos', label: 'Todos' },
          ],
        },
        {
          campo: 'perfilId',
          rotulo: 'Perfil',
          tipo: 'selecao',
          opcoes: (perfis.data?.itens ?? []).map((p) => ({ value: p.id, label: p.nome })),
        },
        {
          campo: 'lojaId',
          rotulo: 'Loja',
          tipo: 'loja',
          placeholder: 'Todas as lojas',
          opcoes: eu.lojas.map((l) => ({ value: l.id, label: `${l.codigo} - ${l.nome}` })),
        },
      ],
      colunas: [
        { campo: 'codigo', rotulo: 'Cód.', ordenavel: true, largura: 90 },
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (u) => (
            <Anchor component={Link} to={`${ROTA_USUARIOS}/${u.id}`} c="inherit">
              {u.nome}
            </Anchor>
          ),
        },
        { campo: 'login', rotulo: 'Login', ordenavel: true },
        {
          campo: 'perfilNome',
          campoOrdenacao: 'perfil',
          rotulo: 'Perfil',
          ordenavel: true,
          formato: (u) => (u.master ? <Badge variant="light">Master</Badge> : (u.perfilNome ?? '—')),
        },
        {
          campo: 'ultimoLoginEm',
          campoOrdenacao: 'ultimo_login_em',
          rotulo: 'Último acesso',
          ordenavel: true,
          formato: (u) => formatarDataHora(u.ultimoLoginEm),
        },
        {
          campo: 'ativo',
          rotulo: 'Ativo',
          ordenavel: true,
          alinhamento: 'center',
          largura: 90,
          formato: (u) => (
            <Badge color={u.ativo ? 'green' : 'gray'} variant="light">
              {u.ativo ? 'Sim' : 'Não'}
            </Badge>
          ),
        },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<UsuarioResumo>>(`/usuarios${query(params)}`, { sinal }),
      exportar: (params, formato) => apiErp.baixar(`/usuarios/exportar${query({ ...params, formato })}`),
    }),
    [eu.lojas, perfis.data],
  );

  return <Listagem config={config} />;
}
