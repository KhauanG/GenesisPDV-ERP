using System.Buffers.Text;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Sync.Ativacao;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// API falsa do sync para os testes do PDV (também ligada ao GenesisPDV.App.Tests): responde com as fixtures de
/// <c>packages/shared/testes/sync</c> (as mesmas que o Vitest e a integração da API conferem), grava cada envio e imita o
/// que a ativação e a rotação têm de estado na nuvem: token emitido a cada ativação (a repetição troca o segredo),
/// <c>chave_backup_cifrada</c> cifrada de verdade para a <c>chave_backup_publica</c> enviada, hashes de token aceitos
/// (atual e anterior) e a renovação idempotente pelo <c>requisicao_id</c>.
/// </summary>
public sealed class ApiFalsa : HttpMessageHandler
{
    public sealed record Envio(string Metodo, string Rota, string? Corpo, string RequisicaoId, string? Token, string Consulta = "");

    /// <summary>Linha da "nuvem" servida pelo <c>/sync/pull</c>: fluxo, tabela, versão e a linha na projeção do fluxo.</summary>
    public sealed record LinhaNuvem(string Fluxo, string Tabela, long Versao, JsonObject Linha);

    /// <summary>Loja e caixa da fixture <c>ativar.resposta.json</c> (a identidade que a ativação grava).</summary>
    public static readonly Guid LojaId = Guid.Parse("01a18752-3782-7bda-ad3c-2d6d1a3d1fa7");

    public static readonly Guid CaixaId = Guid.Parse("01a18752-c8a9-7970-9641-9f828b9d2434");

    /// <summary>Envios recebidos, em ordem (o ciclo grava na thread dele: para ler durante o laço, <see cref="Contar"/>).</summary>
    public List<Envio> Envios { get; } = [];

    /// <summary>Quantos envios chegaram a uma rota (sufixo, ex.: <c>/sync/heartbeat</c>), seguro com o ciclo rodando.</summary>
    public int Contar(string rota)
    {
        lock (Envios)
        {
            return Envios.Count(e => e.Rota.EndsWith(rota, StringComparison.Ordinal));
        }
    }

    /// <summary>Último envio a uma rota (sufixo), seguro com o ciclo rodando.</summary>
    public Envio? UltimoEnvio(string rota)
    {
        lock (Envios)
        {
            return Envios.LastOrDefault(e => e.Rota.EndsWith(rota, StringComparison.Ordinal));
        }
    }

    /// <summary>Antes de cada heartbeat: devolvendo uma resposta, ela vai no lugar (falha simulada).</summary>
    public Func<Envio, HttpResponseMessage?>? AoHeartbeat { get; set; }

    /// <summary>Antes de cada <c>/sync/estado</c>: devolvendo uma resposta, ela vai no lugar (falha simulada).</summary>
    public Func<Envio, HttpResponseMessage?>? AoEstado { get; set; }

    /// <summary>
    /// 403 da empresa ou da loja (<c>EMPRESA_SUSPENSA</c>, <c>EMPRESA_CANCELADA</c>, <c>PDV_DESABILITADO</c>,
    /// <c>LOJA_INATIVA</c>), como o <c>verificarEmpresa</c> da API: toda rota autenticada recusa, menos o push e o
    /// recuperar (T41), que só a empresa cancelada recusa. Nulo = empresa ativa.
    /// </summary>
    public string? EmpresaBloqueada { get; set; }

    /// <summary>Respostas 400 do heartbeat (corpo fora do <c>heartbeatSchema</c>, como a validação da API).</summary>
    public int HeartbeatsRecusados { get; private set; }

    /// <summary>Máximos do <c>heartbeatSchema</c> do shared (<c>comandos_resultado</c>, <c>eventos_resolvidos_ack</c>).</summary>
    public const int MaximoComandosResultado = 100;

    public const int MaximoEventosResolvidosAck = 500;

    /// <summary>Sem rede: toda rota falha com <see cref="HttpRequestException"/> (o envio fica registrado).</summary>
    public bool ForaDoAr { get; set; }

    /// <summary>Rotas (sufixo) que aceitam a conexão e nunca respondem (proxy pendurado, 4G degradado): só o prazo encerra.</summary>
    public HashSet<string> RotasSemResposta { get; } = new(StringComparer.Ordinal);

    /// <summary><c>renovar_token</c> do heartbeat; a renovação aplicada desliga (como o <c>token_emitido_em</c> novo na API).</summary>
    public bool PedirRenovacao { get; set; }

    /// <summary>Eventos resolvidos no ERP, entregues em todo heartbeat até o <c>eventos_resolvidos_ack</c> (como a API).</summary>
    public List<JsonObject> EventosResolvidos { get; } = [];

    /// <summary>
    /// Situação na nuvem que o <c>GET /sync/eventos-status</c> devolve (item no formato da fixture
    /// <c>eventos-status.resposta.json</c>), por evento; id fora daqui fica fora da resposta, como na API.
    /// </summary>
    public Dictionary<Guid, JsonObject> SituacaoNaNuvem { get; } = [];

    /// <summary>Antes de cada <c>/sync/eventos-status</c>: devolvendo uma resposta, ela vai no lugar (falha simulada).</summary>
    public Func<Envio, HttpResponseMessage?>? AoEventosStatus { get; set; }

    /// <summary>Ids pedidos em cada <c>/sync/eventos-status</c>, na ordem do envio.</summary>
    public List<Guid[]> ConsultasEventosStatus { get; } = [];

    /// <summary>Antes de cada <c>/sync/recuperar</c>: devolvendo uma resposta, ela vai no lugar (falha simulada).</summary>
    public Func<Envio, HttpResponseMessage?>? AoRecuperar { get; set; }

    /// <summary><c>desde_sequencia</c> de cada <c>/sync/recuperar</c>, na ordem.</summary>
    public List<long> ConsultasRecuperar { get; } = [];

    /// <summary>
    /// Situação na nuvem por evento recebido no push (<c>aplicado</c>, ou <c>erro</c> para o que o push devolveu
    /// <c>rejeitado</c>/<c>retido</c>), como o <c>GET /sync/recuperar</c> devolve; ausente = <c>aplicado</c>.
    /// </summary>
    public Dictionary<Guid, string> StatusRecebido { get; } = [];

    /// <summary>Chave de backup "em custódia" que a ativação devolve cifrada.</summary>
    public byte[] ChaveBackup { get; } = RandomNumberGenerator.GetBytes(32);

    public Guid TerminalId { get; } = Guid.Parse("01a18751-a521-7238-b924-56de3eb13b90");

    /// <summary>Tokens entregues pelas ativações, na ordem.</summary>
    public List<string> TokensEmitidos { get; } = [];

    /// <summary><c>sha256_hex(segredo)</c> aceitos pela "nuvem" (atual e anterior da rotação).</summary>
    public HashSet<string> HashesValidos { get; } = [];

    /// <summary>Próximas respostas de <c>/sync/ativar</c>, em ordem; vazia = 201 com a fixture.</summary>
    public Queue<Func<Envio, HttpResponseMessage>> Ativacoes { get; } = new();

    /// <summary>Próximas respostas de <c>/saude</c>; vazia = 200.</summary>
    public Queue<Func<HttpResponseMessage>> Saudes { get; } = new();

    /// <summary>Antes de responder a renovação (para conferir o que o PDV já gravou).</summary>
    public Action<Envio>? AoRenovar { get; set; }

    /// <summary>Antes de responder <c>401 TOKEN_INVALIDO</c> (para simular o que acontece em paralelo nesse instante).</summary>
    public Action<Envio>? AoRecusarToken { get; set; }

    /// <summary>Renovação aplicada mas resposta perdida (rede cai depois do commit).</summary>
    public bool PerderRespostaDaRenovacao { get; set; }

    /// <summary>Renovação que não chega à API.</summary>
    public bool RenovacaoNaoChega { get; set; }

    /// <summary>
    /// O que o <c>/sync/pull</c> devolve, como a API: por fluxo, <c>versao &gt; desde</c> e <c>≤ teto</c> em ordem, cortado
    /// em <c>limite</c>; o teto é a maior versão publicada (de qualquer fluxo, como o teto sem filtro de loja da API) e a
    /// página não cortada termina com <c>novo_cursor = cursor_teto</c>. Vazia = toda carga termina vazia.
    /// </summary>
    public List<LinhaNuvem> Nuvem { get; } = [];

    /// <summary>Antes de cada pull: devolvendo uma resposta, ela vai no lugar da página (falha simulada).</summary>
    public Func<Envio, HttpResponseMessage?>? AoPuxar { get; set; }

    private long _versao = 1_000;

    /// <summary>
    /// Tipos anunciados em <c>versoes_schema</c> do <c>/sync/estado</c> (T13). Padrão: o que a API aplica desde a 1C (os
    /// da 1B da fixture e os <c>CONTRATOS_EVENTOS</c> com handler); o teste da API sem o tipo troca por menos.
    /// </summary>
    public Dictionary<string, int[]> VersoesSchema { get; set; } = new(StringComparer.Ordinal)
    {
        ["auditoria.registros"] = [1],
        ["terminal.configuracao_alterada"] = [1],
        ["caixa.aberto"] = [1],
        ["caixa.reforco"] = [1],
        ["caixa.sangria"] = [1],
        ["caixa.movimento_cancelado"] = [1],
        ["caixa.fechado"] = [1],
        ["venda.finalizada"] = [1],
        ["venda.cancelada"] = [1],
        ["vasilhame.movimentado"] = [1],
        ["alerta.cadastro"] = [1],
    };

    /// <summary><c>status_terminal</c> do heartbeat e do <c>/sync/estado</c> (<c>ativo</c>, <c>desativando</c>…).</summary>
    public string StatusTerminal { get; set; } = "ativo";

    /// <summary>Revogado na "nuvem": toda rota autenticada responde 401 <c>TERMINAL_REVOGADO</c>.</summary>
    public bool Revogado { get; set; }

    /// <summary><c>id_hardware_confere</c> do <c>/sync/estado</c>; falso também faz o push responder 409.</summary>
    public bool HardwareConfere { get; set; } = true;

    /// <summary>Comandos entregues em todo heartbeat até o ack final (<c>executado</c>/<c>falhou</c>), como a nuvem.</summary>
    public List<Protocolo.ComandoTerminal> Comandos { get; } = [];

    /// <summary>Acks recebidos por comando (o último status).</summary>
    public Dictionary<Guid, string> AcksComandos { get; } = [];

    /// <summary>Eventos aceitos pelo push, por <c>evento_id</c> (a "nuvem" guarda; repetição = <c>duplicado</c>).</summary>
    public Dictionary<Guid, JsonObject> EventosRecebidos { get; } = [];

    /// <summary>Status por tipo de evento no push (padrão: <c>aplicado</c>); ex.: <c>venda.finalizada → erro_temporario</c>.</summary>
    public Dictionary<string, string> StatusPorTipo { get; } = new(StringComparer.Ordinal);

    /// <summary>Antes de cada push: devolvendo uma resposta, ela vai no lugar (falha simulada).</summary>
    public Func<Envio, HttpResponseMessage?>? AoEnviar { get; set; }

    /// <summary>Último heartbeat recebido (corpo JSON).</summary>
    public JsonObject? UltimoHeartbeat { get; private set; }

    /// <summary>Heartbeat com <c>desativando_confirmado</c> aceito (o terminal passou a revogado).</summary>
    public bool DesativacaoConfirmada { get; private set; }

    /// <summary>Intervalos (s) devolvidos no heartbeat no lugar dos da fixture (30 s): os testes do ciclo usam 1 s.</summary>
    public int? IntervaloS { get; set; }

    /// <summary><c>X-Agora-Servidor</c> de toda resposta autenticada (nulo = sem o cabeçalho, como antes).</summary>
    public Func<DateTimeOffset>? AgoraServidor { get; set; }

    /// <summary>Maior sequência recebida pelo push (o <c>ultima_recebida</c> do <c>/sync/estado</c>), placeholders incluídos.</summary>
    public long UltimaSequenciaRecebida => EventosRecebidos.Values.Select(e => e["sequencia"]!.GetValue<long>())
        .Concat(Placeholders.Keys).DefaultIfEmpty(0).Max();

    /// <summary>Placeholders <c>terminal.lacuna</c> (8.6): sequência → faixa da declaração que o criou.</summary>
    public Dictionary<long, (long De, long Ate)> Placeholders { get; } = [];

    /// <summary>Corpos de <c>declarar_lacuna</c> aceitos, em ordem.</summary>
    public List<JsonObject> Declaracoes { get; } = [];

    /// <summary>Corpos de <c>recuperar_lacuna</c> recebidos, em ordem.</summary>
    public List<JsonObject> Recuperacoes { get; } = [];

    /// <summary>
    /// "Nuvem restaurada de backup" (22.5): esquece os eventos recebidos e os placeholders a partir da sequência (o
    /// backup é de antes deles), e a <see cref="UltimaSequenciaRecebida"/> volta junto.
    /// </summary>
    public void EsquecerDesde(long sequencia)
    {
        foreach (var id in EventosRecebidos.Where(e => e.Value["sequencia"]!.GetValue<long>() >= sequencia).Select(e => e.Key).ToList())
        {
            EventosRecebidos.Remove(id);
        }

        foreach (var s in Placeholders.Keys.Where(s => s >= sequencia).ToList())
        {
            Placeholders.Remove(s);
        }
    }

    /// <summary>Lacuna já declarada (8.6), como se outro caixa/backup a tivesse declarado antes.</summary>
    public void DeclararPlaceholders(long de, long ate)
    {
        for (var s = de; s <= ate; s++)
        {
            Placeholders[s] = (de, ate);
        }
    }

    /// <summary>Publica uma linha na "nuvem" com a próxima versão (que também vai na coluna <c>versao</c>).</summary>
    public long Publicar(string fluxo, string tabela, JsonObject linha)
    {
        ArgumentNullException.ThrowIfNull(linha);
        var versao = ++_versao;
        linha["versao"] = versao;
        Nuvem.Add(new LinhaNuvem(fluxo, tabela, versao, linha));
        return versao;
    }

    /// <summary>Loja e caixa da fixture (fluxo <c>configuracao</c>), com o nome que o cabeçalho do login mostra.</summary>
    public void PublicarLojaECaixa(string nomeLoja = "Loja 1 - Ice Beer Hermes")
    {
        Publicar("configuracao", "lojas", new JsonObject
        {
            ["id"] = LojaId.ToString("D"),
            ["codigo"] = 1,
            ["nome"] = nomeLoja,
            ["razao_social"] = "ICE BEER COMÉRCIO DE BEBIDAS LTDA",
            ["nome_fantasia"] = "Ice Beer",
            ["cnpj"] = "00000000000100",
            // A nuvem sempre manda a coluna (padrão true); desligada, o PDV não abre sessão nova (PDV 8.1).
            ["usa_pdv"] = true,
            ["excluido_em"] = null,
        });
        Publicar("configuracao", "caixas", new JsonObject
        {
            ["id"] = CaixaId.ToString("D"),
            ["loja_id"] = LojaId.ToString("D"),
            ["numero"] = 2,
            ["ativo"] = true,
            ["excluido_em"] = null,
        });
    }

    /// <summary>
    /// Usuário do fluxo <c>acesso</c> com o PIN (hash argon2id), e, se pedido, o vínculo com a loja da fixture e um perfil
    /// com as permissões do perfil padrão "Operador de caixa" (<see cref="Core.Caixa.PermissoesPdv.PerfilOperador"/>, que
    /// inclui <c>pdv.acesso.entrar</c>) ou as <paramref name="permissoes"/> pedidas.
    /// </summary>
    public Guid PublicarUsuario(
        string login,
        int codigo,
        string? hashPin,
        bool master = false,
        bool ativo = true,
        bool totem = false,
        bool comLoja = true,
        bool comPermissao = true,
        IEnumerable<string>? permissoes = null,
        decimal limiteDescontoPct = 10m)
    {
        var id = Guid.CreateVersion7();
        Guid? perfil = null;
        if (comPermissao && !master)
        {
            perfil = Guid.CreateVersion7();
            Publicar("acesso", "perfis", new JsonObject { ["id"] = perfil.Value.ToString("D"), ["nome"] = $"Perfil {login}", ["excluido_em"] = null });
            foreach (var permissao in permissoes ?? Core.Caixa.PermissoesPdv.PerfilOperador)
            {
                Publicar("acesso", "perfis_permissoes", new JsonObject
                {
                    ["id"] = Guid.CreateVersion7().ToString("D"),
                    ["perfil_id"] = perfil.Value.ToString("D"),
                    ["permissao"] = permissao,
                    ["excluido_em"] = null,
                });
            }
        }

        Publicar("acesso", "usuarios", new JsonObject
        {
            ["id"] = id.ToString("D"),
            ["codigo"] = codigo,
            ["nome"] = login.ToUpperInvariant(),
            ["login"] = login,
            ["senha_pdv_hash"] = hashPin,
            ["ativo"] = ativo,
            ["master"] = master,
            ["totem"] = totem,
            ["perfil_id"] = perfil?.ToString("D"),
            ["limite_desconto_pct"] = limiteDescontoPct.ToString("F4", System.Globalization.CultureInfo.InvariantCulture),
            ["pdv_utilitario"] = false,
            ["permissoes_versao"] = 0,
            ["excluido_em"] = null,
        });
        if (comLoja)
        {
            Publicar("acesso", "usuarios_lojas", new JsonObject
            {
                ["id"] = Guid.CreateVersion7().ToString("D"),
                ["usuario_id"] = id.ToString("D"),
                ["loja_id"] = LojaId.ToString("D"),
                ["excluido_em"] = null,
            });
        }

        return id;
    }

    private Guid? _renovacaoAplicada;
    private string? _hashRenovado;

    public static string Fixture(string arquivo) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "sync", arquivo));

    public static string HashDoSegredo(string token) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token[(token.IndexOf('.', StringComparison.Ordinal) + 1)..])));

    /// <summary>Envelope de erro da SYNC 2.4.</summary>
    public static HttpResponseMessage Erro(HttpStatusCode status, string codigo, string mensagem = "Recusado.", JsonObject? detalhes = null)
    {
        var corpo = new JsonObject
        {
            ["erro"] = new JsonObject
            {
                ["codigo"] = codigo,
                ["mensagem"] = mensagem,
                ["detalhes"] = detalhes ?? new JsonObject(),
                ["requisicao_id"] = null,
            },
        };
        return Json(status, corpo.ToJsonString());
    }

    /// <summary>Caso de <c>erros.json</c> pela descrição (status, corpo e cabeçalhos da fixture).</summary>
    public static HttpResponseMessage ErroDaFixture(string descricao)
    {
        var caso = JsonNode.Parse(Fixture("erros.json"))!["casos"]!.AsArray().Single(c => c!["descricao"]!.GetValue<string>() == descricao)!;
        var resposta = Json((HttpStatusCode)caso["status"]!.GetValue<int>(), caso["corpo"]!.ToJsonString());
        foreach (var (nome, valor) in caso["cabecalhos"]?.AsObject() ?? [])
        {
            resposta.Headers.Add(nome, valor!.GetValue<string>());
        }

        return resposta;
    }

    /// <summary>201 com a fixture <c>ativar.resposta.json</c>, token novo e a chave de backup cifrada para a pública enviada.</summary>
    public HttpResponseMessage AtivacaoAceita(Envio envio, Action<JsonObject>? ajustar = null)
    {
        var resposta = JsonNode.Parse(Fixture("ativar.resposta.json"))!.AsObject();
        var pedido = JsonNode.Parse(envio.Corpo!)!;
        var token = $"{TerminalId:D}.{Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32))}";
        TokensEmitidos.Add(token);
        HashesValidos.Clear();
        HashesValidos.Add(HashDoSegredo(token));
        resposta["terminal_id"] = TerminalId.ToString("D");
        resposta["token"] = token;
        var spki = Convert.FromBase64String(pedido["chave_backup_publica"]!.GetValue<string>());
        resposta["chave_backup_cifrada"] = Convert.ToBase64String(EciesApi.Cifrar(spki, ChaveBackup));
        ajustar?.Invoke(resposta);
        return Json(HttpStatusCode.Created, resposta.ToJsonString());
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        var corpo = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        var envio = new Envio(
            request.Method.Method,
            uri.AbsolutePath,
            corpo,
            request.Headers.GetValues("X-Requisicao-Id").Single(),
            request.Headers.Authorization?.Parameter,
            uri.Query);
        lock (Envios)
        {
            Envios.Add(envio);
        }

        var rota = uri.AbsolutePath;
        if (ForaDoAr)
        {
            throw new HttpRequestException("API falsa fora do ar.");
        }

        if (RotasSemResposta.Any(r => rota.EndsWith(r, StringComparison.Ordinal)))
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }

        if (rota.EndsWith("/saude", StringComparison.Ordinal))
        {
            return Saudes.TryDequeue(out var saude) ? saude() : Json(HttpStatusCode.OK, "{\"status\":\"ok\"}");
        }

        if (rota.EndsWith("/sync/ativar", StringComparison.Ordinal))
        {
            return Ativacoes.TryDequeue(out var proxima) ? proxima(envio) : AtivacaoAceita(envio);
        }

        if (envio.Token is null || !HashesValidos.Contains(HashDoSegredo(envio.Token)))
        {
            AoRecusarToken?.Invoke(envio);
            return Erro(HttpStatusCode.Unauthorized, "TOKEN_INVALIDO", "Terminal não autenticado. Reative o terminal.");
        }

        if (Revogado)
        {
            return Erro(HttpStatusCode.Unauthorized, "TERMINAL_REVOGADO", "Este terminal foi desativado no ERP.");
        }

        if (EmpresaBloqueada is { } bloqueio
            && (bloqueio == "EMPRESA_CANCELADA" || !(rota.EndsWith("/sync/push", StringComparison.Ordinal) || rota.Contains("/sync/recuperar", StringComparison.Ordinal))))
        {
            return Erro(HttpStatusCode.Forbidden, bloqueio, "Acesso suspenso. Entre em contato com o suporte Genesis.");
        }

        var resposta = Autenticada(envio, rota);
        if (AgoraServidor is { } agora)
        {
            resposta.Headers.Add("X-Agora-Servidor", agora().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture));
        }

        return resposta;
    }

    private HttpResponseMessage Autenticada(Envio envio, string rota)
    {
        if (rota.EndsWith("/sync/token/renovar", StringComparison.Ordinal))
        {
            return Renovar(envio);
        }

        if (rota.EndsWith("/sync/estado", StringComparison.Ordinal))
        {
            return AoEstado?.Invoke(envio) ?? Estado();
        }

        if (rota.EndsWith("/sync/pull", StringComparison.Ordinal))
        {
            return AoPuxar?.Invoke(envio) ?? Puxar(envio);
        }

        if (rota.EndsWith("/sync/push", StringComparison.Ordinal))
        {
            return AoEnviar?.Invoke(envio) ?? Empurrar(envio);
        }

        if (rota.EndsWith("/sync/heartbeat", StringComparison.Ordinal))
        {
            return AoHeartbeat?.Invoke(envio) ?? Heartbeat(envio);
        }

        if (rota.EndsWith("/sync/eventos-status", StringComparison.Ordinal))
        {
            return AoEventosStatus?.Invoke(envio) ?? EventosStatus(envio);
        }

        if (rota.EndsWith("/sync/recuperar", StringComparison.Ordinal))
        {
            return AoRecuperar?.Invoke(envio) ?? Recuperar(envio);
        }

        return Erro(HttpStatusCode.NotFound, "NAO_ENCONTRADO", "Rota fora da API falsa.");
    }

    /// <summary>A fixture <c>estado.resposta.json</c> com o estado desta "nuvem" (status, hardware, sequência recebida).</summary>
    private HttpResponseMessage Estado()
    {
        var estado = JsonNode.Parse(Fixture("estado.resposta.json"))!.AsObject();
        estado["terminal"]!["id"] = TerminalId.ToString("D");
        estado["terminal"]!["status"] = StatusTerminal;
        estado["terminal"]!["id_hardware_confere"] = HardwareConfere;
        estado["sequencia_terminal"]!["ultima_recebida"] = UltimaSequenciaRecebida;
        estado["sequencia_terminal"]!["ultimo_evento_id"] = null;
        estado["sequencia_terminal"]!["ultima_recebida_em"] = null;
        estado["informado_pelo_terminal"]!["ultima_sequencia_gerada"] =
            UltimoHeartbeat?["ultima_sequencia_gerada"]?.GetValue<long>() ?? UltimaSequenciaRecebida;
        estado["informado_pelo_terminal"]!["eventos_pendentes"] = 0;
        estado["sessao_caixa_aberta"] = null;
        estado["versoes_schema"] = JsonSerializer.SerializeToNode(VersoesSchema);
        return Json(HttpStatusCode.OK, estado.ToJsonString());
    }

    /// <summary>
    /// Push como a API (7.4, push.ts): ordem estrita com sequência esperada = maior recebida + 1; repetição do mesmo
    /// <c>evento_id</c> = <c>duplicado</c>; sequência maior que a esperada = <c>fora_de_ordem</c>, que para o lote; menor,
    /// com evento novo = <c>409 REGRESSAO_DETECTADA</c> com os resultados já processados em <c>detalhes.resultados</c>;
    /// status por tipo (<see cref="StatusPorTipo"/>) e parada do lote no <c>erro_temporario</c>. Depois de uma parada,
    /// os seguintes voltam <c>nao_processado</c>. Lacunas (8.6, C15): <c>declarar_lacuna</c> grava os
    /// <see cref="Placeholders"/> (só a partir da esperada, a repetição é aceita); o evento numa sequência de placeholder
    /// é aplicado com <c>recuperar_lacuna</c> no lote e, sem ela, é <c>lacuna_recuperavel</c> (para o lote).
    /// </summary>
    private HttpResponseMessage Empurrar(Envio envio)
    {
        if (!HardwareConfere)
        {
            return Erro(HttpStatusCode.Conflict, "HARDWARE_ALTERADO", "Hardware alterado — aguardando aprovação no ERP.");
        }

        var lote = JsonNode.Parse(envio.Corpo!)!.AsObject();
        var resultados = new JsonArray();
        var parou = false;
        if (lote["declarar_lacuna"] is JsonObject declaracao)
        {
            // 8.6 (lacunas.ts): só a faixa que começa na esperada; a mesma declaração repetida não faz nada.
            var (de, ate) = (declaracao["de"]!.GetValue<long>(), declaracao["ate"]!.GetValue<long>());
            var esperado = UltimaSequenciaRecebida + 1;
            var repetida = Enumerable.Range(0, (int)(ate - de + 1)).All(i => Placeholders.TryGetValue(de + i, out var f) && f == (de, ate));
            if (!repetida && de != esperado)
            {
                return Erro(HttpStatusCode.Conflict, "LACUNA_INVALIDA", $"A lacuna tem de começar na sequência que a nuvem espera ({esperado}).",
                    new JsonObject { ["proxima_sequencia_esperada"] = esperado });
            }

            if (!repetida)
            {
                DeclararPlaceholders(de, ate);
                Declaracoes.Add(declaracao.DeepClone().AsObject());
            }
        }

        var recuperacao = lote["recuperar_lacuna"] as JsonObject;
        if (recuperacao is not null)
        {
            Recuperacoes.Add(recuperacao.DeepClone().AsObject());
        }

        foreach (var ev in lote["eventos"]!.AsArray())
        {
            var id = Guid.Parse(ev!["evento_id"]!.GetValue<string>());
            var sequencia = ev["sequencia"]!.GetValue<long>();
            var resultado = new JsonObject { ["evento_id"] = id.ToString("D"), ["sequencia"] = sequencia };
            if (parou)
            {
                resultado["status"] = "nao_processado";
            }
            else if (EventosRecebidos.ContainsKey(id))
            {
                resultado["status"] = "duplicado";
                resultado["versao_nuvem"] = 2_000 + sequencia;
                resultado["versao_nuvem_fim"] = 2_000 + sequencia;
                resultado["resultado"] = new JsonObject();
            }
            else if (Placeholders.TryGetValue(sequencia, out var faixa))
            {
                if (recuperacao is not null && sequencia >= recuperacao["de"]!.GetValue<long>() && sequencia <= recuperacao["ate"]!.GetValue<long>())
                {
                    // Substitui o placeholder pelo evento real e aplica.
                    Placeholders.Remove(sequencia);
                    EventosRecebidos[id] = ev.AsObject().DeepClone().AsObject();
                    resultado["status"] = "aplicado";
                    resultado["versao_nuvem"] = 2_000 + sequencia;
                    resultado["versao_nuvem_fim"] = 2_000 + sequencia;
                    resultado["resultado"] = new JsonObject();
                }
                else
                {
                    resultado["status"] = "lacuna_recuperavel";
                    resultado["resultado"] = new JsonObject { ["lacuna"] = new JsonObject { ["de"] = faixa.De, ["ate"] = faixa.Ate } };
                    resultado["erro"] = new JsonObject { ["codigo"] = "LACUNA_RECUPERAVEL", ["mensagem"] = "Sequência numa lacuna declarada." };
                    parou = true;
                }
            }
            else if (sequencia < UltimaSequenciaRecebida + 1)
            {
                return Erro(HttpStatusCode.Conflict, "REGRESSAO_DETECTADA", "Sequência já usada por outro evento: banco local restaurado ou copiado.",
                    new JsonObject
                    {
                        ["sequencia"] = sequencia,
                        ["proxima_sequencia_esperada"] = UltimaSequenciaRecebida + 1,
                        ["resultados"] = resultados,
                    });
            }
            else if (sequencia > UltimaSequenciaRecebida + 1)
            {
                resultado["status"] = "fora_de_ordem";
                parou = true;
            }
            else
            {
                var status = StatusPorTipo.GetValueOrDefault(ev["tipo"]!.GetValue<string>(), "aplicado");
                resultado["status"] = status;
                if (status == "erro_temporario")
                {
                    resultado["erro"] = new JsonObject { ["codigo"] = "SCHEMA_DESCONHECIDO", ["mensagem"] = "Tipo ainda sem handler." };
                    parou = true;
                }
                else
                {
                    EventosRecebidos[id] = ev.AsObject().DeepClone().AsObject();
                    StatusRecebido[id] = status == "aplicado" ? "aplicado" : "erro";
                    if (status == "aplicado")
                    {
                        resultado["versao_nuvem"] = 2_000 + sequencia;
                        resultado["versao_nuvem_fim"] = 2_000 + sequencia;
                        resultado["resultado"] = new JsonObject();
                    }
                    else
                    {
                        resultado["erro"] = new JsonObject { ["codigo"] = "PAYLOAD_INVALIDO", ["mensagem"] = "Recusado pela API falsa." };
                    }
                }
            }

            resultados.Add(resultado);
        }

        var corpo = new JsonObject
        {
            ["lote_id"] = lote["lote_id"]!.GetValue<string>(),
            ["recebido_em"] = DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["agora_servidor"] = DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["proxima_sequencia_esperada"] = UltimaSequenciaRecebida + 1,
            ["resultados"] = resultados,
            ["comandos"] = new JsonArray(),
        };
        return Json(HttpStatusCode.OK, corpo.ToJsonString());
    }

    /// <summary>
    /// Heartbeat como a API (21.1): recusa com 400 o corpo acima dos máximos do <c>heartbeatSchema</c> (sem gravar
    /// nada), grava o corpo, recebe os acks (final tira o comando da fila), confirma a desativação com 0 pendências e
    /// toda sequência gerada recebida, e devolve todos os comandos ainda sem ack final (sem limite: o pior caso do PDV).
    /// </summary>
    private HttpResponseMessage Heartbeat(Envio envio)
    {
        var hb = JsonNode.Parse(envio.Corpo!)!.AsObject();
        if ((hb["comandos_resultado"]?.AsArray().Count ?? 0) > MaximoComandosResultado
            || (hb["eventos_resolvidos_ack"]?.AsArray().Count ?? 0) > MaximoEventosResolvidosAck)
        {
            HeartbeatsRecusados++;
            return Erro(HttpStatusCode.BadRequest, "REQUISICAO_INVALIDA", "Requisição inválida.");
        }

        UltimoHeartbeat = hb;
        foreach (var ack in hb["comandos_resultado"]?.AsArray() ?? [])
        {
            var id = Guid.Parse(ack!["comando_id"]!.GetValue<string>());
            var status = ack["status"]!.GetValue<string>();
            AcksComandos[id] = status;
            if (status != "recebido")
            {
                Comandos.RemoveAll(c => c.Id == id);
            }
        }

        var acksResolvidos = (hb["eventos_resolvidos_ack"]?.AsArray() ?? []).Select(a => a!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
        EventosResolvidos.RemoveAll(r => acksResolvidos.Contains(r["evento_id"]!.GetValue<string>()));

        var statusTerminal = StatusTerminal;
        if (StatusTerminal == "desativando" && hb["estado_local"]?.GetValue<string>() == "desativando_confirmado"
            && hb["eventos_pendentes"]?.GetValue<int>() == 0
            && (hb["ultima_sequencia_gerada"]?.GetValue<long>() ?? 0) <= UltimaSequenciaRecebida)
        {
            DesativacaoConfirmada = true;
            StatusTerminal = "revogado";
            statusTerminal = "revogado";
        }
        else if (!HardwareConfere)
        {
            statusTerminal = "hardware_alterado";
        }

        var corpo = JsonNode.Parse(Fixture("heartbeat.resposta.json"))!.AsObject();
        corpo["status_terminal"] = statusTerminal;
        corpo["comandos"] = new JsonArray([.. Comandos.Select(c => new JsonObject
        {
            ["id"] = c.Id.ToString("D"),
            ["tipo"] = c.Tipo,
            ["parametros"] = JsonNode.Parse(c.Parametros.GetRawText()),
        })]);
        corpo["eventos_resolvidos"] = new JsonArray([.. EventosResolvidos.Select(r => r.DeepClone())]);
        corpo["renovar_token"] = PedirRenovacao;
        if (IntervaloS is { } intervalo)
        {
            foreach (var chave in new[] { "heartbeat_s", "pull_s", "push_pendente_s" })
            {
                corpo["intervalos"]![chave] = intervalo;
            }
        }

        corpo["app"]!["versao_minima"] = null;
        if (StatusTerminal == "revogado" && DesativacaoConfirmada)
        {
            // A partir daqui, como na API: o terminal confirmado é revogado.
            Revogado = true;
        }

        return Json(HttpStatusCode.OK, corpo.ToJsonString());
    }

    /// <summary>Como a API (7.2): de 1 a 200 ids (400 fora disso), só os que a nuvem tem; nada é confirmado.</summary>
    private HttpResponseMessage EventosStatus(Envio envio)
    {
        var ids = (System.Web.HttpUtility.ParseQueryString(envio.Consulta)["ids"] ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries).Select(Guid.Parse).ToArray();
        lock (ConsultasEventosStatus)
        {
            ConsultasEventosStatus.Add(ids);
        }

        if (ids.Length is 0 or > Cliente.ClienteSyncHttp.MaximoIdsEventosStatus)
        {
            return Erro(HttpStatusCode.BadRequest, "REQUISICAO_INVALIDA", "Requisição inválida.");
        }

        var corpo = new JsonObject
        {
            ["agora_servidor"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
            ["eventos"] = new JsonArray([.. ids.Distinct().Where(SituacaoNaNuvem.ContainsKey).Select(i => SituacaoNaNuvem[i].DeepClone())]),
        };
        return Json(HttpStatusCode.OK, corpo.ToJsonString());
    }

    /// <summary>
    /// <c>GET /sync/recuperar</c> como a API (22.2): os eventos recebidos e os placeholders com sequência acima de
    /// <c>desde_sequencia</c>, em ordem, até <c>limite</c>; o evento guardado sem envelope completo (os testes que só
    /// marcam a sequência) volta com o payload nulo, como o anulado.
    /// </summary>
    private HttpResponseMessage Recuperar(Envio envio)
    {
        var q = System.Web.HttpUtility.ParseQueryString(envio.Consulta);
        var desde = long.Parse(q["desde_sequencia"]!, System.Globalization.CultureInfo.InvariantCulture);
        var limite = int.Parse(q["limite"] ?? "50", System.Globalization.CultureInfo.InvariantCulture);
        lock (ConsultasRecuperar)
        {
            ConsultasRecuperar.Add(desde);
        }

        var itens = EventosRecebidos.Select(e => (Sequencia: e.Value["sequencia"]!.GetValue<long>(), Item: ItemRecuperado(e.Key, e.Value)))
            .Concat(Placeholders.Select(p => (Sequencia: p.Key, Item: Placeholder(p.Key, p.Value))))
            .Where(i => i.Sequencia > desde).OrderBy(i => i.Sequencia).ToList();
        var corpo = new JsonObject
        {
            ["agora_servidor"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
            ["desde_sequencia"] = desde,
            ["ultima_recebida"] = UltimaSequenciaRecebida,
            ["tem_mais"] = itens.Count > limite,
            ["eventos"] = new JsonArray([.. itens.Take(limite).Select(i => i.Item)]),
        };
        return Json(HttpStatusCode.OK, corpo.ToJsonString());
    }

    private JsonObject ItemRecuperado(Guid id, JsonObject guardado)
    {
        var envelope = guardado.ContainsKey("payload")
            ? guardado.DeepClone().AsObject()
            : EnvelopeSintetico(id, guardado["sequencia"]!.GetValue<long>(), guardado["tipo"]?.GetValue<string>() ?? "auditoria.registros", null);
        envelope["terminal_id"] = TerminalId.ToString("D");
        var status = StatusRecebido.GetValueOrDefault(id, "aplicado");
        var sequencia = envelope["sequencia"]!.GetValue<long>();
        var item = new JsonObject
        {
            ["envelope"] = envelope,
            ["status"] = status,
            ["versao_nuvem"] = status == "aplicado" ? 2_000 + sequencia : null,
            ["versao_nuvem_fim"] = status == "aplicado" ? 2_000 + sequencia : null,
            ["resultado"] = status == "aplicado" ? new JsonObject() : null,
            ["lacuna"] = false,
        };
        if (status != "aplicado")
        {
            item["erro"] = new JsonObject { ["codigo"] = "PAYLOAD_INVALIDO", ["mensagem"] = "Recusado pela API falsa." };
        }

        return item;
    }

    private JsonObject Placeholder(long sequencia, (long De, long Ate) faixa)
    {
        var lacuna = new JsonObject { ["de"] = faixa.De, ["ate"] = faixa.Ate };
        return new JsonObject
        {
            ["envelope"] = EnvelopeSintetico(Guid.CreateVersion7(), sequencia, "terminal.lacuna", new JsonObject { ["lacuna"] = lacuna.DeepClone() }),
            ["status"] = "descartado",
            ["versao_nuvem"] = null,
            ["versao_nuvem_fim"] = null,
            ["resultado"] = new JsonObject { ["descartado"] = true, ["lacuna"] = lacuna },
            ["lacuna"] = true,
        };
    }

    private JsonObject EnvelopeSintetico(Guid id, long sequencia, string tipo, JsonObject? payload) => new()
    {
        ["evento_id"] = id.ToString("D"),
        ["terminal_id"] = TerminalId.ToString("D"),
        ["sequencia"] = sequencia,
        ["tipo"] = tipo,
        ["versao_schema"] = 1,
        ["agregado_tipo"] = "terminal",
        ["agregado_id"] = TerminalId.ToString("D"),
        ["dependencias"] = new JsonArray(),
        ["ocorrido_em"] = "2026-11-04T12:00:00.000Z",
        ["usuario_id"] = null,
        ["contexto"] = new JsonObject { ["loja_id"] = LojaId.ToString("D"), ["caixa_id"] = CaixaId.ToString("D"), ["numero_caixa"] = 2 },
        ["payload"] = payload,
        ["payload_sha256"] = new string('0', 64),
    };

    /// <summary>Enfileira um comando da "nuvem" (como o ERP faz).</summary>
    public Guid Comandar(string tipo, JsonObject? parametros = null)
    {
        var id = Guid.CreateVersion7();
        using var doc = System.Text.Json.JsonDocument.Parse((parametros ?? []).ToJsonString());
        Comandos.Add(new Protocolo.ComandoTerminal(id, tipo, doc.RootElement.Clone()));
        return id;
    }

    private HttpResponseMessage Puxar(Envio envio)
    {
        var q = System.Web.HttpUtility.ParseQueryString(envio.Consulta);
        var fluxo = q["fluxo"]!;
        var desde = long.Parse(q["desde"]!, System.Globalization.CultureInfo.InvariantCulture);
        var limite = int.Parse(q["limite"]!, System.Globalization.CultureInfo.InvariantCulture);
        var tetoAtual = Nuvem.Count == 0 ? 1_000 : Nuvem.Max(l => l.Versao);
        var teto = q["teto"] is { } t ? Math.Min(tetoAtual, long.Parse(t, System.Globalization.CultureInfo.InvariantCulture)) : tetoAtual;
        var linhas = Nuvem.Where(l => l.Fluxo == fluxo && l.Versao > desde && l.Versao <= teto).OrderBy(l => l.Versao).Take(limite + 1).ToList();
        var cortada = linhas.Count > limite;
        var pagina = linhas.Take(limite).ToList();
        var corpo = new JsonObject
        {
            ["fluxo"] = fluxo,
            ["desde"] = desde,
            // Como a API (pull.ts): teto menor que `desde` (nuvem restaurada) devolve `novo_cursor = desde` com o teto real.
            ["novo_cursor"] = cortada ? pagina[^1].Versao : Math.Max(teto, desde),
            ["tem_mais"] = cortada,
            ["cursor_teto"] = teto,
            ["agora_servidor"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
            ["alteracoes"] = new JsonArray([.. pagina.Select(l => new JsonObject
            {
                ["tabela"] = l.Tabela,
                ["versao"] = l.Versao,
                ["linha"] = l.Linha.DeepClone(),
            })]),
        };
        return Json(HttpStatusCode.OK, corpo.ToJsonString());
    }

    private HttpResponseMessage Renovar(Envio envio)
    {
        if (RenovacaoNaoChega)
        {
            throw new HttpRequestException("Rede caiu antes da renovação chegar.");
        }

        AoRenovar?.Invoke(envio);
        var pedido = JsonNode.Parse(envio.Corpo!)!;
        var requisicao = Guid.Parse(pedido["requisicao_id"]!.GetValue<string>());
        var hash = pedido["novo_token_hash"]!.GetValue<string>();
        if (_renovacaoAplicada != requisicao)
        {
            PedirRenovacao = false;
            HashesValidos.Add(hash);
            _renovacaoAplicada = requisicao;
            _hashRenovado = hash;
        }
        else if (_hashRenovado != hash)
        {
            return Erro(HttpStatusCode.BadRequest, "REQUISICAO_INVALIDA", "Esta renovação já foi aplicada com outro token.");
        }

        if (PerderRespostaDaRenovacao)
        {
            PerderRespostaDaRenovacao = false;
            throw new HttpRequestException("Resposta da renovação perdida.");
        }

        return Json(HttpStatusCode.OK, Fixture("token.renovar.resposta.json"));
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string corpo) =>
        new(status) { Content = new StringContent(corpo, Encoding.UTF8, "application/json") };
}
