#!/usr/bin/env python3
# Lê, sem executar, o cabeçalho e o VERSIONINFO de um executável do Windows (PE) e imprime em JSON (OP-B3; usado pelo
# testar-instalador.sh; README do PDV › decisão 93):
#
#   python3 -I ler-versao-pe.py <arquivo.exe>
#
# {"pe": true, "maquina": "i386", "versao_arquivo": "0.13.0.0", "versao_produto": "0.13.0.0",
#  "textos": {"FileVersion": "0.13.0", "ProductName": "GenesisPDV", ...}, "versionamentos": [...]}
#
# Os campos de fora são os do primeiro VERSIONINFO da seção de recursos; "versionamentos" traz todos, na ordem: o
# GenesisPDV.exe (executável único do .NET) tem dois, o do runtime embutido (InternalName mscordaccore.dll, a versão
# do .NET) e o do próprio aplicativo (InternalName GenesisPDV.dll, ProductVersion X.Y.Z+<commit>).
#
# Sai com 1 se o arquivo não for um PE ou não tiver o VERSIONINFO. Só a biblioteca padrão (rode com -I: o arquivo é
# um binário qualquer, e nada da pasta dele entra no caminho do Python).
import json
import struct
import sys

MAQUINAS = {0x14C: "i386", 0x8664: "x64", 0xAA64: "arm64"}
ASSINATURA_FIXA = 0xFEEF04BD


def falhar(mensagem):
    print(f"ler-versao-pe: {mensagem}", file=sys.stderr)
    sys.exit(1)


def alinhar(posicao):
    return (posicao + 3) & ~3


def ler_bloco(dados, inicio):
    """Um bloco do VERSIONINFO (wLength, wValueLength, wType, szKey, valor, filhos) a partir de `inicio`."""
    tamanho, tamanho_valor, tipo = struct.unpack_from("<HHH", dados, inicio)
    fim = inicio + tamanho
    posicao = inicio + 6
    chave_fim = dados.index(b"\0\0", posicao)
    while (chave_fim - posicao) % 2:  # o terminador UTF-16 começa num byte par
        chave_fim = dados.index(b"\0\0", chave_fim + 1)
    chave = dados[posicao:chave_fim].decode("utf-16-le")
    posicao = alinhar(chave_fim + 2)
    # wValueLength conta palavras de 16 bits nos textos (tipo 1) e bytes nos binários (tipo 0).
    bytes_valor = tamanho_valor * 2 if tipo == 1 else tamanho_valor
    valor = dados[posicao : posicao + bytes_valor]
    posicao = alinhar(posicao + bytes_valor)
    filhos = []
    while posicao < fim:
        filho = ler_bloco(dados, posicao)
        if filho["tamanho"] == 0:
            break
        filhos.append(filho)
        posicao = alinhar(posicao + filho["tamanho"])
    return {"chave": chave, "tipo": tipo, "valor": valor, "filhos": filhos, "tamanho": tamanho}


def versao(ms, ls):
    return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"


def ler_versionamento(dados, inicio):
    raiz = ler_bloco(dados, inicio)
    fixa = raiz["valor"]
    if len(fixa) < 52 or struct.unpack_from("<I", fixa, 0)[0] != ASSINATURA_FIXA:
        falhar("VS_FIXEDFILEINFO ausente ou inválido")
    arquivo_ms, arquivo_ls, produto_ms, produto_ls = struct.unpack_from("<IIII", fixa, 8)
    textos = {}
    for filho in raiz["filhos"]:
        if filho["chave"] != "StringFileInfo":
            continue
        for tabela in filho["filhos"]:
            for texto in tabela["filhos"]:
                textos[texto["chave"]] = texto["valor"].decode("utf-16-le").rstrip("\0").strip()
    return {
        "versao_arquivo": versao(arquivo_ms, arquivo_ls),
        "versao_produto": versao(produto_ms, produto_ls),
        "textos": textos,
    }


def main():
    if len(sys.argv) != 2:
        falhar("uso: ler-versao-pe.py <arquivo.exe>")
    with open(sys.argv[1], "rb") as arquivo:
        dados = arquivo.read()
    if len(dados) < 0x40 or dados[:2] != b"MZ":
        falhar("não é um executável do Windows (sem o cabeçalho MZ)")
    (deslocamento_pe,) = struct.unpack_from("<I", dados, 0x3C)
    if dados[deslocamento_pe : deslocamento_pe + 4] != b"PE\0\0":
        falhar("não é um executável do Windows (sem a assinatura PE)")
    maquina, secoes, _, _, _, tamanho_opcional = struct.unpack_from("<HHIIIH", dados, deslocamento_pe + 4)

    # Só na seção de recursos do próprio executável (.rsrc): um executável único do .NET, por exemplo, carrega outros
    # PE dentro dele, cada um com o seu VERSIONINFO.
    tabela = deslocamento_pe + 24 + tamanho_opcional
    rsrc = None
    for i in range(secoes):
        nome, _, _, tamanho_bruto, inicio_bruto = struct.unpack_from("<8sIIII", dados, tabela + 40 * i)
        if nome.rstrip(b"\0") == b".rsrc":
            rsrc = (inicio_bruto, inicio_bruto + tamanho_bruto)
    if rsrc is None:
        falhar("sem a seção de recursos (.rsrc)")
    marca = "VS_VERSION_INFO".encode("utf-16-le")
    blocos = []
    achado = dados.find(marca, rsrc[0], rsrc[1])
    while achado >= rsrc[0] + 6:
        blocos.append(ler_versionamento(dados, achado - 6))
        achado = dados.find(marca, achado + len(marca), rsrc[1])
    if not blocos:
        falhar("sem o VERSIONINFO")
    resultado = {"pe": True, "maquina": MAQUINAS.get(maquina, hex(maquina))}
    resultado.update(blocos[0])
    resultado["versionamentos"] = blocos
    print(json.dumps(resultado, ensure_ascii=False))


main()
