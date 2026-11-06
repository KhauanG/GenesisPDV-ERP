using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.Servicos.Diagnostico.Verificacoes;

/// <summary>
/// Impressora (plano 4.1; spec 32.2): amarelo sem impressora configurada (a venda segue e o comprovante fica para a
/// reimpressão) ou com comprovante esperando; vermelho com comprovante que falhou. O que fazer aponta a aba 3 (F7 Imprimir
/// pendentes), que pede ela mesma a permissão de configurar o terminal.
/// </summary>
public sealed class VerificacaoImpressora(ServicoImpressao impressao, IDbContextFactory<PdvDbContext> fabrica) : IVerificacaoSaude
{
    private const string Confira =
        "Confira se a impressora está ligada, com papel e com o cabo; depois, na aba 3 Impressora e gaveta, F7 Imprimir pendentes.";

    public string Codigo => "impressora";

    public string Nome => "Impressora";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        var aba = AcaoSaude.IrPara(AbasCentral.ImpressoraGaveta);
        if (!impressao.Configurada)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Aviso,
                "Sem impressora configurada: as vendas seguem e os comprovantes ficam guardados para reimprimir.",
                "Configure a impressora na aba 3 Impressora e gaveta (pede quem pode configurar o terminal).", aba);
        }

        // A contagem e o erro mais recente (uma linha, pelo índice ix_fila_impressao_status), nunca a fila inteira.
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var falhas = await db.FilaImpressao.CountAsync(f => f.Status == "falhou", ct);
        if (falhas > 0)
        {
            var erro = await db.FilaImpressao.AsNoTracking()
                .Where(f => f.Status == "falhou" && f.UltimoErro != null && f.UltimoErro != string.Empty)
                .OrderByDescending(f => f.CriadoEm)
                .Select(f => f.UltimoErro)
                .FirstOrDefaultAsync(ct);
            return new ItemSaude(Codigo, Nome, NivelSaude.Problema,
                $"{TextoSaude.Plural(falhas, "comprovante não saiu", "comprovantes não saíram")} na impressora" +
                (string.IsNullOrWhiteSpace(erro) ? "." : $" ({TextoSaude.Curto(erro)})."),
                Confira, aba);
        }

        var esperando = await db.FilaImpressao.CountAsync(f => f.Status == "pendente", ct);
        return esperando > 0
            ? new ItemSaude(Codigo, Nome, NivelSaude.Aviso, $"{TextoSaude.Plural(esperando, "comprovante esperando", "comprovantes esperando")} a impressora.",
                Confira, aba)
            : new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Pronta: nada esperando para imprimir.");
    }
}

/// <summary>
/// Gaveta (plano 4.1): vermelho quando o último pulso falhou — o deste processo (<see cref="ServicoGaveta.UltimaFalhaEm"/>)
/// ou, quando o último registro da gaveta no <c>log_local</c> é uma falha, a dele nas últimas
/// <see cref="OpcoesSaude.JanelaRecente"/> — sem um pulso que deu certo depois (o deste processo ou o "voltou a abrir" que
/// o <see cref="ServicoGaveta"/> grava: o app reaberto não acusa a falha que já passou). Lê uma linha do log. Desligada é
/// verde (desligada nenhum comando sai; dono, I4).
/// </summary>
public sealed class VerificacaoGaveta(ServicoGaveta gaveta, RepositorioTerminal terminal, SessaoTerminal sessao, IRelogio relogio, OpcoesSaude opcoes)
    : IVerificacaoSaude
{
    public string Codigo => "gaveta";

    public string Nome => "Gaveta";

    public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        if (!gaveta.Ligada)
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Desligada neste caixa (nenhum comando de abrir sai).");
        }

        var desde = relogio.Agora - opcoes.JanelaRecente;
        DateTimeOffset? falha = await terminal.UltimoLogAsync(ServicoGaveta.OrigemLog, ct) is { } ultimo
            && ultimo.Nivel != ServicoGaveta.NivelVoltou && ultimo.OcorridoEm >= desde
            ? ultimo.OcorridoEm
            : null;
        if (gaveta.UltimaFalhaEm is { } memoria && (falha is null || memoria > falha))
        {
            falha = memoria;
        }

        if (falha is { } quando && (gaveta.UltimoPulsoOkEm is not { } ok || ok < quando))
        {
            return new ItemSaude(Codigo, Nome, NivelSaude.Problema, $"A gaveta não abriu em {TextoSaude.Hora(quando, sessao)}.",
                "Confira o cabo da gaveta na impressora (e a impressora ligada). Teste na aba 3 Impressora e gaveta (F6).",
                AcaoSaude.IrPara(AbasCentral.ImpressoraGaveta));
        }

        return new ItemSaude(Codigo, Nome, NivelSaude.Ok, gaveta.UltimoPulsoOkEm is null ? "Ligada." : "Ligada; a última abertura funcionou.");
    }
}

/// <summary>
/// Disco (plano 4.1; spec 32.2): amarelo abaixo de <see cref="OpcoesSaude.DiscoAvisoBytes"/> (1 GB), vermelho abaixo de
/// <see cref="OpcoesSaude.DiscoBloqueioBytes"/> (200 MB), quando abrir caixa novo fica bloqueado (a venda em curso
/// nunca; o supervisor libera por 1 h). Na rodada completa, também o tamanho do banco, dos logs e dos backups.
/// </summary>
public sealed class VerificacaoDisco(MedidorDisco disco, OpcoesSaude opcoes) : IVerificacaoSaude
{
    public string Codigo => "disco";

    public string Nome => "Disco";

    public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
    {
        var tamanhos = completa
            ? $" Banco {MedidorDisco.Legivel(disco.TamanhoBanco())}, logs {MedidorDisco.Legivel(disco.TamanhoLogs())}, backups {MedidorDisco.Legivel(disco.TamanhoBackups())}."
            : string.Empty;
        var item = disco.LivreBytes() switch
        {
            null => new ItemSaude(Codigo, Nome, NivelSaude.Aviso, $"Não deu para medir o espaço livre do disco.{tamanhos}",
                "Se o computador avisar de disco cheio, chame o suporte."),
            { } livre when livre < opcoes.DiscoBloqueioBytes => new ItemSaude(Codigo, Nome, NivelSaude.Problema,
                $"Disco quase cheio: {MedidorDisco.Legivel(livre)} livres. Abrir caixa novo fica bloqueado (a venda em curso continua).{tamanhos}",
                "Apague arquivos que não são do caixa (downloads, fotos, vídeos) ou chame o suporte. O supervisor pode liberar a " +
                "abertura do caixa por 1 h."),
            { } livre when livre < opcoes.DiscoAvisoBytes => new ItemSaude(Codigo, Nome, NivelSaude.Aviso,
                $"Pouco espaço no disco: {MedidorDisco.Legivel(livre)} livres.{tamanhos}",
                $"Libere espaço: abaixo de {MedidorDisco.Legivel(opcoes.DiscoBloqueioBytes)} o caixa não abre sessão nova."),
            { } livre => new ItemSaude(Codigo, Nome, NivelSaude.Ok, $"{MedidorDisco.Legivel(livre)} livres.{tamanhos}"),
        };
        return Task.FromResult(item);
    }
}
