using System.Text;
using System.Text.Json.Nodes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Token;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Rotação do token no PDV (SYNC 3.7) contra a <see cref="ApiFalsa"/>: o pendente é gravado antes do POST, a
/// requisição leva só o hash, a ordem de tentativa é "pendente, depois atual", a promoção acontece no primeiro 200 com o
/// novo, a repetição usa o mesmo id e o mesmo hash, e o pendente que a API nunca aplicou é descartado depois de 24 h.
/// </summary>
public class TokenTests
{
    [Fact]
    public async Task Chamada_autenticada_usa_o_token_da_ativacao()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        await pdv.Cliente.EstadoAsync(ct);
        var envio = pdv.Api.Envios.Last();
        Assert.Equal(("/sync/estado", pdv.Api.TokensEmitidos.Single()), (envio.Rota, envio.Token));
        Assert.Equal([pdv.Api.TokensEmitidos.Single()], await pdv.Cofre.CandidatosAsync(ct));
    }

    [Fact]
    public async Task Renovacao_grava_o_pendente_antes_do_post_e_promove_no_primeiro_200_com_ele()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        var atual = pdv.Api.TokensEmitidos.Single();
        TokenPendente? gravadoAntes = null;
        pdv.Api.AoRenovar = _ => gravadoAntes = new CofreToken(pdv.Terminal, pdv.Protetor, pdv.Relogio).PendenteAsync(ct).GetAwaiter().GetResult();

        Assert.True(await pdv.Rotacao.RenovarAsync(ct));
        Assert.NotNull(gravadoAntes);
        var pendente = (await pdv.Cofre.PendenteAsync(ct))!;
        Assert.Equal(gravadoAntes!.Token, pendente.Token);
        Assert.Matches($"^{pdv.Api.TerminalId:D}\\.[A-Za-z0-9_-]{{43}}$", pendente.Token);
        Assert.DoesNotContain(pendente.Token.Split('.')[1], pendente.ToString(), StringComparison.Ordinal);

        // Só o hash sobe; o mesmo id no corpo e no X-Requisicao-Id. O pendente (ainda não aplicado) leva 401 e o atual autentica.
        var renovacoes = pdv.Api.Envios.Where(e => e.Rota == "/sync/token/renovar").ToList();
        Assert.Equal([pendente.Token, atual], renovacoes.Select(e => e.Token));
        var corpo = JsonNode.Parse(renovacoes[^1].Corpo!)!;
        Assert.Equal(ApiFalsa.HashDoSegredo(pendente.Token), corpo["novo_token_hash"]!.GetValue<string>());
        Assert.Equal(pendente.RequisicaoId.ToString("D"), corpo["requisicao_id"]!.GetValue<string>());
        Assert.All(renovacoes, e => Assert.Equal(pendente.RequisicaoId.ToString("D"), e.RequisicaoId));
        Assert.DoesNotContain(pendente.Token.Split('.')[1], renovacoes[^1].Corpo!, StringComparison.Ordinal);
        Assert.Equal(-1, pdv.BytesDoBanco().AsSpan().IndexOf(Encoding.UTF8.GetBytes(pendente.Token.Split('.')[1])));

        // Até a próxima chamada, o atual continua o gravado; o pendente é tentado primeiro e, com 200, promovido.
        Assert.Equal([pendente.Token, atual], await pdv.Cofre.CandidatosAsync(ct));
        await pdv.Cliente.EstadoAsync(ct);
        Assert.Equal(pendente.Token, pdv.Api.Envios.Last().Token);
        Assert.Null(await pdv.Cofre.PendenteAsync(ct));
        Assert.Equal(0L, pdv.Contar("configuracao_terminal where chave = 'token.pendente'"));
        var identidade = (await pdv.Terminal.ObterIdentidadeAsync(ct))!;
        Assert.Equal(pendente.Token, Encoding.UTF8.GetString(pdv.Protetor.Desproteger(identidade.TokenProtegido, ProtetorSegredos.FinalidadeToken(identidade.TerminalId))));

        // Releitura do banco (reinício do PDV) só conhece o novo.
        Assert.Equal([pendente.Token], await new CofreToken(pdv.Terminal, pdv.Protetor, pdv.Relogio).CandidatosAsync(ct));
    }

    [Fact]
    public async Task Resposta_perdida_repete_com_o_mesmo_id_e_o_mesmo_hash_e_promove_pelo_pendente()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        pdv.Api.PerderRespostaDaRenovacao = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => pdv.Rotacao.RenovarAsync(ct));
        var pendente = (await new CofreToken(pdv.Terminal, pdv.Protetor, pdv.Relogio).PendenteAsync(ct))!;

        // Queda do PDV entre as duas tentativas: o pendente volta do banco.
        var cofre = new CofreToken(pdv.Terminal, pdv.Protetor, pdv.Relogio);
        var cliente = new ClienteSyncHttp(pdv.Http, pdv.Maquina.ParaCliente(), pdv.Relogio, cofre, () => AmbienteSync.Url);
        Assert.True(await new RotacaoToken(cliente, pdv.Terminal, cofre).RenovarAsync(ct));
        var renovacoes = pdv.Api.Envios.Where(e => e.Rota == "/sync/token/renovar" && e.Token == pendente.Token).ToList();
        Assert.Equal(2, renovacoes.Count);
        Assert.Single(renovacoes.Select(e => e.Corpo).Distinct());
        Assert.All(renovacoes, e => Assert.Equal(pendente.RequisicaoId.ToString("D"), e.RequisicaoId));
        // A API já tinha aplicado: o pendente autenticou a repetição e foi promovido ali mesmo.
        Assert.Null(await cofre.PendenteAsync(ct));
        Assert.Equal([pendente.Token], await cofre.CandidatosAsync(ct));
    }

    [Fact]
    public async Task Pendente_que_a_api_nunca_aplicou_so_e_descartado_depois_de_24_h()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        var atual = pdv.Api.TokensEmitidos.Single();
        pdv.Api.RenovacaoNaoChega = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => pdv.Rotacao.RenovarAsync(ct));
        var pendente = (await pdv.Cofre.PendenteAsync(ct))!;

        // O pendente leva 401 e o atual responde: a chamada segue com o atual, o pendente fica.
        await pdv.Cliente.EstadoAsync(ct);
        Assert.Equal([pendente.Token, atual], pdv.Api.Envios.Where(e => e.Rota == "/sync/estado").Select(e => e.Token));
        pdv.Relogio.Agora += TimeSpan.FromHours(23);
        await pdv.Cliente.EstadoAsync(ct);
        Assert.NotNull(await pdv.Cofre.PendenteAsync(ct));

        pdv.Relogio.Agora += TimeSpan.FromHours(2);
        await pdv.Cliente.EstadoAsync(ct);
        Assert.Null(await pdv.Cofre.PendenteAsync(ct));
        Assert.Equal(0L, pdv.Contar("configuracao_terminal where chave = 'token.pendente'"));
        Assert.Equal([atual], await pdv.Cofre.CandidatosAsync(ct));

        // Nova rotação depois do descarte: outro segredo, outro id.
        pdv.Api.RenovacaoNaoChega = false;
        Assert.True(await pdv.Rotacao.RenovarAsync(ct));
        Assert.NotEqual(pendente.Token, (await pdv.Cofre.PendenteAsync(ct))!.Token);
    }

    [Fact]
    public async Task Renovacao_repetida_depois_de_24_h_de_recusa_nao_descarta_o_pendente_que_ela_aplicou()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        pdv.Api.RenovacaoNaoChega = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => pdv.Rotacao.RenovarAsync(ct));
        var pendente = (await pdv.Cofre.PendenteAsync(ct))!;
        await pdv.Cliente.EstadoAsync(ct);

        // 25 h depois, a primeira chamada com o atual é a própria renovação repetida: o pendente leva 401, o atual
        // aplica a troca na API, e esse 200 não pode descartar o pendente que acabou de valer lá.
        pdv.Relogio.Agora += TimeSpan.FromHours(25);
        pdv.Api.RenovacaoNaoChega = false;
        Assert.True(await pdv.Rotacao.RenovarAsync(ct));
        Assert.Equal(pendente, await pdv.Cofre.PendenteAsync(ct));
        Assert.Equal(1L, pdv.Contar("configuracao_terminal where chave = 'token.pendente'"));

        // A chamada seguinte já vai com ele e o promove.
        await pdv.Cliente.EstadoAsync(ct);
        Assert.Equal(pendente.Token, pdv.Api.Envios.Last().Token);
        Assert.Null(await pdv.Cofre.PendenteAsync(ct));
    }

    [Fact]
    public async Task Pendente_promovido_por_outra_chamada_durante_um_401_e_repetido_em_vez_do_anterior()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        var atual = pdv.Api.TokensEmitidos.Single();
        pdv.Api.RenovacaoNaoChega = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => pdv.Rotacao.RenovarAsync(ct));
        var pendente = (await pdv.Cofre.PendenteAsync(ct))!;

        // Esta chamada manda o pendente antes do commit da renovação e leva 401; nesse instante a renovação é aplicada
        // (o atual vira o anterior) e outra chamada promove o pendente com um 200.
        pdv.Api.AoRecusarToken = e =>
        {
            if (e.Token != pendente.Token)
            {
                return;
            }

            pdv.Api.AoRecusarToken = null;
            pdv.Api.HashesValidos.Add(ApiFalsa.HashDoSegredo(pendente.Token));
            pdv.Cofre.SucessoAsync(pendente.Token, ct).GetAwaiter().GetResult();
        };
        await pdv.Cliente.EstadoAsync(ct);

        // A repetição vai com o promovido, nunca com o anterior (que a API trataria como cópia do terminal).
        Assert.Equal([pendente.Token, pendente.Token], pdv.Api.Envios.Where(e => e.Rota == "/sync/estado").Select(e => e.Token));
        Assert.DoesNotContain(pdv.Api.Envios.Skip(1), e => e.Rota == "/sync/estado" && e.Token == atual);
        Assert.Equal([pendente.Token], await pdv.Cofre.CandidatosAsync(ct));
    }

    [Fact]
    public async Task Nunca_ha_dois_pendentes_e_sem_candidato_valido_o_erro_chega_a_tela()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        pdv.Api.RenovacaoNaoChega = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => pdv.Rotacao.RenovarAsync(ct));
        await Assert.ThrowsAsync<InvalidOperationException>(() => pdv.Cofre.GravarPendenteAsync(RotacaoToken.NovoToken(pdv.Api.TerminalId), Guid.NewGuid(), ct));

        // Revogação total na "nuvem": os dois candidatos levam 401 e o cliente devolve TOKEN_INVALIDO.
        pdv.Api.HashesValidos.Clear();
        var erro = await Assert.ThrowsAsync<ErroSyncException>(() => pdv.Cliente.EstadoAsync(ct));
        Assert.Equal("TOKEN_INVALIDO", erro.Codigo);
        Assert.Equal(2, pdv.Api.Envios.Count(e => e.Rota == "/sync/estado"));
    }

    [Fact]
    public void Hash_do_segredo_e_o_da_api()
    {
        // sha256("abc"): o hash é só do segredo, sem o terminal_id.
        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", RotacaoToken.HashDoSegredo("01a18751-a521-7238-b924-56de3eb13b90.abc"));
        Assert.Throws<ArgumentException>(() => RotacaoToken.HashDoSegredo("sem-ponto"));
        Assert.Equal(36 + 1 + 43, RotacaoToken.NovoToken(Guid.NewGuid()).Length);
    }

    [Fact]
    public async Task Configuracao_do_pendente_guarda_so_o_token_protegido()
    {
        using var pdv = await AtivadoAsync();
        var ct = TestContext.Current.CancellationToken;
        pdv.Api.RenovacaoNaoChega = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => pdv.Rotacao.RenovarAsync(ct));
        var valor = (string)pdv.Escalar($"select valor from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.TokenPendente}'")!;
        var json = JsonNode.Parse(valor)!.AsObject();
        Assert.Equal(["token_protegido", "requisicao_id", "criado_em"], json.Select(p => p.Key));
        var pendente = (await pdv.Cofre.PendenteAsync(ct))!;
        Assert.DoesNotContain(pendente.Token.Split('.')[1], valor, StringComparison.Ordinal);
    }

    private static async Task<AmbienteSync> AtivadoAsync()
    {
        var pdv = await AmbienteSync.CriarAsync();
        var resultado = await pdv.AtivarAsync();
        Assert.True(resultado.Ativado, resultado.Mensagem);
        return pdv;
    }
}
