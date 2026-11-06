import { STATUS_EMPRESA, type EmpresaResumo, type Pagina, type StatusEmpresa } from '@genesis/shared';
import { Badge } from '@mantine/core';
import { useMemo } from 'react';
import { apiPlataforma } from '../api/clientes';
import { query } from '../api/http';
import { Listagem, type ConfigListagem } from '../componentes/listagem/Listagem';
import { formatarCnpj, formatarDataHora } from '../util/formato';
import { useSessaoPlataforma } from './sessao';

export const ROTULOS_STATUS: Record<StatusEmpresa, { rotulo: string; cor: string }> = {
  provisionando: { rotulo: 'Provisionando', cor: 'blue' },
  ativa: { rotulo: 'Ativa', cor: 'green' },
  migrando: { rotulo: 'Migrando', cor: 'orange' },
  suspensa: { rotulo: 'Suspensa', cor: 'red' },
  cancelada: { rotulo: 'Cancelada', cor: 'gray' },
};

type LinhaEmpresa = EmpresaResumo & { migracaoComFalha: boolean };

export function BadgeStatus({ status, falha }: { status: StatusEmpresa; falha?: boolean }) {
  const s = ROTULOS_STATUS[status];
  return (
    <>
      <Badge color={s.cor} variant="light">
        {s.rotulo}
      </Badge>
      {falha && (
        <Badge color="red" variant="outline" ml={4}>
          Falha
        </Badge>
      )}
    </>
  );
}

/** Painel › Empresas (ERP 19.2). */
export function Empresas() {
  const { temPapel } = useSessaoPlataforma();
  const podeCriar = temPapel('financeiro');
  const config = useMemo<ConfigListagem<LinhaEmpresa>>(
    () => ({
      recurso: 'plataforma_empresas',
      titulo: 'Empresas',
      ordenacaoPadrao: 'codigo:asc',
      rotaNovo: '/plataforma/empresas/nova',
      rotuloNovo: 'Nova empresa',
      permissaoNovo: podeCriar ? undefined : null,
      permissoesExportar: [],
      rotaEdicao: (e) => `/plataforma/empresas/${e.codigo}`,
      chaveLinha: (e) => e.id,
      filtros: [
        {
          campo: 'busca',
          rotulo: 'Busca',
          tipo: 'texto',
          placeholder: 'Código, razão social, fantasia ou CNPJ',
        },
        {
          campo: 'status',
          rotulo: 'Status',
          tipo: 'selecao',
          opcoes: STATUS_EMPRESA.map((s) => ({ value: s, label: ROTULOS_STATUS[s].rotulo })),
        },
      ],
      colunas: [
        { campo: 'codigo', rotulo: 'Código', largura: 100 },
        { campo: 'razaoSocial', rotulo: 'Razão social' },
        { campo: 'nomeFantasia', rotulo: 'Fantasia' },
        { campo: 'cnpj', rotulo: 'CNPJ', formato: (e) => formatarCnpj(e.cnpj) },
        {
          campo: 'status',
          rotulo: 'Status',
          formato: (e) => <BadgeStatus status={e.status} falha={e.migracaoComFalha} />,
        },
        { campo: 'plano', rotulo: 'Plano' },
        { campo: 'versaoSchema', rotulo: 'Versão do schema', formato: (e) => e.versaoSchema ?? '—' },
        { campo: 'criadoEm', rotulo: 'Criada em', formato: (e) => formatarDataHora(e.criadoEm) },
      ],
      buscar: (params, sinal) => {
        const { ordenar: _o, ...resto } = params;
        return apiPlataforma.get<Pagina<LinhaEmpresa>>(`/empresas${query(resto)}`, { sinal });
      },
    }),
    [podeCriar],
  );
  return <Listagem config={config} />;
}
