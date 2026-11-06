import { ActionIcon, Grid, Loader, Select, TextInput, Tooltip } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { buscarCep, useMunicipios, useUfs } from '../../api/referencias';

export interface ValoresEndereco {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  uf: string | null;
  /** Código IBGE como texto (valor do `<Select>`); vira número na gravação. */
  municipioIbge: string | null;
}

export const ENDERECO_VAZIO: ValoresEndereco = {
  cep: '',
  logradouro: '',
  numero: '',
  complemento: '',
  bairro: '',
  uf: null,
  municipioIbge: null,
};

export function enderecoParaForm(e: {
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  uf: string | null;
  municipioIbge: number | null;
}): ValoresEndereco {
  return {
    cep: e.cep ?? '',
    logradouro: e.logradouro ?? '',
    numero: e.numero ?? '',
    complemento: e.complemento ?? '',
    bairro: e.bairro ?? '',
    uf: e.uf,
    municipioIbge: e.municipioIbge === null ? null : String(e.municipioIbge),
  };
}

const mascaraCep = (v: string) => {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

/**
 * Bloco de endereço (ERP 1.6, 7.2, 10.1): CEP com "Buscar" (opcional e tolerante a falta de internet), UF e cidade
 * filtrada pela UF. `prefixo` aponta para o objeto dentro do formulário (`''` ou `enderecos.0.`).
 */
// O bloco serve a qualquer formulário (empresa, loja, usuário, endereços da pessoa): os caminhos são texto.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FormQualquer = UseFormReturnType<any>;

export function CamposEndereco({
  form,
  prefixo = '',
  obrigatorio = true,
}: {
  form: FormQualquer;
  prefixo?: string;
  obrigatorio?: boolean;
}) {
  const caminho = (c: keyof ValoresEndereco) => `${prefixo}${c}`;
  const uf = form.getInputProps(caminho('uf')).value as string | null;
  const ufs = useUfs();
  const municipios = useMunicipios(uf);
  const [buscando, setBuscando] = useState(false);

  async function buscar() {
    const cep = String(form.getInputProps(caminho('cep')).value ?? '');
    setBuscando(true);
    const r = await buscarCep(cep);
    setBuscando(false);
    if (!r) {
      notifications.show({
        color: 'yellow',
        message: 'CEP não encontrado ou consulta indisponível. Preencha o endereço.',
      });
      return;
    }
    if (r.logradouro) form.setFieldValue(caminho('logradouro'), r.logradouro);
    if (r.bairro) form.setFieldValue(caminho('bairro'), r.bairro);
    if (r.complemento && !form.getInputProps(caminho('complemento')).value)
      form.setFieldValue(caminho('complemento'), r.complemento);
    if (r.uf) form.setFieldValue(caminho('uf'), r.uf);
    if (r.municipioIbge) form.setFieldValue(caminho('municipioIbge'), String(r.municipioIbge));
  }

  const propsCep = form.getInputProps(caminho('cep'));
  return (
    <Grid>
      <Grid.Col span={{ base: 12, sm: 3 }}>
        <TextInput
          label="CEP"
          required={obrigatorio}
          inputMode="numeric"
          {...propsCep}
          value={mascaraCep(String(propsCep.value ?? ''))}
          onChange={(e) => form.setFieldValue(caminho('cep'), mascaraCep(e.currentTarget.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void buscar();
            }
          }}
          rightSection={
            buscando ? (
              <Loader size="xs" />
            ) : (
              <Tooltip label="Buscar endereço pelo CEP">
                <ActionIcon variant="subtle" aria-label="Buscar CEP" onClick={() => void buscar()}>
                  <IconSearch size={16} />
                </ActionIcon>
              </Tooltip>
            )
          }
        />
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 7 }}>
        <TextInput
          label="Endereço"
          required={obrigatorio}
          maxLength={150}
          {...form.getInputProps(caminho('logradouro'))}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 6, sm: 2 }}>
        <TextInput
          label="Número"
          required={obrigatorio}
          maxLength={20}
          placeholder="S/N"
          {...form.getInputProps(caminho('numero'))}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 6, sm: 4 }}>
        <TextInput label="Complemento" maxLength={80} {...form.getInputProps(caminho('complemento'))} />
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 4 }}>
        <TextInput
          label="Bairro"
          required={obrigatorio}
          maxLength={80}
          {...form.getInputProps(caminho('bairro'))}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 4, sm: 1 }}>
        <Select
          label="UF"
          required={obrigatorio}
          data={(ufs.data ?? []).map((u) => u.sigla)}
          searchable
          {...form.getInputProps(caminho('uf'))}
          onChange={(v) => {
            if (v !== uf) form.setFieldValue(caminho('municipioIbge'), null);
            form.setFieldValue(caminho('uf'), v);
          }}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 8, sm: 3 }}>
        <Select
          label="Cidade"
          required={obrigatorio}
          searchable
          placeholder={uf ? undefined : 'Escolha a UF'}
          disabled={!uf}
          data={(municipios.data ?? []).map((m) => ({ value: String(m.codigoIbge), label: m.nome }))}
          rightSection={municipios.isFetching ? <Loader size="xs" /> : undefined}
          nothingFoundMessage="Nenhuma cidade"
          {...form.getInputProps(caminho('municipioIbge'))}
        />
      </Grid.Col>
    </Grid>
  );
}

/** Endereço do formulário no formato da API (CEP sem máscara, município numérico ou nulo). */
export function enderecoParaApi(e: ValoresEndereco) {
  return {
    cep: e.cep.replace(/\D/g, ''),
    logradouro: e.logradouro,
    numero: e.numero,
    complemento: e.complemento,
    bairro: e.bairro,
    uf: e.uf,
    municipioIbge: e.municipioIbge ? Number(e.municipioIbge) : null,
  };
}
