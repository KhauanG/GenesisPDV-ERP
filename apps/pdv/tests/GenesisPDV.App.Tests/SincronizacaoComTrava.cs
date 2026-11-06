using GenesisPDV.Sync.Cliente;

namespace GenesisPDV.App.Tests;

/// <summary>
/// A situação do sync real com a trava da D22 ligável pelo teste (o <c>desativando_confirmado</c> em voo só acontece
/// no ciclo online). Usada pela Gestão de vendas e pela Central do PDV.
/// </summary>
internal sealed class SincronizacaoComTrava(IServicoSincronizacao real) : IServicoSincronizacao
{
    public bool Confirmando { get; set; }

    public SituacaoSincronizacao Situacao => real.Situacao with { ConfirmandoDesativacao = Confirmando };

    public event EventHandler<SituacaoSincronizacao>? SituacaoAlterada
    {
        add => real.SituacaoAlterada += value;
        remove => real.SituacaoAlterada -= value;
    }

    public event EventHandler<string>? MensagemRecebida
    {
        add => real.MensagemRecebida += value;
        remove => real.MensagemRecebida -= value;
    }

    public Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default) => real.HandshakeAsync(ct);

    public void Iniciar() => real.Iniciar();

    public Task AcordarAsync(CancellationToken ct = default) => real.AcordarAsync(ct);

    public void SincronizarAgora() => real.SincronizarAgora();

    public Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) =>
        real.DeclararLacunaAsync(autorizadoPorId, observacao, ct, origem);

    public Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) =>
        real.AutorizarRecuperacaoLacunaAsync(autorizadoPorId, ct, origem);
}
