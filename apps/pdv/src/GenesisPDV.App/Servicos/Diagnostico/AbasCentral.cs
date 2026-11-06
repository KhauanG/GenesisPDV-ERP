using GenesisPDV.Core.Caixa;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>
/// Uma aba da Central do PDV (a engrenagem; plano 4): o código do menu lateral (0 a 9 e P), o nome, a permissão que a
/// abre e se abrir a aba grava a auditoria local <see cref="AcessoCentral.AcaoCentralAcessada"/>.
/// </summary>
public sealed record AbaCentral(string Codigo, string Nome, string Permissao, bool RegistraAcesso)
{
    /// <summary>Como aparece no menu e na auditoria: <c>4 Sincronização</c>.</summary>
    public string Rotulo => $"{Codigo} {Nome}";
}

/// <summary>
/// As abas da Central (Central do PDV, bloco G2; plano 3.3 e 4; decisões do dono de 04/11/2026; README › decisão 67). A
/// tela é a <c>CentralPdvViewModel</c> (G3, decisão 68); aqui ficam a ordem, a permissão de cada uma e o que a liberação
/// considera. O Painel de saúde e o
/// Sobre ficam com <c>pdv.acesso.entrar</c>, sem PIN (PC-7). Abrir Sincronização, Logs e Histórico de uso grava o
/// <c>central_acessada</c> (só local); as demais abas gravam a auditoria das próprias ações (reimpressão, edição,
/// exportação).
/// </summary>
public static class AbasCentral
{
    public static readonly AbaCentral Painel = new("0", "Painel de saúde", PermissoesPdv.Entrar, false);
    public static readonly AbaCentral Vendas = new("1", "Vendas", PermissoesPdv.ConsultarVendas, false);
    public static readonly AbaCentral Caixas = new("2", "Caixas", PermissoesPdv.ConsultarFechamentos, false);
    public static readonly AbaCentral ImpressoraGaveta = new("3", "Impressora e gaveta", PermissoesPdv.ConfigTerminal, false);
    public static readonly AbaCentral Sincronizacao = new("4", "Sincronização", PermissoesPdv.VerDiagnostico, true);
    public static readonly AbaCentral Logs = new("5", "Logs e ocorrências", PermissoesPdv.VerDiagnostico, true);
    public static readonly AbaCentral HistoricoUso = new("6", "Histórico de uso", PermissoesPdv.VerAuditoriaLocal, true);
    public static readonly AbaCentral Parametros = new("7", "Parâmetros", PermissoesPdv.VerDiagnostico, false);
    public static readonly AbaCentral Backup = new("8", "Backup", PermissoesPdv.VerDiagnostico, false);
    public static readonly AbaCentral Sobre = new("9", "Sobre o terminal", PermissoesPdv.Entrar, false);
    public static readonly AbaCentral Pacote = new("P", "Pacote de suporte", PermissoesPdv.PacoteSuporte, false);

    public static IReadOnlyList<AbaCentral> Todas { get; } =
        [Painel, Vendas, Caixas, ImpressoraGaveta, Sincronizacao, Logs, HistoricoUso, Parametros, Backup, Sobre, Pacote];

    /// <summary>
    /// Permissões que a liberação ("Liberar", Ctrl+L na Central) pode emprestar: só as de <b>ver</b> as abas e as
    /// consultas (vendas e fechamentos dos caixas fechados, diagnóstico, histórico de uso, pacote de suporte). As de ação
    /// ficam fora mesmo quando abrem uma aba: <c>pdv.config.terminal</c> (aba Impressora e gaveta: editar, testar a
    /// impressora, abrir a gaveta), <c>pdv.config.parametros_locais</c> (editar os parâmetros, fazer backup) e
    /// <c>pdv.documento.reimprimir</c> pedem a própria liberação (31.3), com quem liberou na auditoria da ação. As sem
    /// liberação do catálogo (<see cref="PermissoesPdv.SemLiberacao"/>: o fiscal e o calculado do fechamento, O3) também
    /// nunca entram: o fiscal pede o PIN de quem a tem na hora da ação, como hoje.
    /// </summary>
    public static IReadOnlySet<string> PermissoesLiberaveis { get; } = new HashSet<string>(
        [
            PermissoesPdv.Entrar, PermissoesPdv.ConsultarVendas, PermissoesPdv.ConsultarHistoricoVendas, PermissoesPdv.ConsultarFechamentos,
            PermissoesPdv.VerDiagnostico, PermissoesPdv.VerAuditoriaLocal, PermissoesPdv.PacoteSuporte,
        ],
        StringComparer.Ordinal);
}
