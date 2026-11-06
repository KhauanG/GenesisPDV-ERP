using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary><c>fila_impressao</c>: o trabalho é gravado antes de ir para a impressora (PDV 19.1).</summary>
public sealed class RepositorioImpressao(IDbContextFactory<PdvDbContext> fabrica, IRelogio relogio)
{
    public async Task<Guid> EnfileirarAsync(string tipoDocumento, Guid? referenciaId, byte[] conteudo, int vias = 1, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var trabalho = new FilaImpressao
        {
            Id = IdGerador.Novo(),
            TipoDocumento = tipoDocumento,
            ReferenciaId = referenciaId,
            Conteudo = conteudo,
            Vias = vias,
            CriadoEm = relogio.Agora,
        };
        db.FilaImpressao.Add(trabalho);
        await db.SaveChangesAsync(ct);
        return trabalho.Id;
    }

    /// <param name="novaTentativa">
    /// Falso = o documento só serve naquela hora (a cobrança PIX, que mostra o QR ao cliente da frente): a falha fica
    /// <c>cancelado</c> com o erro, fora da nova tentativa (F7) e do <c>fila_impressao_pendentes</c>.
    /// </param>
    public async Task MarcarResultadoAsync(Guid id, bool impresso, string? erro = null, CancellationToken ct = default, bool novaTentativa = true)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var trabalho = await db.FilaImpressao.FirstAsync(f => f.Id == id, ct);
        trabalho.Tentativas++;
        trabalho.Status = impresso ? "impresso" : novaTentativa ? "falhou" : "cancelado";
        trabalho.ImpressoEm = impresso ? relogio.Agora : null;
        trabalho.UltimoErro = erro;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Sem impressora configurada (PDV 6.2; I4): o trabalho fica registrado (a reimpressão usa o conteúdo original), mas
    /// como <c>cancelado</c>, para não engordar a fila nem o <c>fila_impressao_pendentes</c> do heartbeat.
    /// </summary>
    public async Task MarcarSemImpressoraAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var trabalho = await db.FilaImpressao.FirstAsync(f => f.Id == id, ct);
        trabalho.Status = "cancelado";
        trabalho.UltimoErro = MensagemSemImpressora;
        await db.SaveChangesAsync(ct);
    }

    public const string MensagemSemImpressora = "sem impressora configurada";

    public async Task<int> ContarPendentesAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FilaImpressao.CountAsync(f => f.Status == "pendente" || f.Status == "falhou", ct);
    }

    /// <summary>"Descartar pendentes" da configuração do terminal: o que não vai mais sair fica como <c>cancelado</c>.</summary>
    public async Task<int> DescartarPendentesAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FilaImpressao.Where(f => f.Status == "pendente" || f.Status == "falhou")
            .ExecuteUpdateAsync(u => u.SetProperty(f => f.Status, "cancelado"), ct);
    }

    /// <summary>
    /// O conteúdo do primeiro trabalho do documento (o original como saiu, ou como ficou na fila): o cupom da venda e o
    /// fechamento do caixa (<c>fechamento_caixa</c>, Central do PDV › 2 Caixas, bloco G6) se reimprimem por ele, nunca
    /// montados de novo. Nulo sem o trabalho (por exemplo depois de recuperar o banco pela nuvem, C17). Pelo índice
    /// <c>ix_fila_impressao_documento</c>.
    /// </summary>
    public async Task<byte[]?> OriginalAsync(string tipoDocumento, Guid referenciaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FilaImpressao.AsNoTracking()
            .Where(f => f.TipoDocumento == tipoDocumento && f.ReferenciaId == referenciaId)
            .OrderBy(f => f.CriadoEm)
            .Select(f => f.Conteudo)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<IReadOnlyList<FilaImpressao>> PendentesAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FilaImpressao.AsNoTracking()
            .Where(f => f.Status == "pendente" || f.Status == "falhou")
            .OrderBy(f => f.CriadoEm)
            .ToListAsync(ct);
    }
}
