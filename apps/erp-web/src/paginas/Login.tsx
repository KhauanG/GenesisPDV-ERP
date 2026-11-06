import { loginSchema } from '@genesis/shared';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Checkbox,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { ErroRequisicao } from '../api/http';
import { Carregando } from '../auth/RotaProtegida';
import { useSessao } from '../auth/sessao';
import { gravarLocal, lerLocal } from '../util/armazenamento';
import { errosDoZod } from '../util/erros';

export const CHAVE_CODIGO_EMPRESA = 'genesis:codigo-empresa';

/** Só rotas internas do ERP: `voltar` nunca leva para outro site nem para o painel da plataforma. */
export function rotaVoltarSegura(voltar: string | null): string {
  const valida =
    !!voltar &&
    voltar.startsWith('/') &&
    !voltar.startsWith('//') &&
    !/^\/(plataforma|sair|login|trocar-senha)(\/|\?|$)/.test(voltar);
  return valida ? voltar : '/';
}

/** Tela de login (ERP 4.1): código da empresa + usuário + senha; o código fica lembrado neste navegador. */
export function Login() {
  useDocumentTitle('Entrar · GenesisPDV');
  const { estado, entrar } = useSessao();
  const [params] = useSearchParams();
  const local = useLocation();
  const voltar = rotaVoltarSegura(params.get('voltar'));
  const lembrado = lerLocal(CHAVE_CODIGO_EMPRESA);
  const [codigo, setCodigo] = useState(lembrado ?? '');
  const [login, setLogin] = useState('');
  const [senha, setSenha] = useState('');
  const [lembrar, setLembrar] = useState(true);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [esqueci, setEsqueci] = useState(false);
  const motivo = (local.state as { motivo?: string } | null)?.motivo;

  if (estado.status === 'carregando') return <Carregando />;
  if (estado.status === 'autenticado' && !enviando) {
    // A navegação depois do login é só esta: um `navigate()` imperativo concorreria com ela.
    return estado.trocarSenha ? (
      <Navigate to="/trocar-senha" replace state={{ voltar }} />
    ) : (
      <Navigate to={voltar} replace />
    );
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    const r = loginSchema.safeParse({ codigoEmpresa: codigo, login, senha });
    if (!r.success) {
      setErros(errosDoZod(r.error));
      return;
    }
    setErros({});
    setEnviando(true);
    try {
      await entrar({ codigoEmpresa: codigo.trim(), login: login.trim(), senha });
      gravarLocal(CHAVE_CODIGO_EMPRESA, lembrar ? codigo.trim() : null);
    } catch (falha) {
      setErro(
        falha instanceof ErroRequisicao
          ? falha.message
          : 'Não foi possível entrar. Tente novamente em instantes.',
      );
      setSenha('');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Center mih="100vh" p="md" bg="var(--genesis-fundo)">
      <Box w="100%" maw={400}>
        <Stack gap={4} mb="lg" align="center">
          <Title order={1} c="genesis" size="h2">
            GenesisPDV
          </Title>
          <Text c="dimmed" size="sm">
            ERP · acesso da empresa
          </Text>
        </Stack>
        <Paper p="xl" shadow="sm">
          <form onSubmit={enviar} noValidate>
            <Stack gap="md">
              {motivo === 'expirada' && !erro && (
                <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
                  Sua sessão expirou. Entre novamente.
                </Alert>
              )}
              {erro && (
                <Alert color="red" icon={<IconAlertTriangle size={18} />} role="alert">
                  {erro}
                </Alert>
              )}
              <TextInput
                label="Código da empresa"
                placeholder="000000"
                inputMode="numeric"
                maxLength={6}
                autoComplete="organization"
                value={codigo}
                onChange={(e) => setCodigo(e.currentTarget.value.replace(/\D/g, ''))}
                error={erros.codigoEmpresa}
                required
                autoFocus={!lembrado}
              />
              <TextInput
                label="Usuário"
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.currentTarget.value)}
                error={erros.login}
                required
                autoFocus={!!lembrado}
              />
              <PasswordInput
                label="Senha"
                autoComplete="current-password"
                value={senha}
                onChange={(e) => setSenha(e.currentTarget.value)}
                error={erros.senha}
                required
              />
              <Checkbox
                label="Lembrar código da empresa"
                checked={lembrar}
                onChange={(e) => setLembrar(e.currentTarget.checked)}
              />
              <Button type="submit" fullWidth loading={enviando}>
                Entrar
              </Button>
              <Anchor
                component="button"
                type="button"
                size="sm"
                ta="center"
                onClick={() => setEsqueci((v) => !v)}
              >
                Esqueci minha senha
              </Anchor>
              {esqueci && (
                <Text size="sm" c="dimmed" ta="center">
                  Peça a um administrador da sua empresa para redefinir sua senha. A recuperação por e-mail
                  será liberada em breve.
                </Text>
              )}
            </Stack>
          </form>
        </Paper>
        <Text size="xs" c="dimmed" ta="center" mt="md">
          Versão {__VERSAO_ERP__}
        </Text>
      </Box>
    </Center>
  );
}
