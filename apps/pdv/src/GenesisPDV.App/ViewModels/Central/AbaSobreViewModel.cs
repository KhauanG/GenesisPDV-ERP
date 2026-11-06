using System.Collections.ObjectModel;
using System.Globalization;
using System.Runtime.InteropServices;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>Uma linha do "Sobre o terminal": o rótulo e o valor (já mascarado).</summary>
public sealed record LinhaSobre(string Rotulo, string Valor);

/// <summary>
/// Aba 9 da Central do PDV, <b>Sobre o terminal</b> (bloco G4; plano 4; spec 6.1; PC-7: qualquer usuário do caixa vê, só
/// leitura, sem PIN): empresa, loja, caixa, o código curto do terminal (o que o suporte pede, decisão 67) e o
/// <c>terminal_id</c>, o servidor, a situação, a versão do app e do banco, a última migração, o sistema, quando foi
/// ativado, as pastas e o tamanho do banco, dos logs e dos backups. Nada secreto (nem token, nem chave): as pastas passam
/// pelo <see cref="MascaradorSuporte"/> (a do perfil do Windows vira <c>%USERPROFILE%</c>). Botão (e Ctrl+C) "Copiar o
/// código para o suporte"; F5 atualiza; Esc volta ao menu.
/// </summary>
public sealed partial class AbaSobreViewModel : ViewModelBase
{
    private readonly ShellViewModel _shell;
    private readonly Func<Task> _voltar;

    public AbaSobreViewModel(ShellViewModel shell, Func<Task> voltar)
    {
        _shell = shell;
        _voltar = voltar;
        var identidade = shell.Servico<SessaoTerminal>().Identidade;
        CodigoTerminal = identidade?.CodigoCurto ?? "—";
        // Já na abertura da aba (da identidade em memória): o Enter antes de terminar de carregar copia o código certo.
        TextoParaCopiar = TextoCopia(identidade);
    }

    public string Titulo => AbasCentral.Sobre.Rotulo;

    public string CodigoTerminal { get; }

    /// <summary>O que vai para a área de transferência: o código curto, o id completo e a versão.</summary>
    [ObservableProperty]
    public partial string TextoParaCopiar { get; set; }

    public ObservableCollection<LinhaSobre> Linhas { get; } = [];

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial bool Carregando { get; set; }

    /// <summary>A tela copia <see cref="TextoParaCopiar"/> para a área de transferência (a do Windows, pela janela).</summary>
    public event Func<string, Task<bool>>? CopiaSolicitada;

    /// <summary>A tela leva o foco ao botão de copiar (o 9 de novo no menu).</summary>
    public event EventHandler? FocoSolicitado;

    public void Focar() => FocoSolicitado?.Invoke(this, EventArgs.Empty);

    public async Task AtualizarAsync()
    {
        Carregando = true;
        try
        {
            var (linhas, copiar) = await Task.Run(MontarAsync);
            TextoParaCopiar = copiar;
            Linhas.Clear();
            foreach (var linha in linhas)
            {
                Linhas.Add(linha);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _shell.Servico<ILogger<AbaSobreViewModel>>().LogError(e, "Falha ao montar o Sobre o terminal");
            Mensagem = $"Não deu para ler tudo agora ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
        }
        finally
        {
            Carregando = false;
        }
    }

    [RelayCommand]
    private Task Atualizar()
    {
        Mensagem = null;
        return AtualizarAsync();
    }

    [RelayCommand]
    private async Task Copiar()
    {
        var copiado = CopiaSolicitada is { } copiar && await copiar(TextoParaCopiar);
        Mensagem = copiado
            ? $"Copiado: {TextoParaCopiar}. Cole na conversa com o suporte (Ctrl+V)."
            : $"Não deu para copiar aqui: dite ao suporte o código {CodigoTerminal}.";
    }

    [RelayCommand]
    private Task Voltar() => _voltar();

    /// <summary>Fora da thread da tela (tamanho das pastas, banco): devolve as linhas e o texto a copiar.</summary>
    private async Task<(List<LinhaSobre> Linhas, string Copiar)> MontarAsync()
    {
        var sessao = _shell.Servico<SessaoTerminal>();
        var caminhos = _shell.Servico<CaminhosPdv>();
        var disco = _shell.Servico<MedidorDisco>();
        var fuso = DiaOperacional.ObterFuso(sessao.FusoHorario);
        string Hora(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, fuso).ToString("dd/MM/yyyy HH:mm", NumeroBr.Cultura);

        await using var db = await _shell.Servico<IDbContextFactory<PdvDbContext>>().CreateDbContextAsync();
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync();
        var migracoes = (await db.Database.GetAppliedMigrationsAsync()).ToList();
        var resumo = identidade is { Demonstracao: false }
            ? await _shell.Servico<RepositorioTerminal>().ObterConfiguracaoAsync<TerminalAtivado>(ChavesConfiguracaoTerminal.ResumoAtivacao)
            : null;
        var linhas = new List<LinhaSobre>();
        if (identidade is null)
        {
            linhas.Add(new("Terminal", "ainda não ativado"));
        }
        else
        {
            var codigoEmpresa = identidade.EmpresaCodigo.ToString(CultureInfo.InvariantCulture);
            linhas.Add(new("Empresa", identidade.Demonstracao
                ? "Demonstração (sem empresa)"
                : resumo is { RazaoSocial: { Length: > 0 } razao } ? $"{codigoEmpresa} · {razao}" : codigoEmpresa));
            linhas.Add(new("Loja", $"{sessao.LojaCodigo} · {sessao.NomeLoja}"));
            linhas.Add(new("Caixa", identidade.NumeroCaixa.ToString("00", CultureInfo.InvariantCulture)));
            linhas.Add(new("Código do terminal", identidade.CodigoCurto));
            linhas.Add(new("Identificador completo", identidade.TerminalId.ToString()));
            linhas.Add(new("Servidor", identidade.Demonstracao
                ? "Demonstração (sem nuvem: nada sobe nem desce)"
                : Uri.TryCreate(identidade.UrlApi, UriKind.Absolute, out var url) ? url.Host : "—"));
            linhas.Add(new("Situação do terminal", identidade.Status switch
            {
                StatusIdentidade.Desativando => "em desativação",
                StatusIdentidade.Revogado => "desativado pelo ERP",
                _ => "ativo",
            }));
            linhas.Add(new("Ativado em", Hora(identidade.AtivadoEm)));
            linhas.Add(new("Nome do computador", identidade.NomeMaquina is { Length: > 0 } nome ? nome : Environment.MachineName));
        }

        linhas.Add(new("Versão do GenesisPDV", VersaoApp.Atual));
        linhas.Add(new("Versão do banco local", $"{migracoes.Count} migrações · a última: {migracoes.LastOrDefault() ?? "—"}"));
        linhas.Add(new("Sistema", $"{RuntimeInformation.OSDescription} ({RuntimeInformation.OSArchitecture})"));
        var livre = disco.LivreBytes();
        linhas.Add(new("Disco livre", livre is { } l ? MedidorDisco.Legivel(l) : "não deu para medir"));
        linhas.Add(new("Banco local", $"{MedidorDisco.Legivel(disco.TamanhoBanco())} · {Pasta(caminhos.ArquivoBanco)}"));
        linhas.Add(new("Logs", $"{MedidorDisco.Legivel(disco.TamanhoLogs())} · {Pasta(caminhos.PastaLogs)}"));
        var backups = Directory.Exists(caminhos.PastaBackup) ? Directory.EnumerateFiles(caminhos.PastaBackup).Count() : 0;
        linhas.Add(new("Backups", $"{backups} arquivo(s), {MedidorDisco.Legivel(disco.TamanhoBackups())} · {Pasta(caminhos.PastaBackup)}"));
        return (linhas, TextoCopia(identidade));
    }

    /// <summary>"código · terminal id · versão" (o que o suporte pede).</summary>
    private static string TextoCopia(IdentidadeTerminal? identidade) => identidade is null
        ? $"GenesisPDV {VersaoApp.Atual} (terminal não ativado)"
        : $"{identidade.CodigoCurto} · terminal {identidade.TerminalId} · GenesisPDV {VersaoApp.Atual}";

    private static string Pasta(string caminho) => MascaradorSuporte.Mascarar(Path.GetFullPath(caminho)) ?? caminho;
}
