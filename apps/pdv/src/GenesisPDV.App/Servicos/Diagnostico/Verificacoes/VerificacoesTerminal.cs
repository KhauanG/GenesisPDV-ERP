using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Relogio;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.Servicos.Diagnostico.Verificacoes;

/// <summary>
/// Relógio do computador (plano 4.1; SYNC 12.2–12.4; C16): vermelho quando a hora do Windows voltou para trás nas
/// últimas <see cref="OpcoesSaude.JanelaRecente"/> (a auditoria local <c>relogio_regrediu</c>) ou com o desvio da nuvem
/// além de 5 min; amarelo além de 2 min (os limites do ERP). Sem amostra da nuvem (offline desde a abertura), verde.
/// </summary>
public sealed class VerificacaoRelogio(RelogioSync relogio, IDbContextFactory<PdvDbContext> fabrica, SessaoTerminal sessao, OpcoesSaude opcoes)
    : IVerificacaoSaude
{
    private const string Acerte = "Acerte a data, a hora e o fuso do Windows (o caixa corrige a hora das vendas, mas o ERP marca o caixa).";

    public string Codigo => "relogio";

    public string Nome => "Relógio do computador";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        var desde = relogio.Agora - opcoes.JanelaRecente;
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            // Só a mais recente da janela (o ocorrido_em é texto UTC de largura fixa: compara e ordena no SQL).
            var regressao = await db.LogAuditoriaLocal.AsNoTracking()
                .Where(a => a.Acao == GravadorOutbox.AcaoRelogioRegrediu && a.OcorridoEm >= desde)
                .OrderByDescending(a => a.OcorridoEm)
                .Select(a => (DateTimeOffset?)a.OcorridoEm)
                .FirstOrDefaultAsync(ct);
            if (regressao is { } quando)
            {
                return new ItemSaude(Codigo, Nome, NivelSaude.Problema, $"A hora do Windows voltou para trás ({TextoSaude.Hora(quando, sessao)}).", Acerte);
            }
        }

        if (relogio.DesvioMs is not { } desvio)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Ainda sem comparar com a hora da nuvem (sem internet desde que o caixa abriu).");
        }

        // desvio = servidor − local (SYNC 12.2): positivo é o computador atrasado.
        var diferenca = TimeSpan.FromMilliseconds(Math.Abs(desvio));
        var sentido = desvio > 0 ? "atrasado" : "adiantado";
        var frase = $"O relógio do computador está {TextoSaude.Duracao(diferenca)} {sentido} em relação à nuvem.";
        return diferenca > opcoes.DesvioRelogioCritico ? new ItemSaude(Codigo, Nome, NivelSaude.Problema, frase, Acerte)
            : diferenca > opcoes.DesvioRelogioAviso ? new ItemSaude(Codigo, Nome, NivelSaude.Aviso, frase, Acerte)
            : new ItemSaude(Codigo, Nome, NivelSaude.Ok, $"Certo (diferença de {TextoSaude.Duracao(diferenca)} com a nuvem).");
    }
}

/// <summary>
/// Backup (plano 4.1; PDV 32.5; C17): vermelho quando a última tentativa deste processo falhou depois do último sucesso
/// (<c>ultimo_backup_em</c>); amarelo com o caixa aberto e o último sucesso há mais de <see cref="OpcoesSaude.BackupAntigo"/>
/// (o periódico é de 2 h com o caixa aberto: com ele fechado, o backup velho é o normal). O caixa aberto há menos de
/// <see cref="Carencia"/> ainda não conta: o laço do backup confere a cada até 5 min e faz o primeiro logo.
/// </summary>
public sealed class VerificacaoBackup(ServicoBackup backup, IDbContextFactory<PdvDbContext> fabrica, SessaoTerminal sessao, IRelogio relogio, OpcoesSaude opcoes)
    : IVerificacaoSaude
{
    /// <summary>Depois de abrir o caixa, o primeiro backup periódico sai na primeira volta do laço (até 5 min).</summary>
    public static readonly TimeSpan Carencia = TimeSpan.FromMinutes(15);

    public string Codigo => "backup";

    public string Nome => "Backup";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
        if (identidade is null)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Terminal ainda não ativado.");
        }

        var ultimo = identidade.UltimoBackupEm;
        var aba = AcaoSaude.IrPara(AbasCentral.Backup);
        if (backup.UltimaFalha is { } falha && (ultimo is null || falha.Em > ultimo))
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Problema,
                $"O último backup falhou em {TextoSaude.Hora(falha.Em, sessao)} ({TextoSaude.Curto(falha.Mensagem)}).",
                "Confira o espaço no disco (item Disco) e tente de novo na aba 8 Backup (F5); o caixa também tenta sozinho. Se repetir, chame o suporte.", aba);
        }

        var abertas = await db.SessoesCaixa.AsNoTracking()
            .Where(s => s.Status != StatusSessaoCaixa.Fechada && s.ExcluidoEm == null)
            .Select(s => s.AbertaEm)
            .ToListAsync(ct);
        var aberto = abertas.Count > 0 && relogio.Agora - abertas.Min() > Carencia;
        if (ultimo is not { } quando)
        {
            return aberto
                ? new ItemSaude(Codigo, Nome, NivelSaude.Aviso, "Nenhum backup deste caixa ainda.",
                    "O primeiro sai sozinho com o caixa aberto (a cada 2 h) e no fechamento; para fazer um agora, aba 8 Backup, F5. Se não sair, chame o suporte.", aba)
                : new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Nenhum backup ainda: o primeiro sai logo depois de abrir o caixa.");
        }

        return aberto && relogio.Agora - quando > opcoes.BackupAntigo
            ? new ItemSaude(Codigo, Nome, NivelSaude.Aviso,
                $"Último backup em {TextoSaude.Hora(quando, sessao)}, há {TextoSaude.Duracao(relogio.Agora - quando)}.",
                "Com o caixa aberto o backup sai a cada 2 h: confira o espaço no disco e faça um agora (aba 8 Backup, F5); se continuar, chame o suporte.", aba)
            : new ItemSaude(Codigo, Nome, NivelSaude.Ok, $"Último backup em {TextoSaude.Hora(quando, sessao)}.");
    }
}

/// <summary>
/// Banco local (plano 4.1; spec 32.2): o <c>integrity_check</c> da abertura, guardado em <see cref="EstadoBanco"/> (nunca
/// roda de novo aqui: ele lê o arquivo inteiro). A falha leva a abertura à restauração e não chega ao Painel; fica o
/// texto para o caso de chegar.
/// </summary>
public sealed class VerificacaoBanco(EstadoBanco estado, SessaoTerminal sessao) : IVerificacaoSaude
{
    public string Codigo => "banco";

    public string Nome => "Banco local";

    public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct) => Task.FromResult(estado switch
    {
        { Falha: { } falha } => new ItemSaude(Codigo, Nome, NivelSaude.Problema,
            $"O banco do caixa não passou na verificação da abertura ({TextoSaude.Curto(falha)}).",
            "Restaure o backup pela tela de login: ⚙ Central do PDV › 3 Impressora e gaveta › F9 Restaurar backup (supervisor)."),
        { ConferidoEm: { } quando } => new ItemSaude(Codigo, Nome, NivelSaude.Ok,
            $"Conferido ao abrir o GenesisPDV ({TextoSaude.Hora(quando, sessao)}): íntegro."),
        { BancoNovo: true } => new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Criado nesta abertura do GenesisPDV."),
        _ => new ItemSaude(Codigo, Nome, NivelSaude.Aviso, "Ainda não conferido nesta abertura.", "Feche e abra o GenesisPDV para conferir."),
    });
}

/// <summary>
/// Caixa aberto (plano 4.1; PDV 8.1): amarelo com a sessão aberta há mais de <c>pdv.horas_alerta_sessao</c>; vermelho com
/// a sessão de dia operacional anterior (a hora de corte da loja). O que fazer: fechar pelo F11 › 3 da venda.
/// </summary>
public sealed class VerificacaoCaixa(RepositorioCaixa caixa, RepositorioConfiguracoes configuracoes, SessaoTerminal sessao, RelogioSync relogio)
    : IVerificacaoSaude
{
    private const string Feche = "Feche o caixa: na venda, F11 › 3 Fechar caixa.";

    public string Codigo => "caixa";

    public string Nome => "Caixa aberto";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        if (sessao.Identidade is not { } identidade)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Terminal ainda não ativado.");
        }

        if (await caixa.SessaoAbertaAsync(ct) is not { } aberta)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Nenhum caixa aberto.");
        }

        var agora = relogio.Agora;
        var fuso = DiaOperacional.ObterFuso(sessao.FusoHorario);
        var desde = TextoSaude.Hora(aberta.AbertaEm, sessao);
        if (aberta.DiaOperacional < DiaOperacional.Calcular(agora, fuso, sessao.HoraCorteDiaOperacional))
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Problema, $"Caixa aberto desde {desde}, de um dia anterior.", Feche);
        }

        var horas = await configuracoes.ObterInteiroAsync(ChavesConfiguracao.HorasAlertaSessao, identidade.LojaId, ChavesConfiguracao.HorasAlertaSessaoPadrao, ct);
        return agora - aberta.AbertaEm > TimeSpan.FromHours(horas)
            ? new ItemSaude(Codigo, Nome, NivelSaude.Aviso, $"Caixa aberto há {TextoSaude.Duracao(agora - aberta.AbertaEm)} (desde {desde}).", Feche)
            : new ItemSaude(Codigo, Nome, NivelSaude.Ok, $"Aberto desde {desde}.");
    }
}

/// <summary>
/// Versão do GenesisPDV (plano 4.1; SYNC 17.3; PDV 32.6; I3): vermelho abaixo da mínima que a nuvem publicou (gravada pelo
/// handshake e pelo heartbeat), com o como atualizar de sempre.
/// </summary>
public sealed class VerificacaoVersao(RepositorioTerminal terminal) : IVerificacaoSaude
{
    public string Codigo => "versao";

    public string Nome => "Versão do GenesisPDV";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        var minima = (await terminal.ObterEstadoConexaoAsync(ct)).VersaoMinimaApp;
        return VersaoApp.AbaixoDe(minima)
            ? new ItemSaude(Codigo, Nome, NivelSaude.Problema,
                $"Esta versão ({VersaoApp.Atual}) está abaixo da mínima pedida pela nuvem ({minima}).", MensagensAtivacao.ComoAtualizar(minima))
            : new ItemSaude(Codigo, Nome, NivelSaude.Ok, $"GenesisPDV {VersaoApp.Atual}.");
    }
}

/// <summary>
/// Erros recentes (plano 4.1): amarelo com erro ou crítico no <c>log_local</c> nas últimas
/// <see cref="OpcoesSaude.JanelaRecente"/>: só a quantidade e a hora do último. O texto do erro (que pode ser o de qualquer
/// exceção, com dado de cliente) fica na aba 5 Logs e ocorrências (G8), que pede <c>pdv.diagnostico.ver</c>: o Painel
/// abre sem PIN (PC-7).
/// </summary>
public sealed class VerificacaoErros(IDbContextFactory<PdvDbContext> fabrica, SessaoTerminal sessao, IRelogio relogio, OpcoesSaude opcoes) : IVerificacaoSaude
{
    private static readonly string[] Niveis = ["erro", "critico"];

    /// <summary>O filtro da aba 5 que o botão do item abre: os erros (e os críticos) das últimas 24 h.</summary>
    public const string FiltroErrosRecentes = "erros-24h";

    public string Codigo => "erros";

    public string Nome => "Erros recentes";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        var desde = relogio.Agora - opcoes.JanelaRecente;
        await using var db = await fabrica.CreateDbContextAsync(ct);
        // O índice ix_log_local_ocorrido_em limita à janela (texto UTC de largura fixa); só a contagem e a hora do último.
        var recentes = db.LogLocal.AsNoTracking().Where(l => l.OcorridoEm >= desde && Niveis.Contains(l.Nivel));
        var total = await recentes.CountAsync(ct);
        if (total == 0)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Nenhum erro nas últimas 24 h.");
        }

        var ultimo = await recentes.OrderByDescending(l => l.OcorridoEm).Select(l => l.OcorridoEm).FirstAsync(ct);
        return new ItemSaude(Codigo, Nome, NivelSaude.Aviso,
            $"{TextoSaude.Plural(total, "erro", "erros")} nas últimas 24 h; o último em {TextoSaude.Hora(ultimo, sessao)}.",
            "Se o caixa está funcionando, não precisa fazer nada. Se repetir, o supervisor vê o detalhe na aba 5 Logs e ocorrências.",
            AcaoSaude.IrPara(AbasCentral.Logs, FiltroErrosRecentes));
    }
}
