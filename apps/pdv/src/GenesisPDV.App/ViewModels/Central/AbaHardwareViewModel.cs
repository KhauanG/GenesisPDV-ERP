using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>
/// Aba 3 da Central do PDV, "Impressora e gaveta" (PDV 6; implantação I4, decisão 63; Central do PDV, bloco G3, decisão
/// 68 do README): a antiga tela de configuração do terminal, movida para dentro da Central sem mudar o que faz. Abre com
/// <c>pdv.config.terminal</c> do usuário da Central (pelo login, também com <c>pdv.supervisor</c>, como o Ctrl+Alt+C de
/// antes); sem isso, a própria aba pede a liberação de quem a tem (usuário e PIN, PDV 31.3; o "Liberar" da Central não
/// empresta permissão de ação), que vale só enquanto a aba fica aberta (<see cref="PorLiberacao"/>). Impressora (modelo, conexão, papel, corte,
/// página de código, QR), gaveta (ligada, pino, pulso, nos movimentos) e a tela do caixa (barra de funções e pesquisa só
/// por números, versão 0.9.1), com F5 Imprimir teste e F6 Abrir gaveta (teste) usando o que está na tela, F2 Salvar
/// (grava e audita antes/depois), F7/F8 a fila de impressão (nova tentativa, descartar) e, só na Central aberta pelo
/// login, F9 Restaurar backup (C17), que pede o PIN na hora na própria tela (plano 3.3). Esc volta ao menu da Central.
/// </summary>
public sealed partial class AbaHardwareViewModel : ViewModelBase
{
    public const string EtapaLiberar = "liberar";
    public const string EtapaEditar = "editar";

    public const string MensagemSalva = "Configuração salva.";
    public const string MensagemTesteEnviado = "Teste enviado à impressora.";

    /// <summary>A ordem das listas é a dos enums (o índice da tela é o valor).</summary>
    public static IReadOnlyList<string> Conexoes { get; } =
    [
        "Nenhuma (o caixa vende sem imprimir)",
        "Impressora instalada no Windows (USB, padrão)",
        "Rede (IP, porta 9100)",
        "Serial / COM virtual do USB",
        "Dispositivo do Linux (/dev/usb/lp0)",
        "Simulada (arquivos na pasta impressao)",
    ];

    public static IReadOnlyList<string> Modelos { get; } = [.. PerfilImpressora.Todos.Select(p => p.Nome)];

    /// <summary>As colunas dependem do modelo (a TM-T88 tem 42/30): a tela as mostra em <see cref="ColunasTexto"/>.</summary>
    public static IReadOnlyList<string> Papeis { get; } = ["80 mm (bobina comum)", "58 mm (bobina estreita)"];

    public static IReadOnlyList<string> Cortes { get; } = ["Corte parcial", "Corte total", "Sem corte"];

    /// <summary>0 = a do modelo; 1–3 = <see cref="PaginaCodigo"/> + 1.</summary>
    public static IReadOnlyList<string> Paginas { get; } = ["A do modelo (CP860)", "CP860 (português)", "CP850 (multilíngue)", "WPC1252 (só Epson)"];

    /// <summary>0 = o do modelo; 1 = nativo; 2 = imagem.</summary>
    public static IReadOnlyList<string> ModosQr { get; } = ["O do modelo", "Nativo da impressora", "Imagem"];

    public static IReadOnlyList<string> Pinos { get; } = ["Pino 2", "Pino 5"];

    /// <summary>0 = botões clicáveis (padrão); 1 = só o texto das teclas (decisão 65).</summary>
    public static IReadOnlyList<string> BarrasFuncoes { get; } = ["Botões (padrão: mouse, toque e teclas F)", "Texto (só as teclas F)"];

    private readonly ShellViewModel _shell;
    private readonly Operador _usuario;
    private readonly Func<Task> _voltar;
    private Guid? _usuarioId;
    private Guid? _autorizadoPorId;

    /// <param name="usuario">Quem está na Central (o operador logado na venda ou quem digitou o PIN no login).</param>
    /// <param name="origem">
    /// Pelo login, quem tem <c>pdv.config.terminal</c> e <c>pdv.supervisor</c> (o que o Ctrl+Alt+C de antes exigia)
    /// digitou o PIN agora e fica também como quem autorizou (a auditoria igual à de antes da Central); pela venda, o
    /// operador com <c>pdv.config.terminal</c> grava sozinho.
    /// </param>
    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    public AbaHardwareViewModel(ShellViewModel shell, Operador usuario, OrigemCentral origem, Func<Task> voltar)
    {
        _shell = shell;
        _usuario = usuario;
        _voltar = voltar;
        Origem = origem;
        if (AbreDireto(usuario, origem))
        {
            _usuarioId = usuario.Id;
            _autorizadoPorId = origem == OrigemCentral.Login ? usuario.Id : null;
            Etapa = EtapaEditar;
        }
        else
        {
            Etapa = EtapaLiberar;
        }

        var hardware = shell.Servico<ServicoHardware>();
        Preencher(hardware.Atual);
        BarraFuncoesIndice = hardware.Preferencias.BarraBotoes ? 0 : 1;
        PesquisaSoNumeros = hardware.Preferencias.PesquisaSoNumeros;
    }

    public OrigemCentral Origem { get; }

    /// <summary>
    /// A aba abre editável sem pedir ninguém: com <c>pdv.config.terminal</c> do usuário da Central e, pelo login, também
    /// <c>pdv.supervisor</c> (o que o Ctrl+Alt+C de antes exigia). O menu da Central usa a mesma regra para o cadeado.
    /// </summary>
    public static bool AbreDireto(Operador usuario, OrigemCentral origem) =>
        usuario.Tem(PermissoesPdv.ConfigTerminal) && (origem == OrigemCentral.Venda || usuario.Tem(PermissoesPdv.Supervisor));

    /// <summary>"Restaurar backup" só na Central aberta pelo login (com o caixa aberto, não; C17).</summary>
    public bool PodeRestaurarBackup => Origem == OrigemCentral.Login;

    /// <summary>O botão do F9: só pelo login e depois da permissão (quem não tem <c>pdv.config.terminal</c> não o vê).</summary>
    public bool MostraRestaurar => Editando && PodeRestaurarBackup;

    /// <summary>
    /// Editável só pela liberação dada na própria aba (o usuário da Central não tem a permissão): a Central descarta a
    /// aba ao trocar para outra, e a volta pede a liberação de novo (como sair da configuração do terminal de antes).
    /// </summary>
    public bool PorLiberacao { get; private set; }

    [ObservableProperty]
    public partial string Etapa { get; set; }

    public bool Liberando => Etapa == EtapaLiberar;

    public bool Editando => Etapa == EtapaEditar;

    [ObservableProperty]
    public partial string Usuario { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Pin { get; set; } = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ColunasTexto))]
    public partial int ModeloIndice { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ConexaoSpooler), nameof(ConexaoRede), nameof(ConexaoSerial), nameof(ConexaoDispositivo))]
    public partial int ConexaoIndice { get; set; }

    public bool ConexaoSpooler => ConexaoIndice == (int)TipoConexao.Spooler;

    public bool ConexaoRede => ConexaoIndice == (int)TipoConexao.Rede;

    public bool ConexaoSerial => ConexaoIndice == (int)TipoConexao.Serial;

    public bool ConexaoDispositivo => ConexaoIndice == (int)TipoConexao.Dispositivo;

    /// <summary>Impressoras instaladas no Windows (<c>EnumPrinters</c>); vazia no Linux.</summary>
    public ObservableCollection<string> ImpressorasWindows { get; } = [];

    [ObservableProperty]
    public partial string? ImpressoraEscolhida { get; set; }

    [ObservableProperty]
    public partial string NomeSpooler { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Endereco { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string PortaRede { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Porta { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Baud { get; set; } = string.Empty;

    /// <summary>"Portas encontradas: COM1, COM3" (a COM virtual do USB aparece aqui depois de instalar o driver).</summary>
    public string PortasSeriais { get; private set; } = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ColunasTexto))]
    public partial int PapelIndice { get; set; }

    /// <summary>"48 colunas por linha (Epson TM-T20 no 80 mm)": o que a régua do teste deve mostrar numa linha só.</summary>
    public string ColunasTexto
    {
        get
        {
            var perfil = PerfilImpressora.Todos[Math.Clamp(ModeloIndice, 0, Modelos.Count - 1)];
            var papel = PapelIndice == 1 ? LarguraPapel.Mm58 : LarguraPapel.Mm80;
            return $"{perfil.Colunas(papel)} colunas por linha ({perfil.Nome} no {(papel == LarguraPapel.Mm58 ? "58" : "80")} mm)";
        }
    }

    [ObservableProperty]
    public partial int CorteIndice { get; set; }

    [ObservableProperty]
    public partial string LinhasAvanco { get; set; } = string.Empty;

    [ObservableProperty]
    public partial int PaginaIndice { get; set; }

    [ObservableProperty]
    public partial int QrIndice { get; set; }

    [ObservableProperty]
    public partial bool GavetaLigada { get; set; }

    [ObservableProperty]
    public partial int PinoIndice { get; set; }

    [ObservableProperty]
    public partial string PulsoMs { get; set; } = string.Empty;

    [ObservableProperty]
    public partial bool GavetaNosMovimentos { get; set; }

    /// <summary>Barra de funções da tela de venda (<see cref="BarrasFuncoes"/>).</summary>
    [ObservableProperty]
    public partial int BarraFuncoesIndice { get; set; }

    /// <summary>Pesquisa de produto só por números (padrão: desligada).</summary>
    [ObservableProperty]
    public partial bool PesquisaSoNumeros { get; set; }

    /// <summary>As preferências da tela como estão na tela (sem gravar).</summary>
    public PreferenciasCaixa MontarPreferencias() => new(BarraFuncoesIndice != 1, PesquisaSoNumeros);

    [ObservableProperty]
    public partial int Pendentes { get; set; }

    public string PendentesTexto => Pendentes == 0
        ? "Fila de impressão: nada pendente."
        : string.Create(CultureInfo.GetCultureInfo("pt-BR"), $"Fila de impressão: {Pendentes} documento(s) que não saíram (F7 tenta de novo, F8 descarta).");

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    partial void OnEtapaChanged(string value)
    {
        OnPropertyChanged(nameof(Liberando));
        OnPropertyChanged(nameof(Editando));
        OnPropertyChanged(nameof(MostraRestaurar));
    }

    partial void OnPendentesChanged(int value) => OnPropertyChanged(nameof(PendentesTexto));

    partial void OnImpressoraEscolhidaChanged(string? value)
    {
        if (value is not null)
        {
            NomeSpooler = value;
        }
    }

    public async Task CarregarAsync()
    {
        ImpressorasWindows.Clear();
        var lista = OperatingSystem.IsWindows() ? await Task.Run(TransporteSpoolerWindows.Listar) : [];
        foreach (var nome in lista)
        {
            ImpressorasWindows.Add(nome);
        }

        if (!string.IsNullOrWhiteSpace(NomeSpooler) && ImpressorasWindows.Contains(NomeSpooler))
        {
            ImpressoraEscolhida = NomeSpooler;
        }

        var portas = await Task.Run(PortaSerialSistema.Listar);
        PortasSeriais = portas.Count == 0 ? "Nenhuma porta serial encontrada." : $"Portas encontradas: {string.Join(", ", portas)}";
        OnPropertyChanged(nameof(PortasSeriais));
        await AtualizarPendentesAsync();
    }

    private void Preencher(ConfiguracaoHardware c)
    {
        var i = c.Impressora;
        ModeloIndice = PerfilImpressora.Todos.ToList().FindIndex(p => p.Modelo == i.Modelo);
        ConexaoIndice = (int)i.Conexao;
        NomeSpooler = i.NomeSpooler ?? string.Empty;
        Endereco = i.Endereco ?? string.Empty;
        PortaRede = i.PortaRede.ToString(CultureInfo.InvariantCulture);
        Porta = i.Porta ?? (i.Conexao == TipoConexao.Dispositivo ? ConfiguracaoImpressora.DispositivoPadrao : string.Empty);
        Baud = i.Baud.ToString(CultureInfo.InvariantCulture);
        PapelIndice = (int)i.Papel;
        CorteIndice = (int)i.Guilhotina;
        LinhasAvanco = i.LinhasAvanco.ToString(CultureInfo.InvariantCulture);
        PaginaIndice = i.Pagina is { } p ? (int)p + 1 : 0;
        QrIndice = i.QrNativo switch { true => 1, false => 2, null => 0 };
        GavetaLigada = c.Gaveta.Ligada;
        PinoIndice = c.Gaveta.Pino == 5 ? 1 : 0;
        PulsoMs = c.Gaveta.PulsoMs.ToString(CultureInfo.InvariantCulture);
        GavetaNosMovimentos = c.Gaveta.AbreNosMovimentos;
    }

    /// <summary>A configuração da tela (sem gravar); números inválidos viram a mensagem.</summary>
    public ConfiguracaoHardware Montar()
    {
        static int Inteiro(string texto, string campo) =>
            int.TryParse(texto.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)
                ? n
                : throw new RegraNegocioException($"{campo}: informe um número.");

        var conexao = (TipoConexao)Math.Clamp(ConexaoIndice, 0, Conexoes.Count - 1);
        var impressora = new ConfiguracaoImpressora
        {
            Modelo = PerfilImpressora.Todos[Math.Clamp(ModeloIndice, 0, Modelos.Count - 1)].Modelo,
            Conexao = conexao,
            NomeSpooler = Vazio(NomeSpooler),
            Endereco = Vazio(Endereco),
            PortaRede = conexao == TipoConexao.Rede ? Inteiro(PortaRede, "Porta de rede") : ConfiguracaoImpressora.PortaRedePadrao,
            Porta = Vazio(Porta),
            Baud = conexao == TipoConexao.Serial ? Inteiro(Baud, "Velocidade da serial") : ConfiguracaoImpressora.BaudPadrao,
            Papel = PapelIndice == 1 ? LarguraPapel.Mm58 : LarguraPapel.Mm80,
            Guilhotina = (Guilhotina)Math.Clamp(CorteIndice, 0, 2),
            LinhasAvanco = Inteiro(LinhasAvanco, "Linhas de avanço"),
            Pagina = PaginaIndice is >= 1 and <= 3 ? (PaginaCodigo)(PaginaIndice - 1) : null,
            QrNativo = QrIndice switch { 1 => true, 2 => false, _ => null },
        };
        var gaveta = new ConfiguracaoGaveta(GavetaLigada, PinoIndice == 1 ? 5 : 2, Inteiro(PulsoMs, "Pulso da gaveta"), GavetaNosMovimentos);
        if ((impressora.Validar() ?? gaveta.Validar()) is { } erro)
        {
            throw new RegraNegocioException(erro);
        }

        return new ConfiguracaoHardware(impressora, gaveta);
    }

    private static string? Vazio(string texto) => string.IsNullOrWhiteSpace(texto) ? null : texto.Trim();

    [RelayCommand]
    private async Task AvancarAsync()
    {
        if (Ocupado || !Liberando)
        {
            return;
        }

        await Ocupar(async () =>
        {
            // Como no F11 › 8 de antes da Central: o supervisor com pdv.config.terminal, que não seja o próprio usuário.
            var r = await _shell.Servico<IAutenticadorOperador>()
                .LiberarAsync(Usuario, Pin, PermissoesPdv.ConfigTerminal, _usuario.Id, _shell.Servico<IRelogio>().Agora);
            Pin = string.Empty;
            if (r.Supervisor is not { } supervisor)
            {
                Erro = r.Erro;
                return;
            }

            _usuarioId = _usuario.Id;
            _autorizadoPorId = supervisor.Id;
            PorLiberacao = true;
            Etapa = EtapaEditar;
        });
    }

    [RelayCommand]
    private Task SalvarAsync() => Editar(async () =>
    {
        var nova = Montar();
        await _shell.Servico<ServicoHardware>().GravarAsync(nova, MontarPreferencias(), _usuarioId, _autorizadoPorId);
        Mensagem = MensagemSalva + (nova.Impressora.Configurada ? " Faça o teste (F5) com o papel na impressora." : " Sem impressora: o caixa vende sem imprimir.");
    });

    [RelayCommand]
    private Task TestarAsync() => Editar(async () =>
    {
        var c = Montar().Impressora;
        var sessao = _shell.Servico<SessaoTerminal>();
        var quando = TimeZoneInfo.ConvertTime(_shell.Servico<IRelogio>().Agora, Core.Comum.DiaOperacional.ObterFuso(sessao.FusoHorario))
            .ToString("dd/MM/yyyy HH:mm", CultureInfo.GetCultureInfo("pt-BR"));
        try
        {
            await _shell.Servico<ImpressoraDoTerminal>().ImprimirAsync(LayoutTesteImpressao.Gerar(c, sessao.NomeLoja, quando), c);
            Mensagem = c.Conexao == TipoConexao.Simulada
                ? $"{MensagemTesteEnviado} (simulada: pasta {_shell.Servico<Data.CaminhosPdv>().PastaImpressao})"
                : MensagemTesteEnviado + " Confira os acentos e a régua; acento errado: troque a página de código.";
        }
        catch (FalhaImpressoraException e)
        {
            throw new RegraNegocioException($"O teste não saiu: {e.Message}");
        }
    });

    [RelayCommand]
    private Task TestarGavetaAsync() => Editar(async () =>
    {
        await _shell.Servico<ServicoGaveta>().TestarAsync(Montar(), _usuarioId, _autorizadoPorId, _shell.Servico<SessaoTerminal>().SessaoCaixaId);
        Mensagem = "Pulso enviado à gaveta.";
    });

    [RelayCommand]
    private Task ImprimirPendentesAsync() => Editar(async () =>
    {
        var (impressos, erro) = await _shell.Servico<ServicoImpressao>().ImprimirPendentesAsync();
        await AtualizarPendentesAsync();
        if (erro is not null)
        {
            throw new RegraNegocioException($"{impressos} impresso(s); parou em: {erro}");
        }

        Mensagem = $"{impressos} documento(s) da fila impresso(s) (com a configuração salva).";
    });

    [RelayCommand]
    private Task DescartarPendentesAsync() => Editar(async () =>
    {
        var descartados = await _shell.Servico<ServicoImpressao>().DescartarPendentesAsync();
        await AtualizarPendentesAsync();
        Mensagem = $"{descartados} documento(s) tirado(s) da fila (a reimpressão pelo F12 continua).";
    });

    /// <summary>
    /// F9: a tela do "Restaurar backup" pede ela mesma o usuário e o PIN de quem tem <c>pdv.supervisor</c> e
    /// <c>pdv.config.terminal</c> (PIN na hora, plano 3.3: nem o PIN da entrada na Central nem a liberação da aba valem
    /// para a ação destrutiva). Ocupada enquanto a lista carrega; a tela só abre se a Central ainda estiver na frente.
    /// </summary>
    [RelayCommand]
    private Task RestaurarBackupAsync() =>
        Ocupado || !Editando || !PodeRestaurarBackup ? Task.CompletedTask : Ocupar(() => _shell.IrParaRestaurarBackupAsync(_shell.PaginaAtual));

    [RelayCommand]
    private Task VoltarAsync() => Ocupado ? Task.CompletedTask : _voltar();

    private async Task AtualizarPendentesAsync() => Pendentes = await _shell.Servico<ServicoImpressao>().ContarPendentesAsync();

    private Task Editar(Func<Task> acao) => Ocupado || !Editando ? Task.CompletedTask : Ocupar(acao);

    private async Task Ocupar(Func<Task> acao)
    {
        Ocupado = true;
        Erro = null;
        Mensagem = null;
        try
        {
            await acao();
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Nada aqui derruba o caixa: a falha vai para o log e para a tela.
            _shell.Servico<ILogger<AbaHardwareViewModel>>().LogError(e, "Falha na aba Impressora e gaveta da Central do PDV");
            Erro = $"Não deu certo ({e.Message}).";
        }
        finally
        {
            Ocupado = false;
        }
    }
}
