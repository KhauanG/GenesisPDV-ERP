using System.Reflection;
using System.Text;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace GenesisPDV.Data;

/// <summary>
/// Banco local do PDV (SQLite). Nomes de tabela e coluna do modelo de dados (seção 4); colunas em snake_case
/// derivadas das propriedades; decimais em INTEGER escalado, UUID e datas em TEXT (4.1).
/// </summary>
public class PdvDbContext(DbContextOptions<PdvDbContext> options) : DbContext(options)
{
    public DbSet<IdentidadeTerminal> IdentidadeTerminal => Set<IdentidadeTerminal>();
    public DbSet<ConfiguracaoTerminal> ConfiguracaoTerminal => Set<ConfiguracaoTerminal>();
    public DbSet<EstadoSincronizacao> EstadoSincronizacao => Set<EstadoSincronizacao>();
    public DbSet<EstadoConexao> EstadoConexao => Set<EstadoConexao>();
    public DbSet<EventoSaida> EventosSaida => Set<EventoSaida>();
    public DbSet<SequenciaLocal> SequenciasLocais => Set<SequenciaLocal>();
    public DbSet<EstadoOperacao> EstadoOperacao => Set<EstadoOperacao>();
    public DbSet<FilaImpressao> FilaImpressao => Set<FilaImpressao>();
    public DbSet<LogLocal> LogLocal => Set<LogLocal>();
    public DbSet<LogAuditoriaLocal> LogAuditoriaLocal => Set<LogAuditoriaLocal>();
    public DbSet<VendaRegistro> Vendas => Set<VendaRegistro>();
    public DbSet<ItemVendaRegistro> ItensVenda => Set<ItemVendaRegistro>();
    public DbSet<PagamentoVendaRegistro> PagamentosVenda => Set<PagamentoVendaRegistro>();
    public DbSet<ParcelaVendaRegistro> ParcelasVenda => Set<ParcelaVendaRegistro>();
    public DbSet<CobrancaPixRegistro> CobrancasPix => Set<CobrancaPixRegistro>();
    public DbSet<SessaoCaixaRegistro> SessoesCaixa => Set<SessaoCaixaRegistro>();
    public DbSet<MovimentoCaixaRegistro> MovimentosCaixa => Set<MovimentoCaixaRegistro>();
    public DbSet<FechamentoCaixaRegistro> FechamentosCaixa => Set<FechamentoCaixaRegistro>();
    public DbSet<FechamentoCaixaFormaRegistro> FechamentosCaixaFormas => Set<FechamentoCaixaFormaRegistro>();
    public DbSet<MovimentoVasilhameRegistro> MovimentosVasilhame => Set<MovimentoVasilhameRegistro>();
    public DbSet<ProdutoRegistro> Produtos => Set<ProdutoRegistro>();
    public DbSet<ProdutoCodigoBarrasRegistro> ProdutosCodigosBarras => Set<ProdutoCodigoBarrasRegistro>();
    public DbSet<ProdutoLojaRegistro> ProdutosLojas => Set<ProdutoLojaRegistro>();
    public DbSet<ProdutoPrecoQuantidadeRegistro> ProdutosPrecosQuantidade => Set<ProdutoPrecoQuantidadeRegistro>();
    public DbSet<GrupoPrecoQuantidadeRegistro> GruposPrecoQuantidade => Set<GrupoPrecoQuantidadeRegistro>();
    public DbSet<GrupoPrecoQuantidadeFaixaRegistro> GruposPrecoQuantidadeFaixas => Set<GrupoPrecoQuantidadeFaixaRegistro>();
    public DbSet<ProdutoComponenteRegistro> ProdutosComponentes => Set<ProdutoComponenteRegistro>();
    public DbSet<ProdutoComponenteAlternativaRegistro> ProdutosComponentesAlternativas => Set<ProdutoComponenteAlternativaRegistro>();
    public DbSet<RestricaoHorarioVendaRegistro> RestricoesHorarioVenda => Set<RestricaoHorarioVendaRegistro>();
    public DbSet<FormaPagamentoRegistro> FormasPagamento => Set<FormaPagamentoRegistro>();
    public DbSet<FormaPagamentoLojaRegistro> FormasPagamentoLojas => Set<FormaPagamentoLojaRegistro>();
    public DbSet<UnidadeMedidaRegistro> UnidadesMedida => Set<UnidadeMedidaRegistro>();
    public DbSet<ConfiguracaoRegistro> Configuracoes => Set<ConfiguracaoRegistro>();
    public DbSet<ProdutoVendaSnapshot> ProdutosVendaSnapshot => Set<ProdutoVendaSnapshot>();
    public DbSet<LiberacaoVendaLocal> LiberacoesVenda => Set<LiberacaoVendaLocal>();
    public DbSet<CascoDescontadoVendaLocal> CascosDescontadosVenda => Set<CascoDescontadoVendaLocal>();
    public DbSet<BloqueioSenhaLocal> BloqueiosSenhaLocal => Set<BloqueioSenhaLocal>();
    public DbSet<ComandoRecebido> ComandosRecebidos => Set<ComandoRecebido>();
    public DbSet<UsuarioRegistro> Usuarios => Set<UsuarioRegistro>();
    public DbSet<UsuarioLojaRegistro> UsuariosLojas => Set<UsuarioLojaRegistro>();
    public DbSet<PerfilPermissaoRegistro> PerfisPermissoes => Set<PerfilPermissaoRegistro>();
    public DbSet<UsuarioPermissaoRegistro> UsuariosPermissoes => Set<UsuarioPermissaoRegistro>();
    public DbSet<LojaRegistro> Lojas => Set<LojaRegistro>();
    public DbSet<CaixaRegistro> Caixas => Set<CaixaRegistro>();
    public DbSet<PessoaRegistro> Pessoas => Set<PessoaRegistro>();
    public DbSet<PessoaRelevanciaLojaRegistro> PessoasRelevanciaLoja => Set<PessoaRelevanciaLojaRegistro>();

    /// <summary>
    /// A recusa dos gatilhos da D22 (<see cref="TravaDesativacao"/>) chega como <see cref="DbUpdateException"/> do SQLite;
    /// vira regra de negócio com a mensagem para o operador (a tela mostra e nada foi gravado).
    /// </summary>
    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        try
        {
            return base.SaveChanges(acceptAllChangesOnSuccess);
        }
        catch (DbUpdateException e) when (RecusadoPelaTrava(e))
        {
            throw new Core.Comum.RegraNegocioException(TravaDesativacao.Mensagem);
        }
    }

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        try
        {
            return await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
        }
        catch (DbUpdateException e) when (RecusadoPelaTrava(e))
        {
            throw new Core.Comum.RegraNegocioException(TravaDesativacao.Mensagem);
        }
    }

    private static bool RecusadoPelaTrava(DbUpdateException e) =>
        e.InnerException?.Message.Contains(TravaDesativacao.Marcador, StringComparison.Ordinal) == true;

    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        configurationBuilder.Properties<Guid>().HaveConversion<GuidTexto>();
        configurationBuilder.Properties<DateTimeOffset>().HaveConversion<DataHoraUtcTexto>();
        configurationBuilder.Properties<DateOnly>().HaveConversion<DataTexto>();
        configurationBuilder.Properties<TimeOnly>().HaveConversion<HoraTexto>();
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<IdentidadeTerminal>(e =>
        {
            e.ToTable("identidade_terminal", t =>
            {
                t.HasCheckConstraint("ck_identidade_terminal_id", "id = 1");
                t.HasCheckConstraint("ck_identidade_terminal_status", "status in ('ativo','desativando','revogado')");
            });
            e.Property(x => x.Id).ValueGeneratedNever();
        });

        modelBuilder.Entity<ConfiguracaoTerminal>(e =>
        {
            e.ToTable("configuracao_terminal", t => t.HasCheckConstraint("ck_configuracao_terminal_valor", "json_valid(valor)"));
            e.HasKey(x => x.Chave);
        });

        modelBuilder.Entity<EstadoSincronizacao>(e =>
        {
            e.ToTable("estado_sincronizacao", t => t.HasCheckConstraint(
                "ck_estado_sincronizacao_fluxo",
                "fluxo in ('configuracao','acesso','referencia','catalogo','estoque','pessoas','operacao')"));
            e.HasKey(x => x.Fluxo);
        });

        modelBuilder.Entity<EstadoConexao>(e =>
        {
            e.ToTable("estado_conexao", t => t.HasCheckConstraint("ck_estado_conexao_id", "id = 1"));
            e.Property(x => x.Id).ValueGeneratedNever();
        });

        modelBuilder.Entity<EventoSaida>(e =>
        {
            e.ToTable("eventos_saida", t =>
            {
                t.HasCheckConstraint("ck_eventos_saida_status", $"status in ({Lista(StatusEventoSaida.Todos)})");
                t.HasCheckConstraint("ck_eventos_saida_contexto", "contexto is null or json_valid(contexto)");
                t.HasCheckConstraint("ck_eventos_saida_dependencias", "json_valid(dependencias) and json_type(dependencias) = 'array'");
            });
            e.Property(x => x.Dependencias).HasDefaultValue("[]");
            e.HasIndex(x => x.SequenciaTerminal).IsUnique().HasDatabaseName("uq_eventos_saida_sequencia");
            e.HasIndex(x => new { x.Status, x.SequenciaTerminal }).HasDatabaseName("ix_eventos_saida_status");
            e.HasIndex(x => x.AgregadoId).HasDatabaseName("ix_eventos_saida_agregado");
        });

        modelBuilder.Entity<SequenciaLocal>(e =>
        {
            e.ToTable("sequencias_locais");
            e.HasKey(x => x.Chave);
        });

        modelBuilder.Entity<EstadoOperacao>(e =>
        {
            e.ToTable("estado_operacao", t =>
            {
                t.HasCheckConstraint("ck_estado_operacao_id", "id = 1");
                t.HasCheckConstraint("ck_estado_operacao_modo", "modo is null or modo in ('balcao','comanda','delivery','pagamento','fechamento')");
            });
            e.Property(x => x.Id).ValueGeneratedNever();
        });

        modelBuilder.Entity<FilaImpressao>(e =>
        {
            e.ToTable("fila_impressao", t => t.HasCheckConstraint(
                "ck_fila_impressao_status", "status in ('pendente','imprimindo','impresso','falhou','cancelado')"));
            e.HasIndex(x => new { x.Status, x.CriadoEm }).HasDatabaseName("ix_fila_impressao_status");
            // O original de um documento (o cupom da venda, o fechamento do caixa) para a 2ª via (Central do PDV, bloco G6):
            // a fila guarda um trabalho por documento impresso e não é expurgada.
            e.HasIndex(x => new { x.TipoDocumento, x.ReferenciaId }).HasDatabaseName("ix_fila_impressao_documento");
        });

        modelBuilder.Entity<LogLocal>(e =>
        {
            e.ToTable("log_local", t => t.HasCheckConstraint(
                "ck_log_local_nivel", "nivel in ('debug','info','aviso','erro','critico')"));
            e.Property(x => x.Id).ValueGeneratedOnAdd();
            e.HasIndex(x => x.OcorridoEm).HasDatabaseName("ix_log_local_ocorrido_em");
        });

        modelBuilder.Entity<LogAuditoriaLocal>(e =>
        {
            e.ToTable("log_auditoria_local");
            e.HasIndex(x => x.EventoId).HasDatabaseName("ix_log_auditoria_local_evento_id");
            // Aba 6 Histórico de uso da Central (bloco G10, README › decisão 74): a lista pelo período (a hora e o id, o
            // desempate do cursor, sem ordenação à parte), por quem fez e por grupo de ações, e o resumo por operador.
            e.HasIndex(x => new { x.OcorridoEm, x.Id }).HasDatabaseName("ix_log_auditoria_local_ocorrido_em");
            e.HasIndex(x => new { x.UsuarioId, x.OcorridoEm }).HasDatabaseName("ix_log_auditoria_local_usuario_ocorrido_em");
            e.HasIndex(x => new { x.Acao, x.OcorridoEm }).HasDatabaseName("ix_log_auditoria_local_acao_ocorrido_em");
            // O filtro "Quem" também pelo que a pessoa liberou com o PIN (README › decisão 78).
            e.HasIndex(x => new { x.AutorizadoPorId, x.OcorridoEm }).HasDatabaseName("ix_log_auditoria_local_autorizado_ocorrido_em");
        });

        modelBuilder.Entity<VendaRegistro>(e =>
        {
            e.ToTable("vendas", t =>
            {
                t.HasCheckConstraint("ck_vendas_status", "status in ('rascunho','em_andamento','em_pagamento','suspensa','pedido_pendente','finalizada','cancelada')");
                t.HasCheckConstraint("ck_vendas_tipo", "tipo in ('pdv','venda')");
                t.HasCheckConstraint("ck_vendas_canal", "canal in ('pdv','erp','ifood','99food','woocommerce','nuvemshop','menu_digital','totem')");
                t.HasCheckConstraint(
                    "ck_vendas_status_fiscal",
                    "status_fiscal in ('nao_aplicavel','pendente','transmitindo','autorizada','contingencia','rejeitada','denegada'," +
                    "'cancelamento_pendente','cancelada','inutilizada','nfe_solicitada')");
                t.HasCheckConstraint("ck_vendas_cancelamento_origem", "cancelamento_origem is null or cancelamento_origem in ('pdv','erp')");
                t.HasCheckConstraint("ck_vendas_modo", "modo in ('balcao','comanda','pedido','delivery')");
                t.HasCheckConstraint("ck_vendas_devolucao", "devolucao in ('nenhuma','parcial','total')");
                t.HasCheckConstraint("ck_vendas_tipo_preco", "tipo_preco in ('varejo','atacado','parcelado')");
                t.HasCheckConstraint("ck_vendas_valores", "subtotal_bruto >= 0 and desconto_itens >= 0 and desconto_total >= 0 and acrescimo_total >= 0 and taxa_servico >= 0 and taxa_entrega >= 0 and valor_frete >= 0 and total >= 0 and troco >= 0");
                t.HasCheckConstraint("ck_vendas_finalizada", "status <> 'finalizada' or finalizada_em is not null");
                t.HasCheckConstraint("ck_vendas_cancelada", "status <> 'cancelada' or (cancelada_em is not null and motivo_cancelamento is not null)");
                t.HasCheckConstraint("ck_vendas_desconto_total_origem", "desconto_total_origem is null or desconto_total_origem in ('operador','cliente','orcamento')");
                t.HasCheckConstraint("ck_vendas_idade_confirmada", "(idade_confirmada_por_id is null) = (idade_confirmada_em is null)");
                // Mesma regra do `~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'` da nuvem (CPF ou CNPJ alfanumérico), com GLOB: o
                // SQLite não tem expressão regular.
                t.HasCheckConstraint(
                    "ck_vendas_cpf_cnpj_nota",
                    "cpf_cnpj_nota is null or (length(cpf_cnpj_nota) = 11 and cpf_cnpj_nota not glob '*[^0-9]*') " +
                    "or (length(cpf_cnpj_nota) = 14 and substr(cpf_cnpj_nota, 1, 12) not glob '*[^0-9A-Z]*' " +
                    "and substr(cpf_cnpj_nota, 13, 2) not glob '*[^0-9]*')");
            });
            e.HasIndex(x => new { x.LojaId, x.NumeroCaixa, x.Numero }).IsUnique().HasDatabaseName("uq_vendas_numero");
            e.HasIndex(x => x.Status).HasDatabaseName("ix_vendas_status");
            e.HasIndex(x => x.SessaoCaixaId).HasDatabaseName("ix_vendas_sessao_caixa_id");
            e.HasMany(x => x.Itens).WithOne().HasForeignKey(i => i.VendaId).HasConstraintName("fk_itens_venda_venda_id");
            e.HasMany(x => x.Pagamentos).WithOne().HasForeignKey(p => p.VendaId).HasConstraintName("fk_pagamentos_venda_venda_id");
        });

        modelBuilder.Entity<ItemVendaRegistro>(e =>
        {
            e.ToTable("itens_venda", t =>
            {
                t.HasCheckConstraint("ck_itens_venda_quantidade", "quantidade > 0");
                t.HasCheckConstraint("ck_itens_venda_valores", "valor_bruto >= 0 and desconto_item >= 0 and desconto_promocao >= 0 and desconto_rateado >= 0 and valor_liquido >= 0");
                t.HasCheckConstraint("ck_itens_venda_promocao", "desconto_promocao = 0 or promocao_id is not null");
                t.HasCheckConstraint("ck_itens_venda_origem_entrada", "origem_entrada is null or origem_entrada in ('leitor','teclado','balanca','etiqueta','busca','cardapio')");
                t.HasCheckConstraint("ck_itens_venda_devolvida", "quantidade_devolvida between 0 and quantidade");
                t.HasCheckConstraint("ck_itens_venda_origem_preco", $"origem_preco in ({Lista(Core.Vendas.OrigemPreco.Todas)})");
                t.HasCheckConstraint(
                    "ck_itens_venda_kit",
                    "(kit_grupo_id is null) = (kit_produto_id is null) and (kit_grupo_id is null) = (kit_componente_id is null) " +
                    "and (kit_grupo_id is null or (kit_quantidade > 0 and kit_preco_unitario >= 0 and kit_descricao is not null)) " +
                    "and (kit_alternativa_id is null or kit_grupo_id is not null) and kit_acrescimo >= 0");
            });
            e.HasIndex(x => new { x.VendaId, x.Sequencia }).IsUnique().HasDatabaseName("uq_itens_venda_sequencia");
            e.HasIndex(x => x.ProdutoId).HasDatabaseName("ix_itens_venda_produto_id");
            e.HasIndex(x => x.KitGrupoId).HasDatabaseName("ix_itens_venda_kit_grupo_id");
        });

        modelBuilder.Entity<PagamentoVendaRegistro>(e =>
        {
            e.ToTable("pagamentos_venda", t =>
            {
                t.HasCheckConstraint("ck_pagamentos_venda_valor", "valor > 0 and troco >= 0 and valor_taxa_servico between 0 and valor");
                t.HasCheckConstraint("ck_pagamentos_venda_status", "status in ('pendente','aprovado','cancelado','estornado')");
                t.HasCheckConstraint("ck_pagamentos_venda_parcelas", "parcelas >= 1");
                t.HasCheckConstraint("ck_pagamentos_venda_indicador", "indicador_pagamento in (0,1)");
                t.HasCheckConstraint("ck_pagamentos_venda_tipo_integracao", "tipo_integracao is null or tipo_integracao in (1,2)");
                t.HasCheckConstraint("ck_pagamentos_venda_uf_pagamento", "(cnpj_pagamento is null) = (uf_pagamento is null)");
            });
            e.HasIndex(x => new { x.VendaId, x.Sequencia }).IsUnique().HasDatabaseName("uq_pagamentos_venda_sequencia");
            e.HasMany(x => x.ParcelasVenda).WithOne().HasForeignKey(p => p.PagamentoVendaId).HasConstraintName("fk_parcelas_venda_pagamento_venda_id");
        });

        modelBuilder.Entity<ParcelaVendaRegistro>(e =>
        {
            e.ToTable("parcelas_venda", t => t.HasCheckConstraint("ck_parcelas_venda_valor", "valor > 0"));
            e.HasIndex(x => new { x.PagamentoVendaId, x.Numero }).IsUnique().HasDatabaseName("uq_parcelas_venda");
        });

        modelBuilder.Entity<CobrancaPixRegistro>(e =>
        {
            e.ToTable("cobrancas_pix", t =>
            {
                t.HasCheckConstraint("ck_cobrancas_pix_status", "status in ('ativa','paga','expirada','cancelada','devolvida','paga_sem_venda')");
                t.HasCheckConstraint("ck_cobrancas_pix_tipo", "tipo in ('dinamico','estatico')");
            });
            e.HasIndex(x => x.VendaId).HasDatabaseName("ix_cobrancas_pix_venda_id");
            e.HasIndex(x => x.Txid).HasDatabaseName("ix_cobrancas_pix_txid");
            e.HasIndex(x => x.PagamentoVendaId).HasDatabaseName("ix_cobrancas_pix_pagamento_venda_id");
            e.HasOne<VendaRegistro>().WithMany().HasForeignKey(x => x.VendaId).HasConstraintName("fk_cobrancas_pix_venda_id");
            e.HasOne<PagamentoVendaRegistro>().WithMany().HasForeignKey(x => x.PagamentoVendaId)
                .HasConstraintName("fk_cobrancas_pix_pagamento_venda_id");
        });

        modelBuilder.Entity<ProdutoVendaSnapshot>(e =>
        {
            e.ToTable("produtos_venda_snapshot", t => t.HasCheckConstraint("ck_produtos_venda_snapshot_dados", "json_valid(dados)"));
            e.HasKey(x => new { x.VendaId, x.ProdutoId });
            e.HasOne<VendaRegistro>().WithMany().HasForeignKey(x => x.VendaId)
                .HasConstraintName("fk_produtos_venda_snapshot_venda_id").OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<LiberacaoVendaLocal>(e =>
        {
            e.ToTable("liberacoes_venda");
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Acao).HasMaxLength(60);
            e.Property(x => x.Motivo).HasMaxLength(255);
            e.HasIndex(x => x.VendaId).HasDatabaseName("ix_liberacoes_venda_venda_id");
            e.HasOne<VendaRegistro>().WithMany().HasForeignKey(x => x.VendaId)
                .HasConstraintName("fk_liberacoes_venda_venda_id").OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<CascoDescontadoVendaLocal>(e =>
        {
            e.ToTable("cascos_descontados_venda", t =>
            {
                t.HasCheckConstraint("ck_cascos_descontados_venda_quantidade", "quantidade between 1 and 9999");
                t.HasCheckConstraint("ck_cascos_descontados_venda_preco", "preco_unitario > 0");
            });
            e.HasKey(x => new { x.VendaId, x.ProdutoVasilhameId });
            e.Property(x => x.Descricao).HasMaxLength(120);
            e.HasOne<VendaRegistro>().WithMany().HasForeignKey(x => x.VendaId)
                .HasConstraintName("fk_cascos_descontados_venda_venda_id").OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<BloqueioSenhaLocal>(e =>
        {
            e.ToTable("bloqueios_senha_local", t => t.HasCheckConstraint("ck_bloqueios_senha_local_tipo", "tipo in ('usuario','cliente')"));
            e.HasKey(x => new { x.Tipo, x.RegistroId });
        });

        modelBuilder.Entity<ComandoRecebido>(e =>
        {
            e.ToTable("comandos_recebidos", t =>
            {
                t.HasCheckConstraint("ck_comandos_recebidos_status", $"status in ({Lista(ComandoRecebido.StatusValidos)})");
                t.HasCheckConstraint("ck_comandos_recebidos_resultado", "resultado is null or json_valid(resultado)");
            });
            e.HasKey(x => x.ComandoId);
        });

        ConfigurarCaixa(modelBuilder);
        ConfigurarEspelhos(modelBuilder);
        AplicarConvencoes(modelBuilder);
    }

    /// <summary>
    /// Tabelas de caixa e de devolução avulsa de cascos (MD 3.12, 4.3; Fase 1C, bloco C9): os CHECKs da nuvem com a mesma
    /// expressão, FKs só entre as tabelas de movimento, a <c>diferenca</c> calculada como a coluna gerada da nuvem e uma
    /// sessão aberta por terminal (<c>uq_sessoes_caixa_aberta</c>, o mesmo índice parcial da nuvem).
    /// </summary>
    private static void ConfigurarCaixa(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SessaoCaixaRegistro>(e =>
        {
            e.ToTable("sessoes_caixa", t =>
            {
                t.HasCheckConstraint("ck_sessoes_caixa_forcado", "not fechamento_forcado or (status = 'fechada' and fechamento_forcado_motivo is not null)");
                t.HasCheckConstraint(
                    "ck_sessoes_caixa_forcado_motivo",
                    "fechamento_forcado_motivo is null or fechamento_forcado_motivo in ('substituicao_terminal','revogacao_terminal')");
                t.HasCheckConstraint("ck_sessoes_caixa_status", "status in ('aberta','bloqueada_sangria','em_fechamento','fechada')");
            });
            e.HasIndex(x => x.TerminalId).IsUnique().HasFilter("status <> 'fechada' and excluido_em is null").HasDatabaseName("uq_sessoes_caixa_aberta");
            e.HasIndex(x => new { x.LojaId, x.DiaOperacional }).HasDatabaseName("ix_sessoes_caixa_loja_dia");
        });

        modelBuilder.Entity<MovimentoCaixaRegistro>(e =>
        {
            e.ToTable("movimentos_caixa", t =>
            {
                t.HasCheckConstraint("ck_movimentos_caixa_cancelado", "not cancelado or (cancelado_em is not null and motivo_cancelamento is not null)");
                t.HasCheckConstraint("ck_movimentos_caixa_estorno_forma", "tipo <> 'estorno_venda' or forma_pagamento_id is not null");
                t.HasCheckConstraint(
                    "ck_movimentos_caixa_sangria", "tipo <> 'sangria' or quem_retira_usuario_id is not null or quem_retira_nome is not null");
                t.HasCheckConstraint(
                    "ck_movimentos_caixa_tipo", "tipo in ('abertura','reforco','sangria','sangria_fechamento','devolucao_troca','estorno_venda')");
                t.HasCheckConstraint("ck_movimentos_caixa_valor", "valor > 0");
            });
            e.HasIndex(x => x.SessaoCaixaId).HasDatabaseName("ix_movimentos_caixa_sessao_caixa_id");
            e.HasOne<SessaoCaixaRegistro>().WithMany().HasForeignKey(x => x.SessaoCaixaId).HasConstraintName("fk_movimentos_caixa_sessao_caixa_id");
        });

        modelBuilder.Entity<FechamentoCaixaRegistro>(e =>
        {
            e.ToTable("fechamentos_caixa", t =>
            {
                t.HasCheckConstraint("ck_fechamentos_caixa_tipo", "tipo in ('fechamento','troca_turno')");
                t.HasCheckConstraint("ck_fechamentos_caixa_zera", "zera_caixa = (tipo = 'fechamento')");
                t.HasCheckConstraint("ck_fechamentos_caixa_resumo", "json_valid(resumo)");
            });
            e.Property(x => x.Diferenca).HasComputedColumnSql("total_digitado - total_calculado", stored: true);
            e.HasIndex(x => x.SessaoCaixaId).IsUnique().HasDatabaseName("uq_fechamentos_caixa_sessao_caixa_id");
            e.HasOne<SessaoCaixaRegistro>().WithMany().HasForeignKey(x => x.SessaoCaixaId).HasConstraintName("fk_fechamentos_caixa_sessao_caixa_id");
        });

        modelBuilder.Entity<FechamentoCaixaFormaRegistro>(e =>
        {
            e.ToTable("fechamentos_caixa_formas", t => t.HasCheckConstraint("ck_fechamentos_caixa_formas_quantidade", "quantidade_pagamentos >= 0"));
            e.Property(x => x.Diferenca).HasComputedColumnSql("valor_digitado - valor_calculado", stored: true);
            e.HasIndex(x => new { x.FechamentoId, x.FormaPagamentoId }).IsUnique().HasDatabaseName("uq_fechamentos_caixa_formas");
            e.HasOne<FechamentoCaixaRegistro>().WithMany().HasForeignKey(x => x.FechamentoId)
                .HasConstraintName("fk_fechamentos_caixa_formas_fechamento_id").OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<MovimentoVasilhameRegistro>(e =>
        {
            e.ToTable("movimentos_vasilhame", t =>
            {
                t.HasCheckConstraint("ck_movimentos_vasilhame_cancelado", "not cancelado or (cancelado_em is not null and motivo_cancelamento is not null)");
                t.HasCheckConstraint("ck_movimentos_vasilhame_comodato", "destino <> 'baixa_comodato' or pessoa_id is not null");
                t.HasCheckConstraint("ck_movimentos_vasilhame_destino", "destino in ('entrada','baixa_comodato','vale')");
                t.HasCheckConstraint("ck_movimentos_vasilhame_quantidade", "quantidade > 0");
                t.HasCheckConstraint("ck_movimentos_vasilhame_vale", "(destino = 'vale') = (vale_id is not null)");
            });
            e.HasIndex(x => x.SessaoCaixaId).HasDatabaseName("ix_movimentos_vasilhame_sessao_caixa_id");
            e.HasOne<SessaoCaixaRegistro>().WithMany().HasForeignKey(x => x.SessaoCaixaId).HasConstraintName("fk_movimentos_vasilhame_sessao_caixa_id");
        });
    }

    /// <summary>
    /// Espelhos do catálogo/configuração (MD 4.2): sem FKs; índices das buscas do caixa; <c>versao</c> e
    /// <c>criado_localmente</c> com <c>DEFAULT 0</c>. Os CHECKs de domínio da nuvem não são repetidos (a linha já foi
    /// validada lá, e um valor novo de enumeração não pode travar o pull); só os de formato local (JSON, booleano, UUID).
    /// </summary>
    private static void ConfigurarEspelhos(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<ProdutoRegistro>(e =>
        {
            e.ToTable("produtos");
            e.HasIndex(x => x.Codigo).HasDatabaseName("ix_produtos_codigo");
            e.HasIndex(x => x.CodigoInterno).HasDatabaseName("ix_produtos_codigo_interno");
            e.HasIndex(x => x.BalancaPlu).HasDatabaseName("ix_produtos_balanca_plu");
            e.HasIndex(x => x.GrupoPrecoQuantidadeId).HasDatabaseName("ix_produtos_grupo_preco_quantidade_id");
        });
        modelBuilder.Entity<ProdutoCodigoBarrasRegistro>(e =>
        {
            e.ToTable("produtos_codigos_barras");
            e.HasIndex(x => x.Codigo).HasDatabaseName("ix_produtos_codigos_barras_codigo");
            e.HasIndex(x => x.ProdutoId).HasDatabaseName("ix_produtos_codigos_barras_produto_id");
        });
        modelBuilder.Entity<ProdutoLojaRegistro>(e =>
        {
            e.ToTable("produtos_lojas");
            e.HasIndex(x => new { x.ProdutoId, x.LojaId }).HasDatabaseName("ix_produtos_lojas_produto_id_loja_id");
        });
        modelBuilder.Entity<ProdutoPrecoQuantidadeRegistro>(e =>
        {
            e.ToTable("produtos_precos_quantidade");
            e.HasIndex(x => x.ProdutoId).HasDatabaseName("ix_produtos_precos_quantidade_produto_id");
        });
        modelBuilder.Entity<GrupoPrecoQuantidadeRegistro>(e => e.ToTable("grupos_preco_quantidade"));
        modelBuilder.Entity<GrupoPrecoQuantidadeFaixaRegistro>(e =>
        {
            e.ToTable("grupos_preco_quantidade_faixas");
            e.HasIndex(x => x.GrupoId).HasDatabaseName("ix_grupos_preco_quantidade_faixas_grupo_id");
        });
        modelBuilder.Entity<ProdutoComponenteRegistro>(e =>
        {
            e.ToTable("produtos_componentes");
            e.HasIndex(x => x.ProdutoId).HasDatabaseName("ix_produtos_componentes_produto_id");
        });
        modelBuilder.Entity<ProdutoComponenteAlternativaRegistro>(e =>
        {
            e.ToTable("produtos_componentes_alternativas");
            e.HasIndex(x => x.ComponenteId).HasDatabaseName("ix_produtos_componentes_alternativas_componente_id");
        });
        modelBuilder.Entity<RestricaoHorarioVendaRegistro>(e =>
        {
            e.ToTable("restricoes_horario_venda", t => t.HasCheckConstraint(
                "ck_restricoes_horario_venda_dias_semana", "dias_semana is null or json_valid(dias_semana)"));
            e.Property(x => x.DiasSemana!).HasConversion(new ListaCurtaJson(), ListaCurtaJson.Comparador);
            e.HasIndex(x => x.LojaId).HasDatabaseName("ix_restricoes_horario_venda_loja_id");
        });
        modelBuilder.Entity<FormaPagamentoRegistro>(e => e.ToTable("formas_pagamento"));
        modelBuilder.Entity<FormaPagamentoLojaRegistro>(e =>
        {
            e.ToTable("formas_pagamento_lojas");
            e.HasIndex(x => x.FormaPagamentoId).HasDatabaseName("ix_formas_pagamento_lojas_forma_pagamento_id");
        });
        modelBuilder.Entity<UnidadeMedidaRegistro>(e => e.ToTable("unidades_medida"));
        modelBuilder.Entity<ConfiguracaoRegistro>(e =>
        {
            e.ToTable("configuracoes", t => t.HasCheckConstraint("ck_configuracoes_valor_json", "valor is null or json_valid(valor)"));
            e.HasIndex(x => x.Chave).HasDatabaseName("ix_configuracoes_chave");
        });

        // Espelhos dos 6 fluxos que a venda ainda não lê (Fase 1B, bloco B4): só tabela e chave; o aplicador do pull grava
        // por SQL gerado do Esquema.g.cs e o login lê `usuarios`, `usuarios_lojas`, `lojas` e `caixas`.
        foreach (var (tabela, tipo) in EspelhosDescida)
        {
            modelBuilder.Entity(tipo).ToTable(tabela);
        }

        // Complementos (F2-B45): a venda da Fase 3 lê os grupos do produto e as opções do grupo.
        modelBuilder.Entity<ProdutoGrupoComplementosRegistro>().HasIndex(x => x.ProdutoId).HasDatabaseName("ix_produtos_grupos_complementos_produto_id");
        modelBuilder.Entity<ProdutoComplementoRegistro>().HasIndex(x => x.GrupoId).HasDatabaseName("ix_produtos_complementos_grupo_id");
        modelBuilder.Entity<PermissaoRegistro>().HasKey(x => x.Chave);
        modelBuilder.Entity<NcmRegistro>().HasKey(x => x.Codigo);
        modelBuilder.Entity<CfopRegistro>().HasKey(x => x.Codigo);
        modelBuilder.Entity<MeioPagamentoFiscalRegistro>().HasKey(x => x.Codigo);
        modelBuilder.Entity<UfRegistro>().HasKey(x => x.Sigla);
        modelBuilder.Entity<MunicipioRegistro>().HasKey(x => x.CodigoIbge);
        modelBuilder.Entity<PaisRegistro>().HasKey(x => x.CodigoBacen);
        modelBuilder.Entity<MunicipioRegistro>().Property(x => x.CodigoIbge).ValueGeneratedNever();
        modelBuilder.Entity<UsuarioRegistro>(e =>
        {
            e.HasIndex(x => x.Login).HasDatabaseName("ix_usuarios_login");
            e.HasIndex(x => x.Codigo).HasDatabaseName("ix_usuarios_codigo");
        });
        modelBuilder.Entity<UsuarioLojaRegistro>().HasIndex(x => x.UsuarioId).HasDatabaseName("ix_usuarios_lojas_usuario_id");
        modelBuilder.Entity<PerfilPermissaoRegistro>().HasIndex(x => x.PerfilId).HasDatabaseName("ix_perfis_permissoes_perfil_id");
        modelBuilder.Entity<UsuarioPermissaoRegistro>().HasIndex(x => x.UsuarioId).HasDatabaseName("ix_usuarios_permissoes_usuario_id");
        modelBuilder.Entity<SaldoEstoqueRegistro>().HasIndex(x => x.ProdutoId).HasDatabaseName("ix_saldos_estoque_produto_id");
        modelBuilder.Entity<PessoaRelevanciaLojaRegistro>().HasIndex(x => x.PessoaId).HasDatabaseName("ix_pessoas_relevancia_loja_pessoa_id");
        foreach (var filha in new[] { typeof(PessoaCategoriaRegistro), typeof(PessoaEnderecoRegistro), typeof(PessoaTelefoneRegistro),
                     typeof(SaldoCreditoPessoaRegistro), typeof(ParcelaCreditoPessoaRegistro), typeof(SaldoVasilhamePessoaRegistro) })
        {
            var tabela = EspelhosDescida.Single(x => x.Tipo == filha).Tabela;
            modelBuilder.Entity(filha).HasIndex("PessoaId").HasDatabaseName($"ix_{tabela}_pessoa_id");
        }

        foreach (var entidade in modelBuilder.Model.GetEntityTypes().Where(t => typeof(LinhaVersionada).IsAssignableFrom(t.ClrType)))
        {
            entidade.FindProperty(nameof(LinhaVersionada.Versao))!.SetDefaultValue(0L);
            entidade.FindProperty(nameof(LinhaVersionada.CriadoLocalmente))!.SetDefaultValue(false);
            foreach (var propriedade in entidade.GetProperties())
            {
                // Arrays da nuvem (`text[]`, `smallint[]`) em TEXT JSON (MD 4.1), como `dias_semana`.
                if (propriedade.ClrType == typeof(string[]))
                {
                    propriedade.SetValueConverter(new ListaTextoJson());
                    propriedade.SetValueComparer(ListaTextoJson.Comparador);
                }
                else if (propriedade.ClrType == typeof(short[]) && propriedade.GetValueConverter() is null)
                {
                    propriedade.SetValueConverter(new ListaCurtaJson());
                    propriedade.SetValueComparer(ListaCurtaJson.Comparador);
                }
            }
        }
    }

    /// <summary>snake_case, PK <c>pk_tabela</c>, INTEGER escalado por <see cref="EscalaAttribute"/>, CHECK de booleanos e de UUID.</summary>
    private static void AplicarConvencoes(ModelBuilder modelBuilder)
    {
        foreach (var entidade in modelBuilder.Model.GetEntityTypes())
        {
            var tabela = entidade.GetTableName()!;
            foreach (var propriedade in entidade.GetProperties())
            {
                var coluna = ParaSnakeCase(propriedade.Name);
                propriedade.SetColumnName(coluna);
                var tipo = Nullable.GetUnderlyingType(propriedade.ClrType) ?? propriedade.ClrType;
                if (tipo == typeof(decimal))
                {
                    var escala = propriedade.PropertyInfo?.GetCustomAttribute<EscalaAttribute>()
                                 ?? throw new InvalidOperationException($"{entidade.ClrType.Name}.{propriedade.Name}: decimal sem [Escala].");
                    propriedade.SetValueConverter(new EscalaDecimal(escala.Casas));
                }
                else if (tipo == typeof(bool))
                {
                    // O nome curto pode ser de um CHECK da nuvem (ck_movimentos_caixa_cancelado): aí o de formato ganha sufixo.
                    var nome = $"ck_{tabela}_{coluna}";
                    entidade.AddCheckConstraint(entidade.FindCheckConstraint(nome) is null ? nome : $"{nome}_bool", $"{coluna} in (0,1)");
                }
            }

            var pk = entidade.FindPrimaryKey();
            if (pk is not null)
            {
                pk.SetName($"pk_{tabela}");
                if (pk.Properties is [{ ClrType: var t, Name: "Id" } id] && t == typeof(Guid))
                {
                    // O PDV gera o UUID v7 de tudo o que nasce nele (ADR-04); o banco nunca gera.
                    id.ValueGenerated = ValueGenerated.Never;
                    entidade.AddCheckConstraint($"ck_{tabela}_id_uuid", "length(id) = 36");
                }
            }
        }
    }

    /// <summary>Espelhos que só a descida grava (Fase 1B): tabela da nuvem → entidade.</summary>
    public static readonly IReadOnlyList<(string Tabela, Type Tipo)> EspelhosDescida =
    [
            ("atalhos_pdv", typeof(AtalhoPdvRegistro)),
            ("atributos_variacao", typeof(AtributoVariacaoRegistro)),
            ("atributos_variacao_valores", typeof(AtributoVariacaoValorRegistro)),
            ("caixas", typeof(CaixaRegistro)),
            ("categorias", typeof(CategoriaRegistro)),
            ("certificados_digitais", typeof(CertificadoDigitalRegistro)),
            ("cfops", typeof(CfopRegistro)),
            ("cfops_grupos", typeof(CfopGrupoRegistro)),
            ("empresa", typeof(EmpresaRegistro)),
            ("estoques", typeof(EstoqueRegistro)),
            ("impressoras_destino", typeof(ImpressoraDestinoRegistro)),
            ("lojas", typeof(LojaRegistro)),
            ("lojas_banners", typeof(LojaBannerRegistro)),
            ("marcas", typeof(MarcaRegistro)),
            ("meios_pagamento_fiscais", typeof(MeioPagamentoFiscalRegistro)),
            ("municipios", typeof(MunicipioRegistro)),
            ("ncms", typeof(NcmRegistro)),
            ("numeracoes_faixas", typeof(NumeracaoFaixaRegistro)),
            ("paises", typeof(PaisRegistro)),
            ("parametros_fiscais_uf", typeof(ParametroFiscalUfRegistro)),
            ("parcelas_credito_pessoas", typeof(ParcelaCreditoPessoaRegistro)),
            ("perfis", typeof(PerfilRegistro)),
            ("perfis_permissoes", typeof(PerfilPermissaoRegistro)),
            ("permissoes", typeof(PermissaoRegistro)),
            ("pessoas", typeof(PessoaRegistro)),
            ("pessoas_aliases", typeof(PessoaAliasRegistro)),
            ("pessoas_categorias", typeof(PessoaCategoriaRegistro)),
            ("pessoas_enderecos", typeof(PessoaEnderecoRegistro)),
            ("pessoas_relevancia_loja", typeof(PessoaRelevanciaLojaRegistro)),
            ("pessoas_telefones", typeof(PessoaTelefoneRegistro)),
            ("produtos_categorias", typeof(ProdutoCategoriaRegistro)),
            ("produtos_complementos", typeof(ProdutoComplementoRegistro)),
            ("produtos_grupos_complementos", typeof(ProdutoGrupoComplementosRegistro)),
            ("produtos_lotes", typeof(ProdutoLoteRegistro)),
            ("produtos_relacionados", typeof(ProdutoRelacionadoRegistro)),
            ("produtos_tributacao_uf", typeof(ProdutoTributacaoUfRegistro)),
            ("produtos_variacoes", typeof(ProdutoVariacaoRegistro)),
            ("produtos_variacoes_valores", typeof(ProdutoVariacaoValorRegistro)),
            ("saldos_credito_pessoas", typeof(SaldoCreditoPessoaRegistro)),
            ("saldos_estoque", typeof(SaldoEstoqueRegistro)),
            ("saldos_lote", typeof(SaldoLoteRegistro)),
            ("saldos_vasilhame_pessoas", typeof(SaldoVasilhamePessoaRegistro)),
            ("taxas_entrega", typeof(TaxaEntregaRegistro)),
            ("templates_documentos", typeof(TemplateDocumentoRegistro)),
            ("tipos_estoque", typeof(TipoEstoqueRegistro)),
            ("ufs", typeof(UfRegistro)),
            ("usuarios", typeof(UsuarioRegistro)),
            ("usuarios_lojas", typeof(UsuarioLojaRegistro)),
            ("usuarios_permissoes", typeof(UsuarioPermissaoRegistro)),
    ];

    private static string Lista(IEnumerable<string> valores) => string.Join(",", valores.Select(v => $"'{v}'"));

    public static string ParaSnakeCase(string nome)
    {
        var sb = new StringBuilder(nome.Length + 8);
        for (var i = 0; i < nome.Length; i++)
        {
            var c = nome[i];
            if (char.IsUpper(c))
            {
                if (i > 0)
                {
                    sb.Append('_');
                }

                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }
}
