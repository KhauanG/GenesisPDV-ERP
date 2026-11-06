using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.Fiscal;

/// <summary>Comprovante de venda não fiscal (PDV 19.2), com "NÃO É DOCUMENTO FISCAL" no topo e no rodapé.</summary>
public static class LayoutComprovanteVenda
{
    public const string AvisoNaoFiscal = "*** NÃO É DOCUMENTO FISCAL ***";

    /// <summary>
    /// Marca da reimpressão (PDV 22.2): "2ª VIA - REIMPRESSÃO dd/mm hh:mm" (o travessão vira hífen: a página 860 da
    /// impressora não o tem).
    /// </summary>
    public const string MarcaReimpressao = "2ª VIA - REIMPRESSÃO";

    /// <summary>
    /// Reimpressão (PDV 22.2; Fase 1C, C11b): o mesmo conteúdo do original, precedido da marca com a hora da reimpressão
    /// no fuso da loja. O original já começa com a inicialização da impressora (ESC @), então a marca não muda o resto.
    /// </summary>
    public static byte[] Reimpressao(byte[] original, DateTimeOffset agora, string fusoHorario, int colunas = 48)
    {
        ArgumentNullException.ThrowIfNull(original);
        var quando = TimeZoneInfo.ConvertTime(agora, DiaOperacional.ObterFuso(fusoHorario));
        var marca = new ConstrutorEscPos(colunas)
            .Centro($"{MarcaReimpressao} {quando.ToString("dd/MM HH:mm", NumeroBr.Cultura)}", negrito: true)
            .Separador('=')
            .ParaBytes();
        return [.. marca, .. original];
    }

    public static byte[] Gerar(Venda venda, CabecalhoDocumento c, int colunas = 48, bool imprimeItensCancelados = false)
    {
        ArgumentNullException.ThrowIfNull(venda);
        ArgumentNullException.ThrowIfNull(c);
        var fuso = DiaOperacional.ObterFuso(c.FusoHorario);
        var quando = TimeZoneInfo.ConvertTime(venda.FinalizadaEm ?? venda.IniciadaEm, fuso);
        var p = new ConstrutorEscPos(colunas);

        p.Centro(c.NomeLoja.ToUpperInvariant(), negrito: true);
        p.Centro(c.RazaoSocial.ToUpperInvariant());
        if (c.Cnpj is not null || c.InscricaoEstadual is not null)
        {
            p.Centro($"CNPJ {c.Cnpj ?? "-"}  IE {c.InscricaoEstadual ?? "-"}");
        }

        if (c.Endereco is not null)
        {
            p.Centro(c.Endereco);
        }

        if (c.Telefone is not null)
        {
            p.Centro($"Tel {c.Telefone}");
        }

        p.Separador();
        p.Centro(AvisoNaoFiscal, negrito: true);
        p.Centro(c.TituloRecibo);
        p.Colunado($"Venda: {venda.NumeroExibicao}", quando.ToString("dd/MM/yyyy HH:mm", NumeroBr.Cultura));
        p.Linha($"Caixa: {venda.NumeroCaixa:00}  Operador: {c.NomeOperador.ToUpperInvariant()}");
        if (venda.CpfCnpjNota is { } doc)
        {
            p.Linha($"Cliente: {(doc.Length == 11 ? "CPF" : "CNPJ")} {doc}");
        }

        if (venda.NomeNota is { } nome)
        {
            p.Linha($"Nome: {nome.ToUpperInvariant()}");
        }

        p.Separador();
        p.Linha("#  Descrição");
        p.Colunado("   Qtd x Unit.", "Total");
        p.Separador();
        var combosImpressos = new HashSet<Guid>();
        foreach (var item in venda.Itens.Where(i => imprimeItensCancelados || !i.Cancelado))
        {
            if (item.Kit is { } kit)
            {
                if (combosImpressos.Add(kit.GrupoId))
                {
                    ImprimirCombo(p, venda, item, kit, imprimeItensCancelados);
                }

                continue;
            }

            p.Linha($"{item.Sequencia,-2} {item.Descricao}{(item.EhCasco ? " (casco)" : string.Empty)}");
            if (item.Embalagem is { } embalagem)
            {
                p.Linha($"   {embalagem.Sigla ?? "EMB"} {embalagem.Fator:0.###}" +
                        (embalagem.Preco is { } pe ? $" x {NumeroBr.Preco(pe)}" : string.Empty));
            }

            p.Colunado(
                $"   {NumeroBr.Quantidade(item.Quantidade)} {item.Unidade} x {NumeroBr.Preco(item.PrecoUnitario)}",
                item.Cancelado ? "CANCELADO" : NumeroBr.Dinheiro(item.ValorBruto));
            if (!item.Cancelado && RotuloAtacado(item) is { } rotulo)
            {
                p.Linha($"   {rotulo}");
            }

            if (!item.Cancelado && item.DescontoItem > 0m)
            {
                p.Colunado("   Desconto item", "-" + NumeroBr.Dinheiro(item.DescontoItem));
            }
        }

        var devolvidos = venda.ResumoVasilhames().Sum(r => r.Devolvidos);
        if (devolvidos > 0m)
        {
            p.Linha($"Cascos devolvidos: {devolvidos:0.###}");
        }

        // Desconto pelo valor do casco (10.12, O14; C11c): os vazios a mais, um casco por linha. Somam também em
        // "Cascos devolvidos" e no "Descontos" do rodapé (é parte do desconto no total).
        foreach (var casco in venda.CascosDescontados)
        {
            p.Linha($"Desconto casco: {casco.Descricao}");
            p.Colunado($"   {casco.Quantidade} x {NumeroBr.Preco(casco.PrecoUnitario)}", "-" + NumeroBr.Dinheiro(casco.Valor));
        }

        p.Separador();
        var descontos = venda.DescontoItens + venda.DescontoTotal;
        p.Colunado($"Itens: {venda.QtdItens}", $"Subtotal {NumeroBr.Dinheiro(venda.SubtotalBruto),9}");
        if (descontos > 0m)
        {
            p.Colunado(string.Empty, $"Descontos {("-" + NumeroBr.Dinheiro(descontos)),9}");
        }

        if (venda.AcrescimoTotal > 0m)
        {
            p.Colunado(string.Empty, $"Acréscimos {NumeroBr.Dinheiro(venda.AcrescimoTotal),9}");
        }

        p.Negrito(true).Colunado(string.Empty, $"TOTAL R$ {NumeroBr.Dinheiro(venda.Total),9}").Negrito(false);
        if (venda.EconomiaAtacado > 0m)
        {
            p.Linha($"Economia no atacado: R$ {NumeroBr.Dinheiro(venda.EconomiaAtacado)}");
        }

        p.Separador();
        foreach (var pagamento in venda.PagamentosAtivos)
        {
            // Cartão na maquininha (16.5): a bandeira e as parcelas informativas ao lado da forma.
            var detalhe = pagamento.Detalhe.BandeiraNome is { } bandeira
                ? $" {bandeira.ToUpperInvariant()}" + (pagamento.Parcelas > 1 ? $" {pagamento.Parcelas}X" : string.Empty)
                : string.Empty;
            p.Colunado(pagamento.DescricaoForma + detalhe, NumeroBr.Dinheiro(pagamento.ValorRecebido ?? pagamento.Valor));
        }

        if (venda.Troco > 0m)
        {
            p.Colunado("Troco", NumeroBr.Dinheiro(venda.Troco));
        }

        p.Separador();
        if (c.FraseRodape is not null)
        {
            p.Centro(c.FraseRodape);
        }

        p.Centro(AvisoNaoFiscal, negrito: true);
        p.Centro($"GenesisPDV v{c.VersaoApp}");
        p.Cortar();
        return p.ParaBytes();
    }

    /// <summary>
    /// Combo (PDV 10.9.1, 19.2): a linha do combo com nome, quantidade × preço do combo e total e, embaixo, os
    /// componentes escolhidos com a quantidade, sem preço próprio, e a troca marcada ("MONSTER 2L (troca +2,00)").
    /// </summary>
    private static void ImprimirCombo(ConstrutorEscPos p, Venda venda, ItemVenda primeira, DadosKit kit, bool imprimeCancelados)
    {
        var linhas = venda.LinhasDoCombo(kit.GrupoId, incluirCanceladas: primeira.Cancelado && imprimeCancelados);
        p.Linha($"{primeira.Sequencia,-2} {kit.Descricao}");
        p.Colunado(
            $"   {NumeroBr.Quantidade(kit.Quantidade)} UN x {NumeroBr.Preco(kit.PrecoUnitario)}",
            primeira.Cancelado ? "CANCELADO" : NumeroBr.Dinheiro(linhas.Sum(l => l.ValorBruto)));
        foreach (var linha in linhas)
        {
            var troca = linha.Kit!.AlternativaId is null
                ? string.Empty
                : linha.Kit.Acrescimo > 0m ? $" (troca +{NumeroBr.Dinheiro(linha.Kit.Acrescimo)})" : " (troca)";
            p.Linha($"     {linha.Quantidade.ToString("0.###", NumeroBr.Cultura)} {linha.Descricao}{troca}");
        }

        var desconto = linhas.Sum(l => l.DescontoItem);
        if (!primeira.Cancelado && desconto > 0m)
        {
            p.Colunado("   Desconto combo", "-" + NumeroBr.Dinheiro(desconto));
        }
    }

    /// <summary>"ATACADO 12+ (varejo 3,49)" ou "MIX LATAS 350ML 12+ (varejo 3,49)" abaixo do item (11.3.1).</summary>
    public static string? RotuloAtacado(ItemVenda item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (!OrigemPreco.PorQuantidade(item.OrigemPreco))
        {
            return null;
        }

        // Só o limiar do snapshot: sem ele (venda recuperada sem snapshot) sai sem "12+", nunca a quantidade do cliente.
        var limiar = item.LimiarPreco?.ToString("0.###", NumeroBr.Cultura);
        var nome = item.OrigemPreco == OrigemPreco.GrupoMix ? item.NomeGrupoPreco ?? "MIX" : "ATACADO";
        var varejo = item.PrecoVarejo is { } v ? $" (varejo {NumeroBr.Preco(v)})" : string.Empty;
        return $"{nome}{(limiar is null ? string.Empty : $" {limiar}+")}{varejo}";
    }
}
