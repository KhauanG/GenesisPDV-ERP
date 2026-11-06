using System.Text.Json;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Roda sempre (também no job do PDV, sem a API). O formato do estado fica num arquivo só,
/// <c>apps/api/test/e2e-pdv/estado.exemplo.json</c>: o <c>servidor.ts</c> confere contra ele (chaves e tipos) o estado
/// que grava, e este teste lê o mesmo exemplo com o <see cref="EstadoE2E"/> do roteiro. Uma chave renomeada de um lado só
/// quebra aqui ou no preparo do servidor, não no meio do e2e. Sem nenhum teste executado, o projeto inteiro pulado
/// faria o <c>dotnet test</c> da solução sair com o código 8.
/// </summary>
public sealed class EstadoE2ETests
{
    [Fact]
    public void Exemplo_do_estado_do_servidor_e_lido_pelo_roteiro()
    {
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "estado.exemplo.json"));
        var estado = JsonSerializer.Deserialize<EstadoE2E>(json)!;
        Assert.Equal("http://127.0.0.1:3399/", estado.Api);
        Assert.Equal((600001, "caixa1", "258036", 4), (estado.CodigoEmpresa, estado.Operador.Login, estado.Operador.Pin, estado.Caixas.Count));
        Assert.Equal(("gerente1", "369147"), (estado.Gerente.Login, estado.Gerente.Pin));
        Assert.Equal(("7891991013000", "17891991013007"), (estado.Catalogo.Lata.Ean, estado.Catalogo.Lata.Dun));
        Assert.False(string.IsNullOrEmpty(estado.Catalogo.Retornavel.Ean));
        Assert.False(string.IsNullOrEmpty(estado.Catalogo.Combo.Ean));
        Assert.Equal(3, estado.Catalogo.ComponentesCombo.Count);
        Assert.NotEqual(Guid.Empty, estado.EstoqueId);
        Assert.NotEqual(Guid.Empty, estado.Catalogo.Casco.Id);
        Assert.Equal(("admin", "SenhaE2ePdv123"), (estado.Erp.Login, estado.Erp.Senha));
        Assert.Equal(("7891149103102", "4.99"), (estado.Produto.Ean, estado.Produto.Preco));
        Assert.NotEqual(Guid.Empty, estado.LojaId);
        Assert.NotEqual(Guid.Empty, estado.Produto.Id);
        Assert.DoesNotContain(Guid.Empty, estado.Caixas);
        Assert.False(string.IsNullOrEmpty(estado.Operador.Nome));
    }
}
