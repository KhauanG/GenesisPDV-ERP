import { loginPlataformaSchema } from '@genesis/shared';
import {
  Alert,
  Box,
  Button,
  Center,
  Paper,
  PasswordInput,
  PinInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconAlertTriangle, IconShieldCheck } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ErroRequisicao } from '../api/http';
import { Carregando } from '../auth/RotaProtegida';
import { errosDoZod } from '../util/erros';
import { useSessaoPlataforma } from './sessao';

/** Login do painel da plataforma (ERP 19.1): e-mail, senha e o código do autenticador (TOTP, obrigatório). */
export function LoginPlataforma() {
  useDocumentTitle('Plataforma · Entrar');
  const { estado, entrar } = useSessaoPlataforma();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [codigoTotp, setCodigoTotp] = useState('');
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (estado.status === 'carregando') return <Carregando />;
  if (estado.status === 'autenticado') return <Navigate to="/plataforma/empresas" replace />;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    const r = loginPlataformaSchema.safeParse({ email, senha, codigoTotp });
    if (!r.success) {
      setErros(errosDoZod(r.error));
      return;
    }
    setErros({});
    setEnviando(true);
    try {
      await entrar(r.data);
    } catch (falha) {
      setErro(falha instanceof ErroRequisicao ? falha.message : 'Não foi possível entrar.');
      setCodigoTotp('');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Center mih="100vh" p="md" bg="var(--genesis-fundo)">
      <Box w="100%" maw={400}>
        <Stack gap={4} mb="lg" align="center">
          <IconShieldCheck size={36} stroke={1.5} color="var(--mantine-primary-color-filled)" />
          <Title order={1} size="h3">
            Painel da plataforma
          </Title>
          <Text c="dimmed" size="sm">
            Acesso restrito à equipe Genesis
          </Text>
        </Stack>
        <Paper p="xl" shadow="sm">
          <form onSubmit={enviar} noValidate>
            <Stack gap="md">
              {erro && (
                <Alert color="red" icon={<IconAlertTriangle size={18} />} role="alert">
                  {erro}
                </Alert>
              )}
              <TextInput
                label="E-mail"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                error={erros.email}
                required
                autoFocus
              />
              <PasswordInput
                label="Senha"
                autoComplete="current-password"
                value={senha}
                onChange={(e) => setSenha(e.currentTarget.value)}
                error={erros.senha}
                required
              />
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Código do autenticador
                </Text>
                <PinInput
                  length={6}
                  type="number"
                  oneTimeCode
                  value={codigoTotp}
                  onChange={setCodigoTotp}
                  error={!!erros.codigoTotp}
                  aria-label="Código do autenticador"
                />
                {erros.codigoTotp && (
                  <Text size="xs" c="red">
                    {erros.codigoTotp}
                  </Text>
                )}
              </Stack>
              <Button type="submit" fullWidth loading={enviando}>
                Entrar
              </Button>
            </Stack>
          </form>
        </Paper>
      </Box>
    </Center>
  );
}
