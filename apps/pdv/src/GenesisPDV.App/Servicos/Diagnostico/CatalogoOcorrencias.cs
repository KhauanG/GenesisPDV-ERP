using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>O que a aba 5 diz de uma ocorrência: o nome curto e o "o que fazer", em português de balcão.</summary>
public sealed record DicaOcorrencia(string Titulo, string OQueFazer);

/// <summary>
/// As dicas das ocorrências do <c>log_local</c> (Central do PDV, bloco G8; plano 5.5; README › decisão 73): cada
/// <see cref="CodigoOcorrencia"/> tem a sua (o teste confere todos por reflexão; código novo sem dica quebra o teste). A
/// linha de antes do G8, sem código, recebe a dica da origem. O texto não leva dado nenhum da ocorrência (é fixo): o que
/// é da ocorrência (a mensagem, o detalhe) passa pelo <see cref="MascaradorSuporte"/> na tela.
/// </summary>
public static class CatalogoOcorrencias
{
    /// <summary>Onde o ERP decide o registro recusado (o mesmo texto da aba 4, decisão 72).</summary>
    private const string NoErp = "Cadastros › PDVs / Terminais › este caixa › Eventos com erro";

    private static readonly Dictionary<string, DicaOcorrencia> PorCodigo = new(StringComparer.Ordinal)
    {
        [CodigoOcorrencia.ImpressaoFalhou.Codigo] = new(
            "Documento não impresso",
            "Confira se a impressora está ligada, com papel e a tampa fechada, e o cabo. A venda não foi perdida: o documento " +
            "ficou na fila. Na aba 3 Impressora e gaveta, F7 imprime de novo o que ficou; o cupom também sai pelo Ctrl+R da aba 1 Vendas."),
        [CodigoOcorrencia.ImpressaoFalhouSemFila.Codigo] = new(
            "Não impresso (só valia na hora)",
            "Esse documento só servia na hora (o QR do PIX): não fica na fila e não sai pelo F7. Se o cliente ainda não pagou, " +
            "mostre a tela a ele. Depois confira se a impressora está ligada, com papel e a tampa fechada, e o cabo; na aba 3 " +
            "Impressora e gaveta, F5 Imprimir teste."),
        [CodigoOcorrencia.FilaImpressaoParou.Codigo] = new(
            "A fila de impressão parou",
            "A impressora continua com problema: resolva o papel, a tampa ou o cabo e aperte F7 de novo na aba 3 Impressora e gaveta. " +
            "Se nada sair, confira o modelo e a conexão na mesma aba (F5 Imprimir teste)."),
        [CodigoOcorrencia.ConfiguracaoAlterada.Codigo] = new(
            "Configuração do caixa alterada",
            "Só um registro. Se a impressora ou a gaveta pararam depois disso, confira na aba 3 Impressora e gaveta o que foi gravado " +
            "(quem gravou e o antes e o depois ficam no histórico de uso)."),
        [CodigoOcorrencia.GavetaFalhou.Codigo] = new(
            "Gaveta não abriu",
            "Abra a gaveta com a chave, se precisar. Confira o cabo da gaveta na impressora e se a impressora está ligada; na aba 3, " +
            "F6 Abrir gaveta (teste). Se a gaveta usa outro pino, ajuste na mesma aba."),
        [CodigoOcorrencia.GavetaVoltou.Codigo] = new("Gaveta voltou a abrir", "Nada a fazer: a gaveta abriu de novo depois da falha."),
        [CodigoOcorrencia.RegistroRecusado.Codigo] = new(
            "Registro recusado pela nuvem",
            $"Quem resolve é o ERP: {NoErp} (reprocessar ou descartar). O caixa continua vendendo; a aba 4 Sincronização mostra a venda em vermelho até o ERP decidir."),
        [CodigoOcorrencia.RegistroResolvidoErp.Codigo] = new(
            "Registro resolvido no ERP", "Nada a fazer: o ERP decidiu o registro que a nuvem tinha recusado."),
        [CodigoOcorrencia.ComandoFalhou.Codigo] = new(
            "Pedido do ERP não feito",
            "Se o motivo é \"não suportado nesta versão\", é normal: esse pedido chega numa próxima atualização. Senão, peça de novo " +
            "pelo ERP e, se repetir, chame o suporte com o código do terminal (aba 9 Sobre o terminal)."),
        [CodigoOcorrencia.MensagemErp.Codigo] = new("Mensagem do ERP", "Só um registro da mensagem que o ERP mandou para este caixa."),
        [CodigoOcorrencia.Recuperacao.Codigo] = new(
            "Numeração recuperada",
            "O caixa ajustou a numeração depois de uma restauração ou de uma perda de dados (para não repetir número de venda). " +
            "Nada a fazer; se houver lacuna, a aba 4 Sincronização mostra o F4."),
        [CodigoOcorrencia.BackupFalhou.Codigo] = new(
            "Backup não feito",
            "Confira o espaço em disco no Painel de saúde (aba 0). O caixa tenta de novo sozinho; se continuar falhando, chame o suporte."),
        [CodigoOcorrencia.BackupCopiaFalhou.Codigo] = new(
            "Cópia do backup não feita",
            "O backup principal foi feito. Confira se o pendrive ou a pasta de rede da cópia está ligado e com espaço; a próxima cópia sai no próximo backup."),
        [CodigoOcorrencia.BackupManual.Codigo] = new(
            "Backup feito agora",
            "Só um registro: alguém usou o \"Fazer backup agora\" (aba 8 Backup). O arquivo está na lista da aba 8; quem fez fica no histórico de uso."),
        [CodigoOcorrencia.PacoteGerado.Codigo] = new(
            "Pacote de suporte gerado",
            "Só um registro: alguém gerou o pacote para o suporte. Entregue o arquivo só ao suporte; o SHA-256 no detalhe confere " +
            "que ele não mudou no caminho. Pela aba P da Central, quem gerou fica no histórico de uso; pela tela de terminal " +
            "bloqueado (sem login, \"sem_banco\" no detalhe), não há quem: ninguém estava logado."),
        [CodigoOcorrencia.ParametroAlterado.Codigo] = new(
            "Parâmetros do caixa alterados",
            "Só um registro. Se a tela passou a bloquear sozinha ou a cópia do backup mudou de lugar, confira na aba 7 Parâmetros o que " +
            "está valendo (quem gravou e o antes e o depois ficam no histórico de uso)."),
        [CodigoOcorrencia.RestauradoOffline.Codigo] = new(
            "Caixa restaurado sem internet",
            "A numeração das vendas saltou para não repetir número depois da restauração do backup. Nada a fazer; quando a internet " +
            "voltar, o caixa confere com a nuvem."),
        [CodigoOcorrencia.PinForaDosLimites.Codigo] = new(
            "PIN não aceito neste caixa",
            "O PIN desse usuário veio do ERP num formato que o caixa não aceita. Peça para trocar o PIN desse usuário no ERP e sincronize."),
        [CodigoOcorrencia.ErroInesperado.Codigo] = new(
            "Erro inesperado na tela",
            "A venda foi preservada. Se o caixa está funcionando, não precisa fazer nada; se repetir, gere o pacote de suporte e chame o suporte."),
    };

    /// <summary>A dica da linha de antes do G8 (sem código), pela origem.</summary>
    private static readonly Dictionary<string, DicaOcorrencia> PorOrigem = new(StringComparer.Ordinal)
    {
        [OrigensOcorrencia.Impressora] = PorCodigo[CodigoOcorrencia.ImpressaoFalhou.Codigo],
        [OrigensOcorrencia.Gaveta] = new("Gaveta", "Na aba 3 Impressora e gaveta, F6 Abrir gaveta (teste)."),
        [OrigensOcorrencia.Sync] = new("Sincronização", "A aba 4 Sincronização mostra o que não subiu e por quê."),
        [OrigensOcorrencia.Backup] = new("Backup", "A aba 0 Painel de saúde mostra o último backup e o espaço em disco."),
        [OrigensOcorrencia.Login] = new("Login", "Se um usuário não consegue entrar, confira o cadastro e o PIN dele no ERP."),
        [OrigensOcorrencia.Sistema] = PorCodigo[CodigoOcorrencia.ErroInesperado.Codigo],
    };

    private static readonly DicaOcorrencia Generica =
        new("Ocorrência", "Se o caixa está funcionando, não precisa fazer nada; se repetir, chame o suporte com o código do terminal (aba 9).");

    /// <summary>Os códigos com dica (o teste confere que são todos os de <see cref="CodigoOcorrencia.Todos"/>).</summary>
    public static IReadOnlyCollection<string> Codigos => PorCodigo.Keys;

    /// <summary>A dica pelo código e, sem ele (ou desconhecido), pela origem.</summary>
    public static DicaOcorrencia Dica(string? codigo, string? origem) =>
        codigo is not null && PorCodigo.TryGetValue(codigo, out var porCodigo) ? porCodigo
        : PorOrigem.TryGetValue(OrigensOcorrencia.Normalizar(origem), out var porOrigem) ? porOrigem
        : Generica;

    /// <summary>Os códigos cujo título (a coluna "Resumo" da lista) tem o texto, sem acento nem maiúscula (a busca da aba 5).</summary>
    public static IReadOnlyList<string> CodigosComTitulo(string texto) =>
        [.. PorCodigo.Where(p => BuscaSemAcento.Contem(p.Value.Titulo, texto)).Select(p => p.Key)];

    /// <summary>As origens cuja dica das linhas sem código (de antes do G8) tem o texto no título (a busca da aba 5).</summary>
    public static IReadOnlyList<string> OrigensComTitulo(string texto) =>
        [.. PorOrigem.Where(p => BuscaSemAcento.Contem(p.Value.Titulo, texto)).Select(p => p.Key)];

    /// <summary>"Impressora", "Sincronização" (o filtro e a coluna da lista).</summary>
    public static string RotuloOrigem(string? origem) => OrigensOcorrencia.Normalizar(origem) switch
    {
        OrigensOcorrencia.Impressora => "Impressora",
        OrigensOcorrencia.Gaveta => "Gaveta",
        OrigensOcorrencia.Sync => "Sincronização",
        OrigensOcorrencia.Backup => "Backup",
        OrigensOcorrencia.Login => "Login",
        OrigensOcorrencia.Sistema => "Sistema",
        var outra => outra,
    };

    /// <summary>"ERRO", "AVISO", "INFO" (a palavra ao lado da cor, PDV 9.1).</summary>
    public static string RotuloNivel(string nivel) => nivel switch
    {
        NiveisOcorrencia.Critico => "CRÍTICO",
        NiveisOcorrencia.Erro => "ERRO",
        NiveisOcorrencia.Aviso => "AVISO",
        NiveisOcorrencia.Debug => "DEPURAÇÃO",
        _ => "INFO",
    };
}
