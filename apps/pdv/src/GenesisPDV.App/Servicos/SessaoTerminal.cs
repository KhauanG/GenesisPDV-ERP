using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.Servicos;

/// <summary>Dados do terminal ativo e do operador logado, compartilhados pelas telas.</summary>
/// <param name="log">
/// Quem põe o código do terminal no log (<see cref="Diagnostico.EnriquecedorTerminal"/>); nulo = o do processo.
/// </param>
public sealed class SessaoTerminal(Diagnostico.EnriquecedorTerminal? log = null)
{
    private readonly Diagnostico.EnriquecedorTerminal _log = log ?? Diagnostico.EnriquecedorTerminal.Processo;

    /// <summary>
    /// O terminal ativo. Ao receber a identidade, o log do processo passa a levar o código curto do terminal
    /// (<see cref="Diagnostico.EnriquecedorTerminal"/>; Central do PDV, bloco G2).
    /// </summary>
    public IdentidadeTerminal? Identidade
    {
        get => _identidade;
        set
        {
            _identidade = value;
            _log.Definir(value);
        }
    }

    private IdentidadeTerminal? _identidade;

    public Operador? Operador { get; set; }

    /// <summary>
    /// No terminal real, nome e código da loja vêm do espelho <c>lojas</c> (<see cref="CarregarDoEspelhoAsync"/>, depois
    /// da carga do fluxo <c>configuracao</c>) ou, antes dele, do resumo gravado na ativação (<see cref="AplicarResumo"/>);
    /// no de demonstração, dos valores de demonstração.
    /// </summary>
    public string NomeLoja { get; set; } = "Loja 1 - Demonstração";

    public int LojaCodigo { get; set; } = 1;

    public bool Ativado => Identidade is not null;

    /// <summary>Terminal ativado de verdade (não a demonstração do F8): a venda não finaliza até a Fase 1C (D18).</summary>
    public bool IdentidadeReal => Identidade is { Demonstracao: false };

    public void AplicarResumo(TerminalAtivado resumo)
    {
        ArgumentNullException.ThrowIfNull(resumo);
        NomeLoja = resumo.LojaNome;
        LojaCodigo = resumo.LojaCodigo;
    }

    /// <summary>
    /// Loja e caixa do terminal lidos do espelho (fluxo <c>configuracao</c>): o nome e o código da loja mudados no ERP
    /// chegam pelo pull. Sem a linha (carga ainda não feita), fica o que já estava. O número do caixa vem da identidade
    /// (é o da ativação; a troca de caixa é uma nova ativação).
    /// </summary>
    public async Task CarregarDoEspelhoAsync(IDbContextFactory<PdvDbContext> fabrica, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(fabrica);
        if (Identidade is not { Demonstracao: false } identidade)
        {
            return;
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var loja = await db.Lojas.AsNoTracking()
            .Where(l => l.Id == identidade.LojaId && l.ExcluidoEm == null)
            .Select(l => new { l.Codigo, l.Nome, l.FusoHorario })
            .FirstOrDefaultAsync(ct);
        if (loja is not null)
        {
            NomeLoja = loja.Nome;
            LojaCodigo = loja.Codigo;
        }

        // Fuso da loja (MD 1.2); sem ele, o da empresa; sem os dois, o padrão (Brasília).
        var fuso = loja?.FusoHorario;
        if (string.IsNullOrWhiteSpace(fuso))
        {
            fuso = await db.Set<EmpresaRegistro>().AsNoTracking().Where(e => e.ExcluidoEm == null).Select(e => e.FusoHorario).FirstOrDefaultAsync(ct);
        }

        FusoHorario = string.IsNullOrWhiteSpace(fuso) ? DiaOperacional.FusoPadrao : fuso;
    }

    /// <summary>Fuso da loja do terminal (<c>lojas.fuso_horario</c>, MD 1.2), base do dia operacional.</summary>
    public string FusoHorario { get; private set; } = DiaOperacional.FusoPadrao;

    /// <summary>
    /// <c>geral.dia_operacional_hora_corte</c> da loja (MD 1.2; D7, dono: 05:00 na empresa, ajustável por loja), lida por
    /// <see cref="CarregarConfiguracoesAsync"/>.
    /// </summary>
    public TimeOnly HoraCorteDiaOperacional { get; private set; } = ChavesConfiguracao.HoraCortePadrao;

    /// <summary>
    /// Sessão de caixa aberta neste terminal (<c>sessoes_caixa</c>, Fase 1C): vai em toda venda e no contexto do envelope.
    /// Lida por <see cref="CarregarSessaoCaixaAsync"/>; a abertura e o fechamento (C10a, <c>ServicoCaixa</c>) a atualizam.
    /// </summary>
    public Guid? SessaoCaixaId => SessaoCaixa?.Id;

    /// <summary>A linha da sessão aberta (operador, abertura, dia operacional), para o alerta de sessão antiga (PDV 8.1).</summary>
    public SessaoCaixaRegistro? SessaoCaixa { get; private set; }

    /// <summary>Relê a sessão aberta do banco local (abertura do app, volta ao login, depois de uma queda).</summary>
    public async Task CarregarSessaoCaixaAsync(RepositorioCaixa caixa, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(caixa);
        SessaoCaixa = await caixa.SessaoAbertaAsync(ct);
    }

    /// <summary>Sessão recém-aberta (ou nula, depois do fechamento) sem reler o banco.</summary>
    public void DefinirSessaoCaixa(SessaoCaixaRegistro? sessao) => SessaoCaixa = sessao;

    /// <summary>
    /// <c>pdv.usa_preco_volume</c> (MD 3.1.2) da loja do terminal, lido do espelho <c>configuracoes</c> por
    /// <see cref="CarregarConfiguracoesAsync"/> (padrão do catálogo: <c>false</c>). O terminal de demonstração grava a
    /// chave ligada na carga de demonstração.
    /// </summary>
    public bool UsaPrecoVolume { get; private set; }

    /// <summary>Relê as configurações da loja usadas na venda (antes de abrir a tela de venda).</summary>
    public async Task CarregarConfiguracoesAsync(RepositorioConfiguracoes configuracoes, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(configuracoes);
        UsaPrecoVolume = Identidade is { } identidade
                         && await configuracoes.ObterBoolAsync(ChavesConfiguracao.UsaPrecoVolume, identidade.LojaId, padrao: false, ct);
        HoraCorteDiaOperacional = Identidade is { } comLoja
            ? await configuracoes.ObterHoraAsync(ChavesConfiguracao.HoraCorteDiaOperacional, comLoja.LojaId, ChavesConfiguracao.HoraCortePadrao, ct)
            : ChavesConfiguracao.HoraCortePadrao;
    }

    /// <summary>Contexto da venda: terminal, loja, sessão aberta, fuso e hora de corte do dia operacional (MD 1.2).</summary>
    public ContextoVenda Contexto()
    {
        var identidade = Identidade ?? throw new InvalidOperationException("Terminal não ativado.");
        return new ContextoVenda(
            identidade.TerminalId, identidade.LojaId, LojaCodigo, identidade.CaixaId, identidade.NumeroCaixa, SessaoCaixaId,
            FusoHorario, HoraCorteDiaOperacional, UsaPrecoVolume);
    }
}
