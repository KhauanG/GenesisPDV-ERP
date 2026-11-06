import { trocarSenhaSchema } from '@genesis/shared';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  List,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconShieldLock } from '@tabler/icons-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ErroRequisicao } from '../api/http';
import { Carregando } from '../auth/RotaProtegida';
import { useSessao } from '../auth/sessao';
import { errosDaApi, errosDoZod } from '../util/erros';
import { rotaVoltarSegura } from './Login';

/**
 * Trocar senha (ERP 4.2). `obrigatoria` = troca da senha provisória logo após o login (tela cheia, sem menu);
 * senão é a página "Minha conta › Trocar senha" dentro do layout.
 */
export function TrocarSenha({ obrigatoria = false }: { obrigatoria?: boolean }) {
  useDocumentTitle('Trocar senha · GenesisPDV');
  const { estado, trocarSenha } = useSessao();
  const navigate = useNavigate();
  const local = useLocation();
  const [valores, setValores] = useState({ senhaAtual: '', novaSenha: '', confirmacao: '' });
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (estado.status === 'carregando') return <Carregando />;
  if (estado.status === 'anonimo') return <Navigate to="/login" replace />;
  const voltar = rotaVoltarSegura((local.state as { voltar?: string } | null)?.voltar ?? null);
  if (obrigatoria && !estado.trocarSenha && !enviando) return <Navigate to={voltar} replace />;

  const campo = (nome: keyof typeof valores) => ({
    value: valores[nome],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setValores({ ...valores, [nome]: e.currentTarget.value }),
    error: erros[nome],
  });

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    const r = trocarSenhaSchema.safeParse(valores);
    const extra: Record<string, string> = {};
    if (!valores.confirmacao) extra.confirmacao = 'Confirme a nova senha';
    if (!r.success || Object.keys(extra).length) {
      setErros({ ...(r.success ? {} : errosDoZod(r.error)), ...extra });
      return;
    }
    setErros({});
    setEnviando(true);
    try {
      await trocarSenha(valores);
      notifications.show({
        color: 'green',
        title: 'Senha alterada',
        message: 'Use a nova senha nos próximos acessos.',
      });
      if (!obrigatoria) navigate('/', { replace: true });
    } catch (falha) {
      if (falha instanceof ErroRequisicao && falha.campos) setErros(errosDaApi(falha.campos));
      setErro(falha instanceof Error ? falha.message : 'Não foi possível trocar a senha.');
    } finally {
      setEnviando(false);
    }
  }

  const formulario = (
    <form onSubmit={enviar} noValidate>
      <Stack gap="md">
        {erro && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} role="alert">
            {erro}
          </Alert>
        )}
        <PasswordInput
          label={obrigatoria ? 'Senha provisória' : 'Senha atual'}
          autoComplete="current-password"
          required
          {...campo('senhaAtual')}
        />
        <PasswordInput label="Nova senha" autoComplete="new-password" required {...campo('novaSenha')} />
        <PasswordInput
          label="Confirmar nova senha"
          autoComplete="new-password"
          required
          {...campo('confirmacao')}
        />
        <List size="xs" c="dimmed" spacing={2}>
          <List.Item>Mínimo de 8 caracteres</List.Item>
          <List.Item>Ao menos uma letra e um número</List.Item>
          <List.Item>Diferente da senha atual</List.Item>
        </List>
        <Button type="submit" loading={enviando} fullWidth={obrigatoria}>
          Trocar senha
        </Button>
      </Stack>
    </form>
  );

  if (!obrigatoria) {
    return (
      <Stack gap="md" maw={440}>
        <Title order={2} size="h3">
          Trocar senha
        </Title>
        <Paper p="lg">{formulario}</Paper>
      </Stack>
    );
  }

  return (
    <Center mih="100vh" p="md" bg="var(--genesis-fundo)">
      <Box w="100%" maw={420}>
        <Paper p="xl" shadow="sm">
          <Stack gap={6} mb="md" align="center" ta="center">
            <IconShieldLock size={40} stroke={1.5} color="var(--mantine-primary-color-filled)" />
            <Title order={2} size="h3">
              Troque a senha provisória
            </Title>
            <Text size="sm" c="dimmed">
              Por segurança, defina uma senha pessoal antes de continuar.
            </Text>
          </Stack>
          {formulario}
          <Text size="sm" ta="center" mt="md">
            <Anchor component={Link} to="/sair">
              Sair
            </Anchor>
          </Text>
        </Paper>
      </Box>
    </Center>
  );
}
