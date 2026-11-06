import type { UseFormReturnType } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { z } from 'zod';
import { apiErp } from '../api/clientes';
import { ErroRequisicao } from '../api/http';
import { errosDaApi, errosDoZod } from '../util/erros';

/**
 * Ciclo padrão de um formulário de cadastro (ERP 3.2): carrega o registro, preenche o `useForm`, grava com `POST`
 * (novo) ou `PUT` (com a `versao`), devolve os erros por campo da API/zod ao formulário e exclui. O erro da última
 * gravação vai para o `<FormularioEntidade>` (409 de versão vira o aviso com "Recarregar").
 */
export function useCadastro<
  D extends { id: string; versao: number },
  V extends Record<string, unknown>,
>(opcoes: {
  /** Caminho da API (`/marcas`). */
  api: string;
  /** Rota da listagem no ERP (`/produtos/marcas`). */
  rota: string;
  /** Chave da listagem para invalidar (`['listagem', recurso]`). */
  recurso: string;
  id: string | undefined;
  form: UseFormReturnType<V>;
  paraValores: (d: D) => V;
  /** Monta o corpo a partir dos valores (sem a versão). */
  paraCorpo: (v: V) => Record<string, unknown>;
  schemaCriar?: z.ZodType;
  schemaAlterar?: z.ZodType;
  /** Aba que recebe o foco quando há erro de campo. */
  aoErroCampos?: (campos: Record<string, string>) => void;
  /** Traduz os caminhos de erro do corpo (API/zod) para os campos do formulário, quando diferem. */
  mapearErros?: (campos: Record<string, string>) => Record<string, string>;
  aoGravar?: (d: D, novo: boolean) => void;
  /** Depois da exclusão (a listagem já é invalidada): as outras chaves que guardam o registro, como as dos seletores. */
  aoExcluir?: () => void;
  mensagemExcluido?: string;
}) {
  const { api, rota, recurso, id, form } = opcoes;
  const novo = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<unknown>(null);

  const registro = useQuery({
    queryKey: [recurso, id],
    queryFn: () => apiErp.get<D>(`${api}/${id}`),
    enabled: !novo,
  });

  useEffect(() => {
    if (registro.data) {
      const v = opcoes.paraValores(registro.data);
      form.setValues(v);
      form.resetDirty(v);
    }
    // Só uma nova versão do registro recarrega os campos (`form` muda a cada render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registro.data]);

  const errosCampos = (brutos: Record<string, string>) => {
    const campos = opcoes.mapearErros ? opcoes.mapearErros(brutos) : brutos;
    form.setErrors(campos);
    opcoes.aoErroCampos?.(campos);
  };

  const gravar = useMutation({
    mutationFn: (corpo: unknown) =>
      novo ? apiErp.post<D>(api, corpo) : apiErp.put<D>(`${api}/${id}`, corpo),
    onSuccess: (d) => {
      setErro(null);
      void queryClient.invalidateQueries({ queryKey: ['listagem', recurso] });
      queryClient.setQueryData([recurso, d.id], d);
      notifications.show({ color: 'green', message: 'Registro gravado' });
      opcoes.aoGravar?.(d, novo);
      if (novo) {
        form.resetDirty();
        navigate(`${rota}/${d.id}`, { replace: true });
      } else {
        const v = opcoes.paraValores(d);
        form.setValues(v);
        form.resetDirty(v);
      }
    },
    onError: (e) => {
      setErro(e);
      if (e instanceof ErroRequisicao && e.campos) errosCampos(errosDaApi(e.campos));
    },
  });

  const excluir = useMutation({
    mutationFn: () => apiErp.del(`${api}/${id}`),
    onSuccess: () => {
      form.resetDirty();
      void queryClient.invalidateQueries({ queryKey: ['listagem', recurso] });
      opcoes.aoExcluir?.();
      notifications.show({ color: 'green', message: opcoes.mensagemExcluido ?? 'Registro excluído' });
      navigate(rota);
    },
    onError: (e) => setErro(e),
  });

  function salvar() {
    const corpo = {
      ...opcoes.paraCorpo(form.getValues()),
      ...(novo ? {} : { versao: registro.data?.versao }),
    };
    const schema = novo ? opcoes.schemaCriar : opcoes.schemaAlterar;
    if (schema) {
      const r = schema.safeParse(corpo);
      if (!r.success) {
        errosCampos(errosDoZod(r.error));
        return;
      }
    }
    gravar.mutate(corpo);
  }

  return {
    novo,
    registro,
    erro,
    setErro,
    salvar,
    excluir: () => excluir.mutateAsync(),
    salvando: gravar.isPending || excluir.isPending,
    recarregar: () => {
      setErro(null);
      void registro.refetch();
    },
    naoEncontrado: !novo && registro.error instanceof ErroRequisicao && registro.error.status === 404,
  };
}

/** Mapa de abas por campo com erro: a primeira aba que tem um dos campos recebe o foco. */
export function abaDoErro(
  campos: Record<string, string>,
  abas: Record<string, readonly string[]>,
): string | undefined {
  const chaves = Object.keys(campos);
  return Object.entries(abas).find(([, prefixos]) =>
    chaves.some((c) => prefixos.some((p) => c === p || c.startsWith(`${p}.`))),
  )?.[0];
}
