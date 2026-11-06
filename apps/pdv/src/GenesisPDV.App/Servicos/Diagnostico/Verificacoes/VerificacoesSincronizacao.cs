using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Relogio;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.Servicos.Diagnostico.Verificacoes;

/// <summary>
/// Internet e envio ao ERP (plano 4.1): a situação do ciclo online (<see cref="IServicoSincronizacao.Situacao"/>, em
/// memória) e o outbox local. Amarelo: sem internet com a fila em dia, ou online com registro esperando envio há mais de
/// <see cref="OpcoesSaude.PendenteAntigo"/>; vermelho: o terminal bloqueado pela nuvem, <b>sem internet com a fila parada</b>
/// (registro esperando há mais de <see cref="OpcoesSaude.PendenteAntigo"/>: o "pronto quando" do G4, o operador vê o ⚠ na
/// venda) ou, com <c>pdv.dias_max_offline</c> preenchida, a um dia de o caixa parar de vender (PDV 30.6). A lacuna e os
/// recusados têm os itens deles. Lê só a contagem e o pendente mais antigo (uma linha), nunca a fila inteira.
/// </summary>
public sealed class VerificacaoSincronizacao(
    IServicoSincronizacao sync,
    IDbContextFactory<PdvDbContext> fabrica,
    ConsultasVendaLocal consultas,
    RepositorioConfiguracoes configuracoes,
    SessaoTerminal sessao,
    RelogioSync relogio,
    OpcoesSaude opcoes) : IVerificacaoSaude
{
    private static readonly string[] Pendentes = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];

    public string Codigo => "sincronizacao";

    public string Nome => "Internet e envio ao ERP";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        var s = sync.Situacao;
        if (s.SemNuvem || sessao.Identidade is not { Demonstracao: false } identidade)
        {
            return Item(NivelSaude.Ok, "Terminal de demonstração: nada sobe para o ERP nem desce dele.");
        }

        switch (s.Terminal)
        {
            case EstadoTerminalSync.Revogado:
                return Item(NivelSaude.Problema, "Terminal desativado pelo ERP: não envia nem recebe mais nada.", "Chame o suporte.");
            case EstadoTerminalSync.HardwareAlterado:
                return Item(NivelSaude.Problema, "O ERP não reconhece este computador (hardware alterado): as vendas estão paradas.",
                    "Peça a quem cuida do ERP para aprovar a troca do computador em PDVs/Terminais.");
            case EstadoTerminalSync.Regressao or EstadoTerminalSync.Bloqueado:
                return Item(NivelSaude.Problema, "O envio ao ERP parou: a nuvem não aceita o caixa como está.",
                    "Chame o suporte com o código do terminal (aba 9 Sobre o terminal).");
            case EstadoTerminalSync.Suspenso:
                return Item(NivelSaude.Problema, $"{MensagensBloqueioNuvem.Titulo(s.BloqueioNuvem)}.", MensagensBloqueioNuvem.Mensagem(s.BloqueioNuvem));
            case EstadoTerminalSync.Desativando:
                return Item(NivelSaude.Aviso, $"Em desativação: enviando o que falta ao ERP ({s.Pendentes}).",
                    "Aguarde: o caixa se desativa sozinho depois de enviar tudo.");
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var naFilaQuantos = await db.EventosSaida.CountAsync(e => Pendentes.Contains(e.Status), ct);
        // O índice ix_eventos_saida_status filtra; a ordem pelo texto UTC fixo do criado_em traz só o mais antigo.
        var antigo = naFilaQuantos == 0
            ? null
            : await db.EventosSaida.AsNoTracking().Where(e => Pendentes.Contains(e.Status))
                .OrderBy(e => e.CriadoEm).Select(e => (DateTimeOffset?)e.CriadoEm).FirstOrDefaultAsync(ct);
        var agora = relogio.Agora;
        var naFila = TextoSaude.Plural(naFilaQuantos, "registro", "registros");
        var parada = antigo is { } a && agora - a > opcoes.PendenteAntigo;
        if (!s.Online)
        {
            var limite = await configuracoes.ObterInteiroOuNuloAsync(ChavesConfiguracao.DiasMaxOffline, identidade.LojaId, null, ct);
            if (limite is > 0)
            {
                var offline = await consultas.SituacaoOfflineAsync(ct);
                var tempo = TempoOffline.Calcular(offline.MaiorHoraVista, agora, offline.UltimoPullSucesso, offline.SegundosOfflineAcumulados);
                if (tempo >= TimeSpan.FromDays(limite.Value - 1))
                {
                    return Item(NivelSaude.Problema,
                        $"Sem sincronizar há {TextoSaude.Duracao(tempo)}: com {limite} dias sem internet o caixa para de vender (regra da loja).",
                        "Ligue a internet do computador (cabo ou Wi-Fi) e use Sincronizar agora.", AcaoSaude.SincronizarAgora);
                }
            }

            var desde = s.OfflineDesde is { } d ? $" há {TextoSaude.Duracao(agora - d)}" : string.Empty;
            if (parada)
            {
                return Item(NivelSaude.Problema,
                    $"Sem internet{desde}: {naFila} esperando envio ao ERP desde {TextoSaude.Hora(antigo!.Value, sessao)}. As vendas " +
                    "seguem guardadas neste caixa, mas o ERP não as recebe.",
                    "Confira o cabo de rede ou o Wi-Fi do computador e use Sincronizar agora. Se a internet da loja está boa e " +
                    "não volta, chame o suporte com o código do terminal (aba 9 Sobre o terminal).", AcaoSaude.SincronizarAgora);
            }

            return Item(NivelSaude.Aviso,
                $"Sem internet{desde}: as vendas ficam guardadas neste caixa e sobem sozinhas quando a internet voltar ({naFila} na fila).",
                "Confira o cabo de rede ou o Wi-Fi do computador. Depois, Sincronizar agora.", AcaoSaude.SincronizarAgora);
        }

        if (parada)
        {
            return Item(NivelSaude.Aviso, $"{naFila} esperando envio desde {TextoSaude.Hora(antigo!.Value, sessao)}.",
                "Use Sincronizar agora. Se não sair da fila, o supervisor vê o motivo na aba 4 Sincronização.", AcaoSaude.SincronizarAgora);
        }

        return Item(NivelSaude.Ok, naFilaQuantos == 0 ? "Online: tudo enviado ao ERP." : $"Online: {naFila} a caminho do ERP.");
    }

    private ItemSaude Item(NivelSaude nivel, string frase, string? oQueFazer = null, AcaoSaude? acao = null) =>
        new(Codigo, Nome, nivel, frase, oQueFazer, acao);
}

/// <summary>
/// Registros recusados pelo ERP (plano 4.1; SYNC 7.5, 11.2): vermelho com algum <c>rejeitado</c> no outbox. Quem decide
/// é o ERP (Cadastros › PDVs / Terminais › o caixa › Eventos com erro: reprocessar ou descartar, C8); o caixa segue vendendo e o item fica
/// verde sozinho quando o ERP resolve.
/// </summary>
public sealed class VerificacaoRejeitados(IDbContextFactory<PdvDbContext> fabrica) : IVerificacaoSaude
{
    public string Codigo => "rejeitados";

    public string Nome => "Registros recusados pelo ERP";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var total = await db.EventosSaida.CountAsync(e => e.Status == StatusEventoSaida.Rejeitado, ct);
        if (total == 0)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Nenhum registro recusado.");
        }

        var primeiro = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Status == StatusEventoSaida.Rejeitado)
            .OrderBy(e => e.SequenciaTerminal)
            .Select(e => new { e.SequenciaTerminal, e.Tipo, e.UltimoErro })
            .FirstAsync(ct);
        var motivo = string.IsNullOrWhiteSpace(primeiro.UltimoErro) ? string.Empty : $": {TextoSaude.Curto(primeiro.UltimoErro)}";
        return new ItemSaude(Codigo, Nome, NivelSaude.Problema,
            $"{TextoSaude.Plural(total, "registro recusado", "registros recusados")} pelo ERP (o primeiro: nº {primeiro.SequenciaTerminal}, {primeiro.Tipo}{motivo}).",
            "Quem resolve é o ERP, em Cadastros › PDVs / Terminais › este caixa › Eventos com erro (reprocessar ou descartar). " +
            "O caixa segue vendendo e o item fica verde sozinho quando o ERP resolver.",
            AcaoSaude.IrPara(AbasCentral.Sincronizacao));
    }
}

/// <summary>
/// Lacuna na sequência de registros (plano 4.1; SYNC 8.6; C15): vermelho com a lacuna a declarar (as vendas novas param);
/// amarelo com a recuperável (os registros achados esperam a liberação do reenvio). Os dois pedem o supervisor com
/// <c>pdv.config.fiscal</c> no F11 › S › F4 da venda (o Painel não declara nada).
/// </summary>
public sealed class VerificacaoLacuna(IServicoSincronizacao sync) : IVerificacaoSaude
{
    public string Codigo => "lacuna";

    public string Nome => "Sequência dos registros";

    public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct) => Task.FromResult(sync.Situacao.Lacuna switch
    {
        null => new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Sem falha na sequência dos registros."),
        { Recuperavel: false } l => new ItemSaude(Codigo, Nome, NivelSaude.Problema,
            $"Lacuna de registros {l.Faixa}: a nuvem espera registros que o caixa não tem mais. As vendas novas estão paradas.",
            "Chame o supervisor com a permissão fiscal: na venda, F11 › S › F4 Declarar a lacuna."),
        { } l => new ItemSaude(Codigo, Nome, NivelSaude.Aviso,
            $"Os registros da lacuna {l.Faixa} foram achados e esperam a liberação do reenvio (as vendas seguem).",
            "Chame o supervisor com a permissão fiscal: na venda, F11 › S › F4 Liberar o reenvio."),
    });
}
