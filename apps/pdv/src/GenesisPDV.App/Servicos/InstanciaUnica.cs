using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Um GenesisPDV aberto por computador (SYNC 23, cenário 13; implantação I3, README › decisão 62): um mutex nomeado no
/// espaço global, preso pela thread principal enquanto o app roda. O instalador do Windows procura o mesmo nome
/// (<c>AppMutex</c> do Inno Setup) e, achando o PDV aberto, pede para fechá-lo pelo próprio programa — a saída normal
/// faz o backup de saída e o <c>encerramento.json</c> (C17) — antes de atualizar ou desinstalar.
/// No Windows o mutex sai com permissão de sincronizar para Todos: o instalador roda elevado, às vezes com outra conta
/// de administrador, e sem essa permissão o <c>OpenMutex</c> dele falharia e ele seguiria com o PDV aberto.
/// Falha ao criar o mutex (ex.: no Linux, criado antes por outro usuário) não impede o caixa de abrir: só o log.
/// </summary>
public sealed class InstanciaUnica : IDisposable
{
    public const string NomePadrao = @"Global\GenesisPDV.Instancia";

    /// <summary>Argumento do processo novo do reinício (C17): espera o anterior soltar o mutex em vez de desistir.</summary>
    public const string ArgumentoReinicio = "--reinicio";

    /// <summary>Quanto o processo do reinício espera: cobre o prazo de 60 s do backup de saída do anterior.</summary>
    public static readonly TimeSpan EsperaReinicio = TimeSpan.FromSeconds(90);

    private Mutex? _mutex;

    private InstanciaUnica(Mutex? mutex, string? falhaTrava = null)
    {
        _mutex = mutex;
        FalhaTrava = falhaTrava;
    }

    /// <summary>Pode abrir: este processo ficou com o mutex, ou não havia como travar (<see cref="FalhaTrava"/>).</summary>
    public bool PodeAbrir => _mutex is not null || FalhaTrava is not null;

    /// <summary>Por que o app segue sem a trava (o mutex não pôde ser criado); nulo quando ela está ativa ou é de outro PDV.</summary>
    public string? FalhaTrava { get; }

    /// <summary>
    /// Tenta ficar com o mutex, esperando até <paramref name="espera"/> (zero no início normal). Com outro PDV aberto,
    /// <see cref="PodeAbrir"/> é falso.
    /// </summary>
    public static InstanciaUnica Adquirir(string nome, TimeSpan espera)
    {
        Mutex mutex;
        try
        {
            mutex = OperatingSystem.IsWindows() ? CriarWindows(nome) : new Mutex(false, nome);
        }
        catch (UnauthorizedAccessException) when (OperatingSystem.IsWindows())
        {
            // O mutex existe e é de outra conta (só o direito de sincronizar): há um PDV aberto. No Windows o objeto some
            // com o último handle, então isso nunca é resto de um processo morto.
            return new InstanciaUnica(null);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or WaitHandleCannotBeOpenedException or NotSupportedException)
        {
            // Linux: o arquivo do mutex global de outro usuário pode ficar para trás; aqui a trava não pode impedir o caixa.
            return new InstanciaUnica(null, e.Message);
        }

        try
        {
            if (mutex.WaitOne(espera))
            {
                return new InstanciaUnica(mutex);
            }
        }
        catch (AbandonedMutexException)
        {
            // O PDV anterior morreu sem soltar (queda, kill): o mutex agora é deste processo.
            return new InstanciaUnica(mutex);
        }

        mutex.Dispose();
        return new InstanciaUnica(null);
    }

    public void Dispose()
    {
        if (_mutex is null)
        {
            return;
        }

        try
        {
            _mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // Já solto (ou de outra thread): o Dispose fecha o handle de qualquer jeito.
        }

        _mutex.Dispose();
        _mutex = null;
    }

    /// <summary>
    /// Aviso do segundo PDV aberto. No Windows uma caixa de mensagem (o Avalonia ainda não subiu); no Linux só o log.
    /// </summary>
    public static void AvisarJaAberto()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                _ = MessageBoxW(IntPtr.Zero,
                    "O GenesisPDV já está aberto neste computador.\n\nUse a janela que já está aberta (procure na barra de tarefas).",
                    "GenesisPDV", 0x00000040 /* MB_ICONINFORMATION */);
            }
            catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
            {
                // Sem user32 (Windows Server Core, por exemplo): fica o log de quem chamou.
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private static Mutex CriarWindows(string nome)
    {
        var seguranca = new MutexSecurity();
        if (WindowsIdentity.GetCurrent().User is { } usuario)
        {
            seguranca.AddAccessRule(new MutexAccessRule(usuario, MutexRights.FullControl, AccessControlType.Allow));
        }

        seguranca.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), MutexRights.FullControl, AccessControlType.Allow));
        seguranca.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), MutexRights.FullControl, AccessControlType.Allow));
        seguranca.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), MutexRights.Synchronize, AccessControlType.Allow));
        return MutexAcl.Create(false, nome, out _, seguranca);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr janela, string texto, string titulo, uint tipo);
}
