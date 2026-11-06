using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Comum;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Push;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Lacuna de eventos na tela (SYNC 8.6; Fase 1C, bloco C15), no terminal de demonstração com a situação do sync
/// simulada: a venda nova é recusada com a faixa, o F11 › S mostra a lacuna e o F4 pede a liberação de um supervisor
/// com <c>pdv.config.fiscal</c> (CARLOS, Master) para declarar; o operador que tem a permissão declara direto; a
/// recuperável só avisa (a venda segue) e o F4 libera o reenvio.
/// </summary>
public class LacunaTelasTests
{
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    /// <summary>O sync real com a lacuna ligável pelo teste (no terminal de demonstração não há push).</summary>
    private sealed class SincronizacaoComLacuna(IServicoSincronizacao real) : IServicoSincronizacao
    {
        public LacunaEventos? Lacuna { get; set; }

        public List<(Guid Supervisor, string? Observacao)> Declaracoes { get; } = [];

        public List<Guid> Recuperacoes { get; } = [];

        /// <summary>Recusa da próxima ação da lacuna (a nuvem recusou, sem conexão).</summary>
        public Exception? Falha { get; set; }

        public SituacaoSincronizacao Situacao => Lacuna is { } l
            ? real.Situacao with { Lacuna = l, Terminal = l.Recuperavel ? EstadoTerminalSync.Ativo : EstadoTerminalSync.Lacuna, SemNuvem = false, Online = true }
            : real.Situacao;

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

        public Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null)
        {
            if (Falha is { } falha)
            {
                return Task.FromException(falha);
            }

            Declaracoes.Add((autorizadoPorId, observacao));
            Lacuna = null;
            return Task.CompletedTask;
        }

        public Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null)
        {
            Recuperacoes.Add(autorizadoPorId);
            Lacuna = null;
            return Task.CompletedTask;
        }
    }

    /// <summary>Terminal de demonstração com o operador logado (padrão: MARIA, sem <c>pdv.config.fiscal</c>).</summary>
    private static async Task<(AmbienteUi Pdv, VendaViewModel Venda, SincronizacaoComLacuna Sync)> IniciarAsync(string usuario = "1", string senha = "1234")
    {
        SincronizacaoComLacuna? sync = null;
        var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<IServicoSincronizacao>(sp =>
            sync = new SincronizacaoComLacuna(sp.GetRequiredService<ServicoSincronizacaoHttp>())));
        var venda = await pdv.AtivarDemonstracaoELogarAsync(usuario, senha);
        return (pdv, venda, sync!);
    }

    private static async Task<DialogoStatusSyncViewModel> StatusAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.S);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoStatusSyncViewModel, "status do sync");
        await pdv.EsperarFocoAsync("DialogoStatusSync");
        return (DialogoStatusSyncViewModel)venda.Dialogo!;
    }

    private static async Task LiberarComCarlosAsync(AmbienteUi pdv, VendaViewModel venda, string motivo)
    {
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "pedido de liberação");
        var dialogo = (DialogoLiberacaoViewModel)venda.Dialogo!;
        Assert.Equal(Core.Caixa.PermissoesPdv.ConfigFiscal, dialogo.Pedido.Permissao);
        dialogo.Pedido.Usuario = "2";
        dialogo.Pedido.Pin = "4321";
        dialogo.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "liberação concedida");
    }

    [AvaloniaFact]
    public async Task Lacuna_bloqueia_a_venda_nova_e_o_supervisor_declara_pelo_f11_s()
    {
        var (pdv, venda, sync) = await IniciarAsync();
        using var _ = pdv;
        sync.Lacuna = new LacunaEventos(1048, 1049, false);

        await pdv.EntrarCodigoAsync("0044");
        Assert.True(venda.CaixaLivre);
        Assert.Equal(ServicoVenda.MensagemLacuna("1048–1049"), pdv.Texto("TextoMensagem"));

        var status = await StatusAsync(pdv, venda);
        Assert.Contains(status.Linhas, l => l.StartsWith("Lacuna de eventos:   1048–1049", StringComparison.Ordinal));
        Assert.Equal("[F4] Declarar a lacuna de eventos 1048–1049 (supervisor com pdv.config.fiscal)", pdv.Texto("TextoLacunaSync"));
        pdv.Captura("36-lacuna-status-sync");

        // MARIA não tem pdv.config.fiscal (só o Master tem, no perfil padrão): o PIN de CARLOS libera.
        pdv.Tecla(Key.F4);
        await LiberarComCarlosAsync(pdv, venda, "Banco do caixa trocado");
        Assert.Equal([(Carlos, (string?)"Banco do caixa trocado")], sync.Declaracoes);
        Assert.Equal("Lacuna de eventos 1048–1049 declarada na nuvem com liberação de CARLOS. Vendas liberadas.", pdv.Texto("TextoMensagem"));

        await pdv.EntrarCodigoAsync("0044");
        Assert.False(venda.CaixaLivre);
    }

    [AvaloniaFact]
    public async Task Lacuna_recuperavel_nao_bloqueia_e_o_f4_libera_o_reenvio()
    {
        var (pdv, venda, sync) = await IniciarAsync();
        using var _ = pdv;
        sync.Lacuna = new LacunaEventos(7, 7, true);

        // Nada se perdeu (os eventos estão no caixa): a venda nova segue.
        await pdv.EntrarCodigoAsync("0044");
        Assert.False(venda.CaixaLivre);

        await StatusAsync(pdv, venda);
        Assert.Equal("[F4] Liberar o reenvio dos eventos da lacuna 7 (supervisor com pdv.config.fiscal)", pdv.Texto("TextoLacunaSync"));
        pdv.Tecla(Key.F4);
        await LiberarComCarlosAsync(pdv, venda, "Eventos achados no pendrive");
        Assert.Equal([Carlos], sync.Recuperacoes);
        Assert.Empty(sync.Declaracoes);
        Assert.Equal("Reenvio dos eventos da lacuna 7 liberado por CARLOS.", pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Operador_com_pdv_config_fiscal_declara_pelo_f4_sem_pedir_liberacao()
    {
        // CARLOS (Master) tem a permissão: o F4 declara em nome dele, sem PIN e sem observação.
        var (pdv, venda, sync) = await IniciarAsync("2", "4321");
        using var _ = pdv;
        sync.Lacuna = new LacunaEventos(1048, 1049, false);
        sync.Falha = new RegraNegocioException("A nuvem recusou a lacuna 1048–1049: a nuvem espera a sequência 1050.");

        var status = await StatusAsync(pdv, venda);
        pdv.Tecla(Key.F4);
        // A recusa fica no próprio diálogo, que continua aberto (nada de pedido de liberação).
        await pdv.EsperarAsync(() => status.Erro is not null, "erro da declaração");
        Assert.Equal("A nuvem recusou a lacuna 1048–1049: a nuvem espera a sequência 1050.", status.Erro);
        Assert.Same(status, venda.Dialogo);
        Assert.Empty(sync.Declaracoes);

        sync.Falha = null;
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "lacuna declarada");
        Assert.Equal([(Carlos, (string?)null)], sync.Declaracoes);
        Assert.Equal("Lacuna de eventos 1048–1049 declarada na nuvem. Vendas liberadas.", pdv.Texto("TextoMensagem"));
    }
}
