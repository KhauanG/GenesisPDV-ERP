using System.Text.Json;
using System.Text.Json.Serialization;
using GenesisPDV.Core.Produtos;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// JSON de <c>produtos_venda_snapshot.dados</c>: o <see cref="ProdutoVenda"/> com a <c>TabelaPreco</c> (faixas, grupo,
/// embalagens). Só local; decimais como número JSON (o <c>decimal</c> volta exato), enums por nome e sem as propriedades
/// calculadas (preço base, fracionável…), que são refeitas a partir das gravadas.
/// </summary>
public static class SnapshotProdutoJson
{
    private static readonly JsonSerializerOptions Opcoes = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        IgnoreReadOnlyProperties = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    public static string Serializar(ProdutoVenda produto) => JsonSerializer.Serialize(produto, Opcoes);

    public static ProdutoVenda Desserializar(string json) =>
        JsonSerializer.Deserialize<ProdutoVenda>(json, Opcoes) ?? throw new JsonException("Snapshot de produto vazio.");
}
