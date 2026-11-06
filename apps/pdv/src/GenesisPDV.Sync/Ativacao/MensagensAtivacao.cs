using System.Net;
using System.Text.Json;
using GenesisPDV.Sync.Cliente;

namespace GenesisPDV.Sync.Ativacao;

/// <summary>
/// Mensagens do assistente para cada recusa da ativação (SYNC 2.5, 3.3; PDV 5.2, 5.5: "mensagem específica e nada é
/// gravado localmente"). O texto fala com quem está instalando o caixa: o que houve e o que fazer no ERP.
/// </summary>
public static class MensagensAtivacao
{
    public const string SemConexao =
        "Sem conexão com o servidor. A ativação exige internet; depois de ativado, o PDV funciona offline. " +
        "Confira o cabo/Wi-Fi e tente de novo (o mesmo código continua valendo).";

    public const string CodigoInvalido =
        "Código de ativação inválido. Confira o código da empresa e o código de ativação ou gere outro no ERP " +
        "(Cadastros › PDVs / Terminais › Gerar código de ativação).";

    public const string CodigoExpirado = "Código de ativação expirado. Gere outro no ERP (Cadastros › PDVs / Terminais).";

    public const string CodigoUsado = "Este código já foi usado para ativar este computador. Gere outro código no ERP.";

    public const string LimitePlano =
        "Limite de terminais do plano atingido. Revogue no ERP um terminal que não está mais em uso ou fale com o " +
        "suporte Genesis para ampliar o plano.";

    public const string CaixaOcupado =
        "Este caixa já tem um terminal ativo. No ERP, gere o código com \"Substituir terminal\" (troca de máquina) " +
        "ou escolha outro caixa.";

    public const string PdvDesabilitado =
        "O PDV está desabilitado para esta loja (\"Usa PDV\" desligado no ERP). Peça ao administrador para ligar e " +
        "gerar outro código.";

    public const string LojaInativa =
        "A loja do código está inativa ou não é um ponto de venda. Confira o cadastro da loja no ERP e gere outro código.";

    public const string IpBloqueado =
        "Muitas tentativas erradas a partir desta rede. Aguarde 30 minutos e tente de novo.";

    public const string AtivacaoBloqueada =
        "Ativações temporariamente bloqueadas para esta empresa (muitas tentativas erradas). Peça ao gerente para usar " +
        "\"Liberar ativações\" em Cadastros › PDVs / Terminais no ERP.";

    public const string Manutencao = "Servidor em manutenção. Tente de novo em instantes (o mesmo código continua valendo).";

    public const string RespostaInvalida =
        "A resposta do servidor não pôde ser conferida. Tente de novo (o mesmo código continua valendo); se repetir, " +
        "chame o suporte.";

    /// <summary>
    /// O banco do caixa foi ativado com outra conta do sistema (implantação I3; D21): o token protegido só abre nela.
    /// Reativar por cima não existe (a nova ativação começa com um banco local novo e os eventos ainda não enviados só
    /// sobem pela conta que ativou), então o caminho normal é entrar com a conta certa.
    /// </summary>
    /// <param name="contaAtivacao">A conta gravada na ativação (<c>ativacao.conta</c>), ou nula num banco ativado antes do I3.</param>
    public static string ContaDiferente(string? contaAtivacao, string contaAtual)
    {
        var sistema = ContaSistema.Sistema;
        var conta = string.IsNullOrWhiteSpace(contaAtivacao) ? "a conta que ativou o caixa" : $"a conta \"{contaAtivacao}\"";
        var ativado = string.IsNullOrWhiteSpace(contaAtivacao)
            ? $"por outra conta do {sistema}"
            : $"pela conta \"{contaAtivacao}\" do {sistema}";
        return $"Este caixa foi ativado {ativado}, e a ativação só abre com essa conta (o GenesisPDV está aberto com a " +
               $"conta \"{contaAtual}\"). Saia do GenesisPDV (Alt+F4), entre no {sistema} com {conta} e abra o GenesisPDV " +
               "de novo: nada foi perdido. Se essa conta não existe mais, chame o suporte: as vendas ainda não enviadas deste " +
               "caixa só sobem por ela, e a reativação (ERP › Cadastros › PDVs / Terminais › Gerar código de ativação) começa " +
               "com um banco local novo.";
    }

    /// <summary>Mensagem do erro devolvido pela API (envelope 2.4).</summary>
    public static string Para(ErroSyncException erro)
    {
        ArgumentNullException.ThrowIfNull(erro);
        return erro.Codigo switch
        {
            "CODIGO_INVALIDO" => CodigoInvalido,
            "CODIGO_EXPIRADO" => CodigoExpirado,
            "CODIGO_USADO" => CodigoUsado,
            "LIMITE_PLANO" => LimitePlano,
            "CAIXA_OCUPADO" => CaixaOcupado,
            "PDV_DESABILITADO" => PdvDesabilitado,
            "LOJA_INATIVA" => LojaInativa,
            "IP_BLOQUEADO" => IpBloqueado,
            "ATIVACAO_BLOQUEADA" => AtivacaoBloqueada,
            "MANUTENCAO" => Manutencao,
            "PROTOCOLO_NAO_SUPORTADO" => VersaoAntiga(erro),
            _ when erro.Status == HttpStatusCode.UpgradeRequired => VersaoAntiga(erro),
            _ when (int)erro.Status >= 500 => Manutencao,
            "REQUISICAO_INVALIDA" =>
                $"O servidor recusou os dados da ativação ({erro.Erro?.Mensagem}). Atualize o PDV ou chame o suporte.",
            _ => $"Falha na ativação (HTTP {(int)erro.Status}{(erro.Codigo is { } c ? " " + c : string.Empty)}): {erro.Message}",
        };
    }

    /// <summary>426: versão do app abaixo da mínima publicada para a plataforma (3.3 item 8, 17.3).</summary>
    private static string VersaoAntiga(ErroSyncException erro)
    {
        var versao = erro.Erro?.Detalhes is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("versao_minima", out var v)
                     && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
        var minima = string.IsNullOrWhiteSpace(versao) ? string.Empty : $" (mínima: {versao})";
        return $"Esta versão do GenesisPDV está desatualizada{minima}. {ComoAtualizar(versao, ativado: false)} Depois, abra o " +
               "GenesisPDV e faça a ativação.";
    }

    /// <summary>
    /// Como atualizar na PDV-1 (PDV 32.6; I3, README do PDV › decisão 62): o instalador da versão nova por cima do PDV
    /// instalado, que mantém banco, backups e ativação. Usada no bloqueio do handshake e no aviso do login (terminal já
    /// ativado) e na recusa da ativação (<paramref name="ativado"/> falso: ainda não há ativação a manter).
    /// </summary>
    public static string ComoAtualizar(string? versao, bool ativado = true)
    {
        var mantem = ativado ? "o banco, os backups e a ativação continuam." : "o banco e os backups continuam.";
        return string.IsNullOrWhiteSpace(versao)
            ? $"Instale a versão mais nova do GenesisPDV pelo instalador, por cima desta: {mantem}"
            : $"Instale o GenesisPDV {versao} ou mais novo pelo instalador (GenesisPDV-Setup-{versao}.exe), por cima deste: {mantem}";
    }
}
