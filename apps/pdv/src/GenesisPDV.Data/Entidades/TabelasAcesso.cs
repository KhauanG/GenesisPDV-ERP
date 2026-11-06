using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `acesso` (MD 6.1, 6.2; SYNC 4.1): login offline com o PIN do PDV.
// Mesmo nome e mesmas colunas da nuvem na projeção do pull (colunas que não descem ficam fora; `EsquemaNuvemTests`
// confere contra o Esquema.g.cs gerado). Somente leitura no PDV: o aplicador do pull grava por SQL.

/// <summary><c>perfis</c>: Perfis de acesso.</summary>
public class PerfilRegistro : LinhaEspelho
{
    public string Nome { get; set; } = string.Empty;
    public string? Descricao { get; set; }
    public string? ChaveSistema { get; set; }
}

/// <summary><c>perfis_permissoes</c>: Permissões <c>pdv.*</c> de cada perfil.</summary>
public class PerfilPermissaoRegistro : LinhaEspelho
{
    public Guid PerfilId { get; set; }
    public string Permissao { get; set; } = string.Empty;
}

/// <summary><c>permissoes</c>: Catálogo de permissões do módulo PDV (<c>pdv.*</c>).</summary>
public class PermissaoRegistro : LinhaReferencia
{
    public string Chave { get; set; } = string.Empty;
    public string Modulo { get; set; } = string.Empty;
    public string Grupo { get; set; } = string.Empty;
    public string Descricao { get; set; } = string.Empty;
    public int Ordem { get; set; }
    public bool PermiteLiberacao { get; set; }
}

/// <summary><c>usuarios</c>: Usuários (3.3.1) sem a senha do ERP nem dados pessoais (D19): <c>senha_pdv_hash</c> nulo para quem não tem a loja; <c>ativo</c> já considera a demissão.</summary>
public class UsuarioRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string Login { get; set; } = string.Empty;
    public DateTimeOffset? SenhaAlteradaEm { get; set; }
    public string? SenhaPdvHash { get; set; }
    public bool Ativo { get; set; }
    public Guid? PerfilId { get; set; }
    public bool Master { get; set; }
    [Escala(4)] public decimal LimiteDescontoPct { get; set; }
    [Escala(4)] public decimal ComissaoPct { get; set; }
    public bool Vendedor { get; set; }
    public bool Entregador { get; set; }
    public bool Tecnico { get; set; }
    public bool PdvUtilitario { get; set; }
    public bool ComandaEletronica { get; set; }
    public bool Totem { get; set; }
    public Guid? PessoaId { get; set; }
    public int PermissoesVersao { get; set; }
    public DateTimeOffset? UltimoLoginEm { get; set; }
}

/// <summary><c>usuarios_lojas</c>: Vínculo usuário × loja do terminal (lojas permitidas).</summary>
public class UsuarioLojaRegistro : LinhaEspelho
{
    public Guid UsuarioId { get; set; }
    public Guid LojaId { get; set; }
}

/// <summary><c>usuarios_permissoes</c>: Exceções <c>pdv.*</c> por usuário (negar vence conceder, 3.3.4).</summary>
public class UsuarioPermissaoRegistro : LinhaEspelho
{
    public Guid UsuarioId { get; set; }
    public string Permissao { get; set; } = string.Empty;
    public string Efeito { get; set; } = string.Empty;
}
