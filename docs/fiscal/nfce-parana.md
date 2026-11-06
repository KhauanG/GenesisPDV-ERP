# NFC-e e ICMS de bebidas no Paraná – GenesisPDV & ERP

> **Documento de pesquisa fiscal** para a Fase 3F (NFC-e) do roadmap e para a decisão D1 (`docs/roadmap.md`, seção 16).
> Complementa a seção 18 de `docs/pdv/especificacao-pdv.md` (emissão, contingência, DANFE, inutilização) e as chaves
> `fiscal.*` de `docs/arquitetura/modelo-de-dados.md`.
>
> **Contexto do dono do produto (Ice Beer):** as lojas (conveniência/mercado de bebidas) ficam hoje no **Paraná (PR)**;
> se o PDV escalar, haverá empresas clientes em todo o Brasil. Por isso **nada fiscal é fixo em código para o PR**: tudo
> o que muda por UF vira parâmetro da loja (seção 12). Venda é de **balcão** (o cliente pega o produto, passa no caixa,
> paga); comanda, taxa de serviço, cozinha e delivery ficam como módulos futuros (fase FUT).
>
> **Data da pesquisa:** 30/10/2026. Fonte principal: RICMS/PR consolidado pela Receita Estadual "atualizado até o
> Decreto n. 15.266, de 5.10.2026" ([RICMS/PR][ricms]).
>
> **Legenda de confiança** usada em todo o documento:
> - **[oficial]** conferido no texto de fonte oficial (SEFA-PR, RICMS/PR, CONFAZ, ENCAT/Portal NF-e).
> - **[secundária]** só encontrado em fonte não oficial (empresa de software, blog contábil, notícia); usar com cautela.
> - **não confirmado** — não foi possível conferir; a seção 13 diz o que perguntar ao contador ou à SEFA-PR.
>
> Este documento **não é parecer tributário**. Os números que alimentam o sistema (alíquotas, CST/CSOSN, CEST, cBenef,
> MVA) devem ser validados pelo contador da empresa antes da produção fiscal.

## Sumário

1. [Resumo dos números-chave](#1-resumo-dos-números-chave)
2. [Obrigatoriedade da NFC-e no Paraná](#2-obrigatoriedade-da-nfc-e-no-paraná)
3. [Credenciamento, certificado e CSC](#3-credenciamento-certificado-e-csc)
4. [Web services, QR Code e consulta](#4-web-services-qr-code-e-consulta)
5. [Prazos: cancelamento, substituição, contingência, inutilização](#5-prazos-cancelamento-substituição-contingência-inutilização)
6. [Regras de emissão que afetam o PDV](#6-regras-de-emissão-que-afetam-o-pdv)
7. [DANFE NFC-e](#7-danfe-nfc-e)
8. [ICMS de bebidas no Paraná](#8-icms-de-bebidas-no-paraná)
9. [Lei da Transparência (tributos aproximados / IBPT)](#9-lei-da-transparência-tributos-aproximados--ibpt)
10. [Recursos do Nuvem3 e seus reflexos na NFC-e](#10-recursos-do-nuvem3-e-seus-reflexos-na-nfc-e)
11. [Reforma Tributária: IBS, CBS e IS na NFC-e](#11-reforma-tributária-ibs-cbs-e-is-na-nfc-e)
12. [Como parametrizar por UF](#12-como-parametrizar-por-uf)
13. [O que pedir ao contador / à SEFA-PR](#13-o-que-pedir-ao-contador--à-sefa-pr)
14. [Fontes](#14-fontes)

---

## 1. Resumo dos números-chave

| Tema | Paraná | Confiança | Fonte |
|---|---|---|---|
| NFC-e obrigatória para o varejo | Sim; por CNAE de 1º.7.2015 a 1º.1.2016 (bebidas, 4723-7/00, e conveniência, 4729-6/02, desde 1º.12.2015; minimercados, 4712-1/00, e todo o comércio varejista desde 1º.1.2016, inciso VII); ECF/modelo 2 já autorizados só até 31.12.2016; **MEI dispensado** | [oficial] | [Res. SEFA 145/2015][res145], arts. 1º, 4º e 7º |
| Autorizador | Próprio da SEFA-PR (não usa SVRS) | [oficial] | [SEFA-PR – credenciamento][pr-cred], [web services][pr-ws] |
| Cancelamento comum (evento 110111) | **30 minutos** após a autorização, se a mercadoria não saiu | [oficial] | [RICMS/PR][ricms], Anexo III, Subanexo I, art. 35 |
| Cancelamento por substituição (110112) | **168 horas** após a autorização da nota substituída | [oficial] | [RICMS/PR][ricms], art. 35-A |
| Transmissão da contingência offline (tpEmis=9) | Prazo legal vigente: **até o 1º dia útil subsequente** à emissão; o portal da SEFA-PR e a NPF 100/2014 ainda falam em 24 h, mas citam o RICMS/2012 revogado. O sistema usa **24 h** como padrão conservador | [oficial] (RICMS/2017); 24 h = fontes desatualizadas | [RICMS/PR][ricms], art. 32, § 1º, II; [SEFA-PR – contingência][pr-cont]; [NPF 100/2014][npf100] |
| Inutilização | Até o **10º dia do mês subsequente** | [oficial] | [RICMS/PR][ricms], art. 36 |
| Identificação obrigatória do consumidor | Venda **≥ R$ 10.000,00**; venda não presencial (com endereço); abaixo disso, só se o consumidor pedir | [oficial] | [RICMS/PR][ricms], art. 25, VII |
| Valor máximo de uma NFC-e | **< R$ 200.000,00** (a partir disso, NF-e) | [oficial] | [RICMS/PR][ricms], art. 25, § 4º |
| Responsável técnico (`infRespTec`) | **Obrigatório** na NFC-e desde 3.6.2019 (rejeições 972/973); CSRT só no modelo 55 (desde 1º.4.2025); modelo 65 = implementação futura | [oficial] | [NT 2018.005 v1.40][nt2018005], regras ZD01-10, ZD02-10, ZD07-10 |
| Atraso máximo entre `dhEmi` e autorização (tpEmis=1) | **5 minutos** (expectativa da NT); autorização da NFC-e é **síncrona** (lote de 1 nota) | [oficial] | [NT 2025.001 v1.02][nt2025001], seções 02.3 e 02.4 |
| CSC | Até **2 CSC válidos por ambiente**, por CNPJ base (8 dígitos), pedidos no Portal Receita/PR | [oficial] | [SEFA-PR – CSC][pr-csc] |
| QR Code | Página da SEFA-PR já documenta a **versão 3** (`p=chave\|3\|tpAmb`) | [oficial] | [SEFA-PR – QR Code][pr-qr], [NT 2025.001 v1.02][nt2025001] |
| ICMS interno, consumidor final (antes do FECOP) | Cerveja/chope/destilados 27%; cigarros (24.02, 24.03) 27%; demais tabacaria 17,5%; refrigerantes, águas saborizadas, energéticos/isotônicos (NCM 22.02) 18%; água mineral (22.01) e vinho (22.04) 17,5%; alíquota geral 19,5% | [oficial] | [RICMS/PR][ricms], art. 17, V e § 11 |
| FECOP (Fundo de Combate à Pobreza) | **+2 pontos percentuais** sobre água mineral, 22.02, cervejas, chopes e bebidas alcoólicas (22.03 a 22.06 e 22.08) e tabaco (24.01 a 24.99), inclusive na ST | [oficial] | [RICMS/PR][ricms], Anexo XII |
| ST de bebidas frias (CEST 03.xxx) | Cerveja, chope, cerveja sem álcool, refrigerantes, energéticos, hidroeletrolíticos, águas saborizadas (Anexo IX, art. 24) | [oficial] | [RICMS/PR][ricms], Anexo IX, art. 24 |
| ST de bebidas quentes (CEST 02.xxx) | Destilados, aperitivos, batidas, ices etc. (Anexo IX, art. 35); **vinho (02.024) saiu da ST** | [oficial] | [RICMS/PR][ricms], Anexo IX, art. 35 |
| Água mineral natural (NCM 2201.10, CEST 03.001 a 03.006/03.024) | Pela leitura das notas do art. 24, **fora da ST** desde 1º.5.2020; há indícios em sentido contrário (título da Seção III, § 4º do art. 24, página da pauta) — ver 8.3. Não presumir tributação na saída até confirmar | **não confirmado** (leitura própria, com contraprova) | [RICMS/PR][ricms], Anexo IX, art. 24; [pauta de bebidas][pr-pauta] |
| IBS/CBS na NFC-e (NT 2025.002) | Rejeição por falta do grupo em produção: "implementação futura"; Simples Nacional só a partir de 2027 (data também adiada) | [secundária] | [Tax360][tax360], [Tecnospeed][tecnospeed-rtc] |

---

## 2. Obrigatoriedade da NFC-e no Paraná

- A Resolução SEFA nº 145/2015 tornou obrigatória a NFC-e (modelo 65) em substituição à Nota Fiscal de Venda a
  Consumidor (modelo 2) e ao cupom de ECF, por CNAE e por data: **4729-6/02 (lojas de conveniência)** e **4723-7/00
  (comércio varejista de bebidas)** a partir de **1º.12.2015**; **4712-1/00 (minimercados, mercearias)** e
  supermercados a partir de **1º.1.2016**. O cronograma por CNAE vai de **1º.7.2015 a 1º.1.2016**, e o inciso VII
  (**1º.1.2016**) inclui "todos os contribuintes que promovam operações de comércio varejista"; não há inciso com data
  de 2017. A resolução considera o CNAE principal **e os secundários** ([Res. SEFA 145/2015][res145], arts. 1º e 2º).
  **[oficial]**
- ECF e Nota Fiscal de Venda a Consumidor modelo 2 já autorizados puderam ser usados até **31.12.2016** (art. 4º);
  desde **1º.1.2017** o cupom de ECF é irregular ([Res. SEFA 145/2015][res145], art. 4º, §§ 2º e 3º). **[oficial]**
- **Novos inscritos** no CAD/ICMS estão obrigados desde **1º.8.2015** (art. 1º, parágrafo único). **[oficial]**
- **MEI está dispensado** da NFC-e ([Res. SEFA 145/2015][res145], art. 7º). **[oficial]** No sistema isso vira
  parâmetro por regime (`regime_dispensa_nfce`, PR: MEI = dispensado; ver seção 12), nunca regra fixa.
- Hoje é **vedada** a Nota Fiscal de Venda a Consumidor modelo 2; o varejo emite NFC-e ou, alternativamente, NF-e
  modelo 55 ([RICMS/PR][ricms], Anexo III, Subanexo I, art. 23, §§ 2º e 3º). **[oficial]**
- A NFC-e serve para venda **a consumidor final** (pessoa física ou jurídica), presencial ou com entrega, dentro do
  Paraná; não gera crédito de ICMS ao comprador ([NPF 100/2014][npf100], itens 1.2 e 1.3). **[oficial]**
- **Consequência para o projeto:** a premissa da decisão D1 ("NFC-e obrigatória") está confirmada para as lojas do
  Paraná. O cupom não fiscal da Fase 1 não pode substituir a NFC-e em venda real (roadmap, seção 15).
- **NFC-e para comprador com CNPJ continua permitida.** O Ajuste SINIEF 11/2025 vedaria NFC-e com destinatário CNPJ
  a partir de 5.1.2026 (data dada pelo Ajuste SINIEF 30/2025 — [Inventti][inventti-cnpj], [secundária]); o Paraná
  chegou a incluir a regra no RICMS, mas ela foi **revogada antes de produzir efeitos** pelo Decreto 14.761/2026
  ([RICMS/PR][ricms], art. 23, § 6º, e art. 25, VII — notas de revogação). **[oficial]** No âmbito nacional, a
  revogação é atribuída ao Ajuste SINIEF 12/2026 ([Econet][econet-cnpj], [secundária]).
- **NF-e de saída referenciando NFC-e é vedada desde 5.10.2026**, salvo NF-e complementar; o mesmo pacote (Despacho
  CONFAZ 18/2026) criou o **DANFE Simplificado Tipo 2** (NF-e no varejo, desde 3.8.2026) ([Econet][econet-cnpj],
  [secundária]). Consequência: o ERP **não** deve oferecer "converter cupom em nota" (NFC-e → NF-e referenciada); a
  alternativa é decidir pela NF-e **antes** de finalizar (PDV 14.4). Ajuste SINIEF correspondente e internalização no
  RICMS/PR: **não confirmado** (não encontrado no texto consolidado até o Decreto 15.266/2026).

## 3. Credenciamento, certificado e CSC

Requisitos listados pela SEFA-PR: acesso à internet, **certificado digital ICP-Brasil com o CNPJ** da empresa,
**aplicativo emissor** (próprio ou adquirido) e **inscrição estadual regular** ([SEFA-PR – credenciamento][pr-cred]).
**[oficial]**

Passo a passo (cada loja/CNPJ com IE no PR):

1. **Credenciamento em homologação** — automático: todos os contribuintes ativos no CAD/ICMS com regime que permite
   emitir documentos fiscais já estão credenciados no ambiente de testes (sem validade jurídica)
   ([SEFA-PR – credenciamento][pr-cred]). **[oficial]**
2. **Pedido de Uso do aplicativo emissor** — "Solicitar o Pedido de Uso do aplicativo emissor de NFC-e no Portal
   Receita/PR"; o procedimento do sistema emissor está na NPF 063/2012 ([SEFA-PR – credenciamento][pr-cred]).
   **[oficial]** A GenesisPDV (fornecedor) deve pedir a **credencial de SISTEMA** (ou a alteração dela) na SEFA-PR
   conforme a NPF 063/2012: "Para o credenciamento de Sistema emissor de NFC-e, modelo 65, o FORNECEDOR deverá efetuar
   os procedimentos relativos ao pedido da credencial ou de alteração da credencial de SISTEMA, conforme previsto na
   NPF 063/2012" ([SEFA-PR – credenciamento][pr-cred]). **[oficial]** O contribuinte depois vincula o sistema no
   credenciamento em produção (UPD, passo 3). A mesma página põe o **CSC** e o **Pedido de Uso do aplicativo emissor**
   na lista de requisitos, junto com o certificado e a IE. **[oficial]** Os passos e documentos da NPF 063/2012
   (não lida nesta pesquisa): **não confirmado** — seção 13.
3. **Credenciamento em produção** — feito pelo contribuinte no Portal Receita/PR, **serviço UPD**, com o código de
   acesso da área restrita e a senha de um representante legal previamente cadastrado; inclui o cadastro/alteração do
   sistema utilizado; base: NPF 101/2014 ([SEFA-PR – credenciamento][pr-cred]). **[oficial]** O RICMS prevê
   credenciamento voluntário ou de ofício ([RICMS/PR][ricms], art. 24). **[oficial]**
4. **CSC (Código de Segurança do Contribuinte)** — pedido no Portal Receita/PR, menu **"DF-e / NFC-e / CSC /
   Controle"**; o sócio pode solicitar, revogar e consultar o CSC da empresa pelo **CNPJ base (8 dígitos)**; a empresa
   pode ter **até 2 CSC válidos para cada ambiente** (homologação e produção), usados por todos os estabelecimentos
   do PR ([SEFA-PR – CSC][pr-csc]; base: [NPF 100/2014][npf100], item 2.2). **[oficial]**
   - O CSC é usado no QR Code versão 2. A NT 2025.001 criou o QR Code **versão 3**, que dispensa o CSC (na emissão
     normal o QR leva só chave, versão e ambiente; na contingência leva uma assinatura de campos); para emitente pessoa
     jurídica a adoção da v3 é **opcional**, e "futuramente (sem data definida)" o CSC será eliminado
     ([NT 2025.001 v1.02][nt2025001], seção 02.1 e 02.2). **[oficial]** (texto da NT obtido em cópia hospedada por
     terceiro; o Portal Nacional da NF-e estava fora do ar durante a pesquisa.)
   - **Recomendação:** suportar v2 **e** v3 por parâmetro da loja (`nfce_qrcode_versao`), guardar o CSC cifrado como
     o modelo de dados já prevê (`nfce_csc_*`) e usar a v3 onde a UF aceitar.
5. **Responsável técnico / CSRT** — o grupo `infRespTec` (CNPJ, contato, e-mail e fone da software house) é
   **OBRIGATÓRIO na NFC-e do PR desde 3.6.2019**: regras ZD01-10 (rejeição 972, grupo do responsável técnico não
   informado) e ZD02-10 (rejeição 973, CNPJ inválido), modelos 55/65, "implementação futura, exceto as UF AM, MS, PE,
   PR, SC e TO" ([NT 2018.005 v1.40][nt2018005]). **[oficial]** A regra 7ZD02-10 (CNPJ do responsável técnico diverge
   do cadastrado) existe para UF com cadastro de software house, como o PR — o CNPJ enviado deve ser o da credencial de
   SISTEMA (passo 2). **[oficial]** **CSRT/`hashCSRT`**: obrigatório só no **modelo 55** no PR (desde 1º.4.2025); no
   **modelo 65**, "implementação futura" (NT 2018.005 v1.40, Obs. 2 das regras ZD07-10, 7ZD02-10, 7ZD08-10/20,
   7ZD09-10). **[oficial]** (A página da Inventti que divulgou a NT não diferencia os modelos; a fonte é o PDF da NT.)

## 4. Web services, QR Code e consulta

**Web services NFC-e 4.00 da SEFA-PR** ([SEFA-PR – web services][pr-ws]) **[oficial]**:

| Serviço | Homologação | Produção |
|---|---|---|
| Autorização | `https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl` |
| Retorno da autorização (só por compatibilidade: a NFC-e usa autorização **síncrona obrigatória**, `indSinc=1`, lote de 1 nota — NT 2025.001 v1.02, seção 02.3) | `https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeRetAutorizacao4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/NFeRetAutorizacao4?wsdl` |
| Consulta protocolo (chave) | `https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeConsultaProtocolo4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/NFeConsultaProtocolo4?wsdl` |
| Inutilização | `https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeInutilizacao4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/NFeInutilizacao4?wsdl` |
| Status do serviço | `https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeStatusServico4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/NFeStatusServico4?wsdl` |
| Consulta cadastro | `https://homologacao.nfce.sefa.pr.gov.br/nfce/CadConsultaCadastro4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/CadConsultaCadastro4?wsdl` |
| Recepção de evento (cancelamento, substituição) | `https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeRecepcaoEvento4?wsdl` | `https://nfce.sefa.pr.gov.br/nfce/NFeRecepcaoEvento4?wsdl` |

**QR Code (tag `qrCode`)** — base `http://www.fazenda.pr.gov.br/nfce/qrcode?`, a mesma para produção e homologação
(muda o parâmetro `tpAmb`: 1 = produção, 2 = homologação); a página da SEFA-PR descreve a **versão 3**, emissão
online: `http://www.fazenda.pr.gov.br/nfce/qrcode?p=<chave>|3|<tpAmb>` ([SEFA-PR – QR Code][pr-qr]). **[oficial]**
A tabela da v3 online nessa página tem uma 4ª linha, "Identificador do CSC", que **não pertence ao formato** (erro de
edição da página, não parâmetro). A página especifica a assinatura offline da v3 como **RSA-SHA1 em Base64 dos
parâmetros 1 a 7, com o mesmo certificado da NFC-e**. **[oficial]**
O formato v3 em contingência é `p=<chave>|<versao>|<tpAmb>|<dia_emissão>|<vNF>|<tp_idDest>|<idDest>|<assinatura>` e o
v2 é `p=<chave>|2|<tpAmb>|<idCSC>|<hash>` (online) ou com dia, valor e `digVal` (offline)
([NT 2025.001 v1.02][nt2025001], seção 04, "Preenchimento da URL do QR Code", linhas Versão 2 e 3). **[oficial]**
Cronograma da NT: a v1.00 previa produção até 1º.9.2025; a v1.01 removeu a rejeição ZX02-220 "considerando que todas
as UF irão disponibilizar o layout do qrCode v3" — ou seja, a **v3 deve ser aceita em todas as UF**, e a v2 com CSC
continua opcional para PJ. **[oficial]** Versão da NT posterior à v1.02: **não conferida**.

**Consulta pela chave (tag `urlChave`)** — `http://www.fazenda.pr.gov.br/nfce/consulta` (produção e homologação)
([Tecnospeed – URLs de consulta][tecnospeed-url], [secundária]); a SEFA-PR oferece a consulta pública pela chave ou
pelo QR Code ([SEFA-PR – consultar NFC-e][pr-consulta]; [NPF 100/2014][npf100], item 4.1). **[oficial]** Endereço
exato de `urlChave` exigido pela validação do PR: **não confirmado** — conferir no "Manual de Padrões Técnicos do DANFE
NFC-e e QR Code" vigente.

**Manual de Orientação do Contribuinte:** a SEFA-PR mantém o MOC online em `http://moc.sped.fazenda.pr.gov.br/` e
remete ao Portal Nacional da NFC-e (`http://nfce.encat.org/`) ([portal SPED-PR][pr-sped]). **[oficial]**

## 5. Prazos: cancelamento, substituição, contingência, inutilização

Todos os artigos abaixo são do [RICMS/PR][ricms], Anexo III, Subanexo I, Capítulo da NFC-e (arts. 23 a 38).

| Evento | Prazo no PR | Base | Confiança |
|---|---|---|---|
| Cancelamento (evento 110111) | Até **30 minutos** contados da Autorização de Uso, e só se a mercadoria não saiu | art. 35 (redação do Decreto 10.858/2018, Ajuste SINIEF 7/2018) | [oficial] |
| Cancelamento por substituição (110112) | Até **168 horas** da autorização da nota original, quando outra NFC-e em contingência acobertou a mesma operação; o pedido referencia a nota de contingência | art. 35-A | [oficial] |
| Cancelamento fora do prazo (extemporâneo) | O Ajuste SINIEF 19/2016 permite que cada UF aceite em casos excepcionais ([Ajuste SINIEF 19/16 – texto com alterações][lefisc-aj19], cláusula 15ª, § 6º) | procedimento do PR **não confirmado** | [secundária] |
| Transmissão da NFC-e em contingência offline (tpEmis=9) | Prazo legal vigente: "no prazo limite de até o **primeiro dia útil subsequente** contado a partir de sua emissão". O portal da SEFA-PR ([contingência][pr-cont]) e a [NPF 100/2014][npf100] (item 3.5) ainda falam em **24 h**, mas citam o RICMS/2012 revogado (Decreto 6.080/2012, Anexo IX, art. 10, §§ 15 e 16). O sistema usa **24 h** como padrão conservador | RICMS/PR 2017, Anexo III, Subanexo I, art. 32, § 1º, II | [oficial] |
| Exceção para Simples Nacional de pequeno porte | Simples com faturamento anual abaixo de R$ 360 mil pode transmitir a NFC-e de contingência **até o dia 20 do mês seguinte** | [Res. SEFA 145/2015][res145], art. 5º, I | **não confirmado se vigente** |
| Nota de contingência rejeitada | Regerar com **mesmo número e série**, sem mudar imposto, partes ou data, e pedir autorização de novo | art. 32, § 1º, III | [oficial] |
| Inutilização de numeração | Até o **10º dia do mês subsequente**; a partir do 11º dia, salto sem inutilização é presumido "emitido em contingência e não transmitido" | arts. 36 e 32, § 5º | [oficial] |
| Notas transmitidas antes da contingência e sem retorno | Cancelar as autorizadas cuja operação foi acobertada em contingência; inutilizar as não autorizadas | art. 33 | [oficial] |
| Consulta pública da NFC-e | Mínimo de 180 dias completa; depois, dados parciais pelo prazo decadencial | art. 37 | [oficial] |
| Guarda do XML | Art. 175, parágrafo único, do RICMS: os documentos "deverão ser conservados até que ocorra a **prescrição** dos créditos tributários" (CTN, art. 195, parágrafo único). A NPF 100/2014, item 5.1, fala em "prazo **decadencial**": as fontes divergem | art. 30; art. 175, parágrafo único; [NPF 100/2014][npf100], item 5.1 | [oficial]; nº de anos **não confirmado** (na prática, reter por no mínimo 5 anos contados da prescrição, a confirmar com o contador) |

Observações para o PDV (seção 18 da especificação):

- `fiscal.prazo_cancelamento_min` = **30** no PR. Depois de 30 min, o cancelamento comum é rejeitado; a venda tem de
  ser desfeita por outro documento (devolução) — o procedimento exato no PR é **não confirmado** (seção 13).
  Notícia da Nota Paraná/Receita Estadual reforça os 30 minutos ([Coad – Nota Paraná][coad-np], [secundária]).
- `fiscal.prazo_transmissao_contingencia_h` = **24** no PR (o padrão da especificação já é 24 h). O prazo legal vigente
  é o 1º dia útil subsequente (art. 32, § 1º, II); 24 h nunca é mais longo que ele, por isso é o padrão conservador.
  A exceção do Simples abaixo de R$ 360 mil (Res. SEFA 145/2015, art. 5º, I, se vigente) mostra que o prazo pode variar
  por **regime/porte**, e não só por UF: enquanto não confirmada, não é semeada (fica em
  `parametros_fiscais_uf.pendencias`).
- **Atraso máximo da emissão normal:** a NT 2025.001 v1.02 (seção 02.4) diz que, na NFC-e, "se espera um atraso máximo
  de 5 minutos entre a Data de Emissão da NFC-e pela Empresa em relação a Data da Autorização". **[oficial]** Nota
  tpEmis=1 com `dhEmi` muito anterior ao envio tende a ser rejeitada; se a SEFA não responder logo, o PDV entra em
  contingência offline (tpEmis=9) em vez de reenviar uma nota "normal" atrasada. Parâmetro:
  `parametros_fiscais_uf.atraso_max_emissao_min` (PR = 5, a confirmar).
- Contingência no PR é **só offline** (tpEmis=9), sem autorização prévia do fisco; o motivo e a data/hora (com
  segundos) da entrada em contingência vão no XML ([SEFA-PR – contingência][pr-cont];
  [RICMS/PR][ricms], art. 32, § 1º, I). **[oficial]**
- É vedado reutilizar em contingência número já transmitido como "Normal" e vedado inutilizar número emitido em
  contingência ([RICMS/PR][ricms], art. 32, § 2º). **[oficial]** — o fluxo de "substituta com novo número" da
  especificação (18.4) está alinhado.
- A regra de séries exclusivas de contingência (501 a 999) foi **revogada** no PR ([RICMS/PR][ricms], art. 25, § 1º,
  III — nota de revogação pelo Decreto 4.058/2020). **[oficial]** A série por caixa da especificação vale para normal
  e contingência.
- Após a autorização, a NFC-e **não pode ser alterada** e **não existe carta de correção** ([RICMS/PR][ricms],
  art. 29, § 1º). **[oficial]** `fiscal.carta_correcao` deve ficar desligado para modelo 65.

## 6. Regras de emissão que afetam o PDV

| Regra | Detalhe | Base | Confiança |
|---|---|---|---|
| Identificação do destinatário | CPF ou CNPJ (ou documento de estrangeiro): **obrigatória** em operação **≥ R$ 10.000,00**; **opcional** (a pedido do consumidor) abaixo disso; **obrigatória com endereço** em operação **não presencial** (redação do Ajuste SINIEF 9/2026, efeitos desde 3.8.2026; antes era "entregas em domicílio") | [RICMS/PR][ricms], art. 25, VII | [oficial] |
| Redução dos limites | Os valores de R$ 10.000 e R$ 200.000 podem ser reduzidos por norma de procedimento | art. 25, § 5º | [oficial]; existência de NPF reduzindo no PR **não confirmado** |
| Limite da NFC-e | Vedada NFC-e em operação **≥ R$ 200.000,00** (emitir NF-e) | art. 25, § 4º | [oficial] |
| Formas de pagamento | Grupo de pagamento obrigatório | art. 25, § 6º | [oficial] |
| CRT | Obrigatório informar o Código de Regime Tributário | art. 25, § 7º | [oficial] |
| NCM e CEST | NCM obrigatório; CEST de 7 dígitos obrigatório para mercadoria listada no Anexo X, **esteja ou não sob ST** | art. 25, V e VIII | [oficial] |
| GTIN | `cEAN`/`cEANTrib` preenchidos quando o produto tem código de barras; validação contra o Cadastro Centralizado de GTIN (SVRS) | art. 25, VI e IX; art. 28, § 1º | [oficial] |
| Intermediador | CNPJ do intermediador da transação, quando houver (marketplace etc.) | art. 25, XII | [oficial] |
| Numeração | Sequencial de 1 a 999.999.999 por estabelecimento e série; série única = 0; sem subsérie | art. 25, II e § 1º | [oficial] |
| Escrituração | NFC-e canceladas escrituradas sem valores | art. 38, parágrafo único | [oficial] |
| Bloqueio por consumo indevido | O fisco pode suspender/bloquear o acesso ao autorizador de quem consumir os serviços fora do padrão do MOC (ex.: consultas de status em excesso) | art. 38-A | [oficial] |
| Nota Paraná | Consumidor que pede CPF na nota participa do programa (créditos e sorteios) | [GranMoney][granmoney], [secundária] | percentuais **não confirmados** em fonte oficial |

Impactos diretos no PDV:

- **CPF na nota** continua opcional na venda de balcão comum; o PDV deve **exigir** CPF/CNPJ quando
  `total ≥ lojas.nfce_valor_exige_identificacao` (padrão da UF em `parametros_fiscais_uf.identificacao_obrigatoria_valor`;
  PR: 10.000,00) e bloquear a NFC-e quando `total ≥ parametros_fiscais_uf.nfce_valor_maximo` (PR: 200.000,00),
  sugerindo NF-e.
- O status do serviço a cada `fiscal.intervalo_status_sefaz_s` (padrão 300 s, especificação 18.2) é compatível com o art. 38-A, mas o intervalo mínimo aceito
  pela SEFA-PR é **não confirmado** — manter configurável (`fiscal.intervalo_status_sefaz_s`).

## 7. DANFE NFC-e

| Regra | Detalhe | Base | Confiança |
|---|---|---|---|
| Papel | Largura mínima **56 mm** (redação dada pelo Ajuste SINIEF 7/2018; antes 58 mm), legível por no mínimo 6 meses | [RICMS/PR][ricms], art. 31, § 2º, I | [oficial] |
| Conteúdo | QR Code e número do protocolo de autorização (exceto contingência) | art. 31, § 2º, II e III | [oficial] |
| Impressão resumida | Com a concordância do consumidor, o DANFE pode ser impresso **resumido, sem os itens** | art. 31, § 3º, II | [oficial] |
| Substituição da impressão | Com a concordância do consumidor: (a) envio do DANFE em formato eletrônico **ou da chave de acesso**; ou (b) consulta em programa de cidadania fiscal / plataforma eletrônica, desde que o consumidor informe **CPF ou CNPJ**, a NFC-e **não seja de contingência** e, se ele pedir, haja envio eletrônico do DANFE ou da chave | art. 31, § 3º, I | [oficial] |
| Contingência | DANFE **completo (com detalhe da venda)**, com "EMITIDA EM CONTINGÊNCIA" e sem protocolo; **uma via fica no estabelecimento** à disposição do fisco até a autorização (a NPF 100/2014 fala em **duas vias**, a 1ª ao consumidor) | [RICMS/PR][ricms], art. 32, § 3º; [NPF 100/2014][npf100], itens 3.6 e 3.7; [SEFA-PR – contingência][pr-cont] | [oficial] |
| XML ao consumidor | Se pedido no momento da venda, o emitente envia ou disponibiliza o download do XML e do protocolo | art. 29, § 7º | [oficial] |
| Documento não fiscal | Documentos não fiscais relacionados à NFC-e entregues ao consumidor devem trazer, em destaque, "NÃO É DOCUMENTO FISCAL" | art. 31, § 4º (Ajuste SINIEF 32/2024) | [oficial] |

Impactos no PDV (18.5 da especificação):

- `fiscal.danfe_modo` = `resumido` e `eletronico_se_solicitado` são permitidos no PR **com concordância do
  consumidor** (`parametros_fiscais_uf.danfe_resumido_exige_concordancia`, PR = sim); registrar o aceite (auditorias
  `danfe_resumido_aceito` e `danfe_eletronico_aceito`, PDV 18.5).
- Em **contingência** o PDV deve imprimir o DANFE **completo** mesmo com `danfe_modo = resumido` e imprimir a **via do
  estabelecimento** (`parametros_fiscais_uf.contingencia_vias_danfe`, PR = 2). A consulta via programa de cidadania fiscal não vale
  para nota de contingência.
- Comprovantes que não são a NFC-e (recibo de crediário, pré-venda, segunda via gerencial) seguem com "NÃO É
  DOCUMENTO FISCAL" (já é a regra da 18.1).

## 8. ICMS de bebidas no Paraná

### 8.1 Alíquotas internas a consumidor final

[RICMS/PR][ricms], art. 17 (o § 11 trata das operações internas destinadas a consumidor final) **[oficial]**:

| Produto (NCM) | Alíquota | + FECOP (Anexo XII) | Carga no destaque | Base |
|---|---|---|---|---|
| Água mineral (22.01) | 17,5% | +2 p.p. | 19,5% | art. 17, § 11, I, "a" |
| Vinho (22.04) | 17,5% | +2 p.p. | 19,5% | art. 17, § 11, I, "a" |
| Refrigerantes, águas com açúcar/aromatizadas, refrescos, cervejas sem álcool, isotônicos (22.02; energéticos em 2202.99 — ver 8.3) | 18% | +2 p.p. | 20% | art. 17, § 11, I-A |
| Cervejas, chopes e bebidas alcoólicas (22.03, 22.05, 22.06, 22.08 — inclui destilados e cachaça) | 27% | +2 p.p. | 29% | art. 17, § 11, III, "a" |
| Cigarros / fumo e sucedâneos manufaturados (24.02, 24.03) | 27% | +2 p.p. | 29% | art. 17, § 11, III, "b"; Anexo XII, art. 1º, V |
| Demais produtos de tabacaria (24.01 a 24.99) | 17,5% | +2 p.p. | 19,5% | art. 17, § 11, I, "d"; Anexo XII, art. 1º, VIII |
| Demais mercadorias (alíquota geral) | 19,5% | — | 19,5% | art. 17, V |

Fora do § 11 (operações que não são a consumidor final) valem os incisos do caput, ex.: 22.02 a 20% (art. 17, II-A).

- **Tabaco:** as faixas 24.02/24.03 (27%) e 24.01 a 24.99 (17,5%) se sobrepõem; vale a regra **específica** de 27% para
  cigarros e fumo manufaturado, e os 17,5% ficam para o restante da tabacaria (ex.: fumo em folha, essências). Leitura
  própria: **validar com o contador**, junto com a ST de cigarros (não pesquisada aqui).
- **Energético em 2106.90** (preparação alimentícia): fica fora do § 11 e do FECOP; pela leitura do art. 17, V, cai na
  alíquota geral de **19,5%, sem FECOP**. **Não confirmado na prática** (o item costuma estar na ST, CEST 03.013) —
  conferir NCM a NCM com o contador.

### 8.2 FECOP (Fundo Estadual de Combate à Pobreza do Paraná)

- Instituído pela Lei 18.573/2015; nas operações internas a consumidor final com os produtos listados, as alíquotas do
  art. 17, § 11 são **adicionadas de 2 pontos percentuais** ([RICMS/PR][ricms], Anexo XII, art. 1º). **[oficial]**
- Produtos de interesse da Ice Beer: **água mineral (22.01)**; **22.02** (refrigerantes, refrescos, águas
  gaseificadas/aromatizadas, cervejas sem álcool, isotônicos); **cervejas, chopes e bebidas alcoólicas (22.03, 22.04,
  22.05, 22.06 e 22.08)**; **fumo e cigarros (24.02, 24.03)** e produtos de tabacaria (24.01 a 24.99) — relevante para
  conveniência ([RICMS/PR][ricms], Anexo XII, art. 1º, I, II, IV, V e VIII). **[oficial]**
- O adicional **também se aplica na ST** (o substituto retém o FECOP) e **não admite benefício fiscal**, diferimento
  ou suspensão; é recolhido em GR-PR separada, não compensável com créditos ([RICMS/PR][ricms], Anexo XII, arts. 2º a
  4º). **[oficial]**
- **Como aparece na NFC-e:** "deverão constar os valores relativos ao Fecop nos campos específicos do documento"
  ([RICMS/PR][ricms], Anexo XII, art. 6º, redação de 6.4.2018). **[oficial]** O antigo formato `##FECOP<N.NN>##` em
  informações adicionais foi **revogado** em 2018 (mesmo artigo). **[oficial]** Os campos são os do leiaute 4.00:
  `pFCP`/`vFCP` (FCP próprio, item tributado), `vBCFCPSTRet`/`pFCPSTRet`/`vFCPSTRet` (FCP retido anteriormente por ST,
  CST 60/CSOSN 500) e os totais `vFCP`/`vFCPSTRet` — nomes do MOC/NT 2016.002, **não conferidos nesta pesquisa**.
- **Destaque:** o art. 5º do Anexo XII manda acrescer os 2 p.p. à alíquota "para fins de destaque"; como isso se
  traduz em `pICMS` (17,5 ou 19,5?) e `pFCP` (2) no XML é **não confirmado** — perguntar ao contador e testar em
  homologação.
- Empresa do **Simples Nacional**: se e como o FECOP é cobrado/destacado é **não confirmado**.

### 8.3 Substituição tributária (ST) de bebidas

**Bebidas frias** — [RICMS/PR][ricms], Anexo IX, Seção III, art. 24 (substituto: indústria, importador, engarrafador
de água; MVA na Resolução SEFA 020/2017, art. 3º — ver também [SEFA-PR – ST][pr-st]). Posições em vigor pela leitura
do texto consolidado **[oficial]**:

| CEST | NCM | Descrição resumida |
|---|---|---|
| 03.007.00 | 2202.10.00 | Água aromatizada artificialmente (exceto refrescos e refrigerantes) |
| 03.008.00 | 2202.99.00 | Outras águas (2202.99) |
| 03.010.00 / 03.010.01 / 03.010.02 | 2202.10.00, 2202.99.00 | Refrigerante em vidro descartável / PET / lata |
| 03.011.00 | 2202.10.00, 2202.99.00 | Demais refrigerantes |
| 03.011.01 | 22.02 | Espumantes sem álcool |
| 03.012.00 / 03.012.01 | 2106.90.10 | Xarope ou extrato concentrado ("post-mix") / cápsula |
| 03.013.00 / 03.013.01 / 03.013.02 | 2106.90, 2202.99.00 | Bebidas energéticas em lata / PET / vidro |
| 03.015.00 | 2106.90, 2202.99.00 | Bebidas hidroeletrolíticas (isotônicos) |
| 03.021.00 a 03.021.06 | 2203.00.00 | Cerveja (garrafa, lata, barril, outras embalagens) |
| 03.022.00 a 03.022.06 | 2202.91.00 | Cerveja sem álcool |
| 03.023.00 | 2203.00.00 | Chope |

- **Água mineral natural (2201.10.00, CEST 03.001 a 03.006 e 03.024):** as posições foram **revogadas a partir de
  1º.5.2020** (Decreto 4.390/2020) e a tabela que voltaria a incluí-las (alteração 652ª do Decreto 12.857/2022) foi
  **tornada sem efeito** pelo Decreto 8.404/2024 ([RICMS/PR][ricms], Anexo IX, art. 24 — notas). Conclusão provisória:
  água mineral natural **não está na ST** e seria tributada na saída do varejo (17,5% + 2% FECOP). **Não
  confirmado** — é leitura própria de um texto com muitas notas, e há três indícios em sentido contrário:
  1. o **título da Seção III** do Anexo IX recebeu nova redação do Decreto 9.673/2021, com efeitos a partir de
     1º.1.2023: "DAS OPERAÇÕES COM ÁGUA MINERAL OU POTÁVEL, CERVEJA E REFRIGERANTE";
  2. o **§ 4º do art. 24** (MG e SC, "operações com água mineral ou potável", também com efeitos a partir de 1º.1.2023)
     continua no texto;
  3. a página oficial da **pauta de bebidas** diz que a pauta de ST cobre "cervejas, refrigerantes, energéticos,
     isotônicos e ÁGUAS MINERAIS" ([Governo do PR – pauta de bebidas][pr-pauta]).

  Pedido ao contador e à SEFA-PR (seção 13): confirmar se a água mineral natural 2201.10 (incluindo o **garrafão de 10
  a 20 L, CEST 03.024**) está ou não na ST hoje. **Até a confirmação, a configuração do produto não deve presumir
  tributação na saída** (o ERP deixa a tributação de 2201.10 pendente de conferência, sem sugestão automática).
- **Pauta fiscal / PMPF de bebidas frias:** a base de cálculo da ST de cervejas, refrigerantes, energéticos,
  isotônicos e águas usa valores publicados em normas de procedimento (Anexo IX, art. 25 e art. 10, § 3º)
  ([Governo do PR – pauta de bebidas][pr-pauta]). **[oficial]** As tabelas mudam várias vezes ao ano (ex.: NPF 09/2026
  e NPF 31 RE de 7.10.2026, segundo [substituicaotributaria.com][st-noticia], [secundária]; os números dessas NPF são
  **não confirmados** — a fonte bloqueou a conferência; conferir na consulta oficial da pauta, [pr-pauta][pr-pauta]). Isso é assunto do **ERP**
  (entrada de NF-e de fornecedor sem retenção), não da emissão no PDV.
- **Bebidas quentes** — [RICMS/PR][ricms], Anexo IX, Seção VIII, art. 35 (MVA na Resolução SEFA 020/2017, art. 8º):
  CEST **02.001.00 a 02.023.00** (aperitivos e bitter, batidas, bebida ice, cachaça e aguardentes, catuaba,
  conhaque, cooler, gim, jurubeba, licores, pisco, rum, saquê, steinhaeger, tequila, uísque, vermute, vodka e
  derivados, arak, grappa, sidra, sangrias e coquetéis) e **02.999.00** (outras bebidas alcoólicas 22.05 a 22.08).
  **[oficial]** O **vinho (02.024.00, 22.04)** foi **retirado** da ST pelo Decreto 3.042/2019, com efeitos desde 1º.11.2019 (nota no art. 35)
  **[oficial]**: vinho é tributado na saída do varejo (17,5% + 2%). A Consulta 49/2022 trata de uma **bebida alcoólica
  mista gaseificada ("Chopp de Vinho", fermentado de frutas e cerveja), 2206.00.90**, e conclui que ela é sujeita à
  ST na **posição 25 do art. 35**, que "alcança todas as mercadorias da posição 22.06" ([Consulta 49/2022 via
  LegisWeb][consulta49], [secundária]; a página não identifica o órgão emissor e bloqueou a conferência por curl).
- **Cerveja e chope** ficam no segmento **"CERVEJAS, CHOPES, REFRIGERANTES, ÁGUAS E OUTRAS BEBIDAS"** (03), e não no
  **"BEBIDAS ALCOÓLICAS, EXCETO CERVEJA E CHOPE"** (02), pelas próprias tabelas dos segmentos do [RICMS/PR][ricms],
  Anexo IX (e do Convênio ICMS 142/2018). **[oficial]**

### 8.4 CST / CSOSN típicos do varejo

| Situação do item | Regime normal (CRT 3) | Simples Nacional (CRT 1) | Confiança |
|---|---|---|---|
| Recebido com ICMS retido por ST (cerveja, refrigerante, energético, destilados) | **CST 60** (ICMS cobrado anteriormente por ST) | **CSOSN 500** ("ICMS cobrado anteriormente por substituição tributária") | códigos e significado **[oficial]** ([RICMS/PR][ricms], Anexo II, Subanexo I, tabelas de CST e CSOSN; CST 60 também na tabela de cBenef, [SEFA-PR – cBenef][pr-cbenef]); escolha por produto: **a validar com o contador** |
| Tributado normalmente na saída (vinho, itens fora da ST; água mineral natural só depois da confirmação da 8.3) | **CST 00** com alíquota do art. 17 + FECOP | **CSOSN 102** ("Tributada pelo Simples Nacional sem permissão de crédito", sem destaque) | códigos **[oficial]** (Anexo II, Subanexo I); escolha por produto: **a validar com o contador** |
| Grupo de ICMS-ST retido anteriormente na NFC-e (CST 60/CSOSN 500: `vBCSTRet`, `pST`, `vICMSSubstituto`, `vICMSSTRet`) | Exigência no PR: **não confirmado** (as fontes encontradas tratam de NF-e para não consumidor final — [Alterdata][alterdata-938], [secundária]) | idem | manter `fiscal.exige_st_retido_nfce` configurável (já previsto no modelo de dados) |

Regimes (Tabela V do Anexo II, Subanexo I, [RICMS/PR][ricms]) **[oficial]**: a Nota 1 da tabela de CSOSN diz que o CSOSN
se usa na NF-e e na NFC-e "exclusivamente quando o CRT for igual a 1".

| CRT | Regime | Código do ICMS no item |
|---|---|---|
| 1 | Simples Nacional | CSOSN |
| 2 | Simples Nacional, excesso de sublimite de receita bruta | **CST** (como o regime normal) |
| 3 | Regime normal | CST |
| 4 | MEI (Microempreendedor Individual) | **a confirmar com o contador** (pela Nota 1, o CSOSN é só do CRT 1; o MEI é dispensado de NFC-e no PR, seção 2) |

- **Código de Benefício Fiscal (cBenef):** obrigatório no PR desde **1º.2.2019** em NF-e **e NFC-e** quando a operação
  tem benefício; a tabela "por CST" da SEFA-PR foi atualizada em **17.7.2026** (V27); informar cBenef em CST sem
  benefício gera **rejeição 928** ([SEFA-PR – cBenef][pr-cbenef]; base NPF 53/2018). **[oficial]** O sistema deve
  importar a tabela por UF (`cbenef_tabelas`, vigência) e o cadastro fiscal do produto deve indicar quando há
  benefício.
- **Mercadoria recebida sem retenção:** Anexo IX, art. 10 (aquisição interna sem retenção) e art. 11 (aquisição
  interestadual sem retenção; recolhimento na entrada no território paranaense); exceções no art. 12 (hipóteses em que
  o Anexo IX não se aplica) ([RICMS/PR][ricms]). **[oficial]** — assunto do ERP (entrada de mercadorias).

## 9. Lei da Transparência (tributos aproximados / IBPT)

- A Lei 12.741/2012, regulamentada pelo Decreto 8.264/2014, obriga informar no documento fiscal de venda ao
  consumidor o valor aproximado dos tributos (federais, estaduais e municipais) que influem no preço; o MEI é
  dispensado (facultativo) ([Decreto 8.264/2014 – texto via LegJur][legjur-8264], [secundária]; o Planalto bloqueou o
  acesso automatizado durante a pesquisa, e a LegJur também recusou a conferência na revisão — **texto oficial não
  conferido**).
- Na NFC-e o valor vai no campo `vTotTrib` (item e total) e no DANFE pode ser impresso o texto "Informação dos Tributos
  Totais Incidentes (Lei Federal 12.741/2012)" ([manual de NFC-e da SEFAZ-RJ][rj-manual] e
  [Sefin-RO][ro-nfce] — materiais de outras UFs vistos só pelo resumo da busca, [secundária]; detalhe do campo no MOC
  **não conferido**).
- O cálculo usual é pela tabela do IBPT ("De Olho no Imposto"), por NCM e UF, com chave e versão da tabela; o modelo
  de dados já tem `ncms_ibpt` com `aliquota_nacional`, `aliquota_importada`, `aliquota_estadual`,
  `aliquota_municipal`, `versao_tabela`, `chave`, `fonte`. Obrigatoriedade de usar especificamente o IBPT: **não
  confirmado** (a lei admite tabelas de instituição de âmbito nacional — texto não conferido).

## 10. Recursos do Nuvem3 e seus reflexos na NFC-e

O dono confirmou que as lojas usam **vasilhame/casco retornável, fardo, ficha técnica, grupo de itens e atacarejo**, e
em 30/10/2026 que o "grupo de itens" do Nuvem3 é o **combo/kit** com composição (roadmap D16; PDV 10.9.1) e que o **mix**
de preço por quantidade também é usado (PDV 11.3.1). Reflexos fiscais conhecidos:

| Recurso | Reflexo na NFC-e | Base | Confiança |
|---|---|---|---|
| **Fardo** vendido inteiro (ex.: fardo 12 latas) e também por unidade | `cEAN` = GTIN do que foi vendido (pode ser o da unidade logística/fardo); `cEANTrib` = GTIN da **unidade de varejo** (menor unidade com GTIN); `qTrib`/`uTrib`/`vUnTrib` convertidos para a unidade tributável; **`qCom × vUnCom` deve ser igual a `qTrib × vUnTrib`**. O fator do fardo (já previsto na PDV-1) alimenta essa conversão | [RICMS/PR][ricms], Anexo III, Subanexo I, art. 25, VI, "a" a "i" | [oficial] |
| **Atacarejo** (preço de oferta a partir de N unidades) | Não há regra fiscal específica encontrada. Duas formas possíveis: `vUnCom` já no preço de atacado ou preço de varejo com `vDesc` no item. A escolha afeta relatórios de desconto e a base do ICMS de itens tributados | — | **não confirmado** — decidir com o contador (seção 13) |
| **Grupo de itens = combo/kit** (ex.: "COMBO DE WHISKY 1L" = whisky + energético + gelo, com troca de componente) | Decisão do dono: a NFC-e lista **cada componente escolhido como um `det`** com o seu NCM/CEST/GTIN/CST, preço do combo rateado proporcionalmente ao preço de venda de cada componente (Σ `vProd` = preço do combo), nome do combo em `infAdProd`; o kit não tem NCM próprio na nota. Evita um NCM único para mercadorias de tributação diferente (whisky tributado × energético/gelo com ou sem ST) | — | desenho decidido pelo dono; **confirmar com o contador** (seção 13) e na homologação |
| **Grupo de preço por quantidade (mix)** (ex.: quaisquer 12 latas do grupo ativam o preço de oferta) | Cada item continua com seu NCM/CEST/GTIN próprio na NFC-e; o grupo só muda o preço por item (mesmo tratamento do atacarejo) | — | reflexo fiscal **não confirmado** (mesma pergunta do atacarejo) |
| **Ficha técnica** (composição de produto montado na loja, `produzido`: drinque, balde) | A NFC-e descreve o produto vendido (NCM do produto final); a composição baixa estoque dos insumos no ERP | — | **não confirmado** — o contador define NCM/CST do produto montado |
| **Vasilhame / casco retornável** | Venda do casco ao consumidor é venda de mercadoria (item próprio com NCM do vasilhame); a **troca** de casco vazio por cheio sem cobrança não tem documento fiscal definido nesta pesquisa. Remessa/retorno de vasilhame entre empresas usa NF-e (fora do PDV) | — | **não confirmado** — perguntar ao contador: NCM, CFOP e CST do casco vendido; tratamento da troca e da "caução" |
| CFOPs aceitos na NFC-e | Lista de CFOPs permitidos no modelo 65 definida nas regras de validação do MOC | — | lista **não conferida** nesta pesquisa |

## 11. Reforma Tributária: IBS, CBS e IS na NFC-e

> Nenhum texto oficial do Planalto ou do Portal Nacional da NF-e pôde ser aberto durante a pesquisa (bloqueio/HTTP
> 503). Tudo abaixo é **[secundária]** e precisa ser conferido nas versões oficiais antes da Fase 3F.

- **NT 2025.002 (RTC)** acrescenta à NF-e e à NFC-e os grupos de IBS, CBS e Imposto Seletivo por item e nos totais
  ([Tecnospeed – NT 2025.002][tecnospeed-rtc]; [Inventti – NT 2025.002 v1.40][inventti-rtc]). O modelo de dados já
  prevê `cst_ibs_cbs`, `classificacoes_tributarias_ibs_cbs` e `aliquotas_ibs_cbs`.
- **Versão e cronograma:** a v1.52 foi publicada em 1º.10.2026; comunicado de 5.10.2026 adiou a NT para
  **homologação em 26.10.2026 e produção em 16.11.2026** ([Tax360][tax360]; [Retributária][retributaria] não pôde
  ser conferida na revisão — o cronograma fica apoiado na Tax360).
- **Rejeição por falta do grupo IBS/CBS (regra UB12-10):** para o Regime Normal (CRT 3), homologação desde 1º.7.2026
  e produção (antes prevista para 3.8.2026) passou a **"implementação futura"** na v1.51; para Simples Nacional e MEI
  (CRT 1, 2 e 4), a data de produção antes prevista para **4.1.2027** também virou "implementação futura"
  ([Tax360][tax360]). Ou seja: hoje a NFC-e sem o grupo **não é rejeitada** em produção, segundo essas fontes.
- **Alíquotas de teste em 2026:** CBS 0,9% e IBS 0,1%, com dispensa de recolhimento para quem cumprir as obrigações
  acessórias (LC 214/2025, arts. 343 a 346, segundo [reformatributaria.com][rt-2026] e [Barbieri][barbieri-lc214]).
- **2027:** início da cobrança da CBS (com extinção de PIS/Cofins) e do **Imposto Seletivo**; IBS a 0,05% estadual +
  0,05% municipal em 2027–2028 (LC 214/2025, art. 344, segundo as mesmas fontes). Percentual da CBS em 2027: **não
  confirmado** (depende da alíquota de referência).
- **Imposto Seletivo sobre bebidas:** incide sobre **bebidas alcoólicas e bebidas açucaradas** a partir de 2027 (LC
  214/2025, art. 409 e Anexo XVII; arts. 419 a 422). As **alíquotas de 2027 estão previstas para medida provisória**,
  ainda **não publicada em 30.10.2026**; perdido o prazo da noventena (2.10.2026), o início da cobrança em 1º.1.2027 é
  incerto (em 27.10.2026 o ministro da Fazenda disse que a MP sairia "provavelmente esta semana")
  ([Contmatic – IS 2027][contmatic-is]; [CRC-SP][crcsp-is]; noticiário de out/2026). **[secundária]**; publicação
  **não confirmada** — conferir no DOU antes da Fase 3F. Se o IS aparece na NFC-e do varejista (que não é
  contribuinte do IS na revenda) é **não confirmado**.
- **Regime da Ice Beer** (Simples ou Regime Normal) muda as datas acima: **não confirmado** — perguntar ao contador.

## 12. Como parametrizar por UF

Tudo o que varia por UF é **parâmetro da loja** (ou de uma tabela de referência por UF semeada pela plataforma e
editável), nunca constante de código. Valores do Paraná entre parênteses; "conferir" = não confirmado.

> Os nomes desta tabela (e os `fiscal.*` das seções 5 a 7) são os da pesquisa. Os nomes oficiais, já integrados ao modelo, estão em
> `docs/arquitetura/modelo-de-dados.md`: `parametros_fiscais_uf` (3.4.3), `regras_icms_uf`, `pautas_st_uf` e
> `beneficios_fiscais_uf` (3.4), `produtos_tributacao_uf` (3.6.9), colunas de `lojas` (3.2.2), chaves `fiscal.*`
> (3.1.2) e o mapa de nomes (seção 8). O uso no PDV está em `docs/pdv/especificacao-pdv.md`, seção 18.

| Parâmetro | Onde | PR | Fonte do valor PR |
|---|---|---|---|
| `lojas.tipo_emissao` (Não Fiscal / NFC-e / SAT / MFE) | Loja | NFC-e | seção 2 |
| Autorizador e URLs dos web services por ambiente (`uf_autorizadores`: autorização, retorno, consulta, inutilização, status, cadastro, evento; versão do leiaute) | Referência por UF | SEFA-PR própria (seção 4) | [SEFA-PR – web services][pr-ws] |
| URL do QR Code e `urlChave` por ambiente | Referência por UF | `http://www.fazenda.pr.gov.br/nfce/qrcode?` / `.../nfce/consulta` (conferir) | seção 4 |
| `nfce_qrcode_versao` (2 ou 3) | Loja | 3 documentada pela SEFA-PR; v2 ainda aceita? conferir | [SEFA-PR – QR Code][pr-qr] |
| CSC e identificador por ambiente (`nfce_csc_*`) e limite de CSC ativos | Loja (cifrado) | até 2 por ambiente por CNPJ base | [SEFA-PR – CSC][pr-csc] |
| `fiscal.prazo_cancelamento_min` | Referência por UF | 30 | [RICMS/PR][ricms] art. 35 |
| `fiscal.prazo_cancelamento_substituicao_h` | Referência por UF | 168 | art. 35-A |
| `fiscal.aceita_cancelamento_extemporaneo` | Referência por UF | conferir | seção 5 |
| `fiscal.prazo_transmissao_contingencia_h` | Referência por UF (pode variar por regime/porte: seção 5) | 24 (padrão conservador; legal = 1º dia útil subsequente) | [RICMS/PR][ricms] art. 32, § 1º, II; [SEFA-PR – contingência][pr-cont] |
| `fiscal.atraso_max_emissao_min` (atraso máximo `dhEmi` × autorização) | Referência por UF | 5 (conferir) | [NT 2025.001 v1.02][nt2025001], seção 02.4 |
| Regimes dispensados da NFC-e | Referência por UF | MEI | [Res. SEFA 145/2015][res145], art. 7º |
| `fiscal.modalidades_contingencia` | Referência por UF | só offline (tpEmis=9) | [SEFA-PR – contingência][pr-cont] |
| `fiscal.contingencia_vias_danfe` | Referência por UF | 2 (1 fica na loja) | [NPF 100/2014][npf100] 3.6 |
| `fiscal.inutilizacao_prazo_dia` | Referência por UF | 10 | art. 36 |
| `fiscal.identificacao_obrigatoria_valor` | Referência por UF | 10.000,00 (conferir NPF de redução) | art. 25, VII |
| `fiscal.nfce_valor_maximo` | Referência por UF | 200.000,00 | art. 25, § 4º |
| `fiscal.identificacao_obrigatoria_nao_presencial` (com endereço) | Referência por UF | sim (desde 3.8.2026) | art. 25, VII, "c" |
| `fiscal.danfe_modo` permitido (completo / resumido / eletrônico / consulta em programa de cidadania) | Loja, limitado pela UF | todos, com concordância do consumidor | art. 31, § 3º |
| `fiscal.programa_cidadania` (nome, se aceita CPF na nota em lugar do DANFE) | Referência por UF | Nota Paraná (aceitação como substituto do DANFE: conferir) | seção 7 |
| Alíquotas internas por NCM e destino (consumidor final ou não) | Regra tributária por UF | seção 8.1 | art. 17 |
| FCP: produtos (NCM), percentual, se incide na ST, campos obrigatórios | Regra tributária por UF | 2 p.p.; 22.01, 22.02, 22.03 a 22.06, 22.08, tabaco | Anexo XII |
| ST: segmentos/CEST sujeitos, MVA, pauta/PMPF, exigência do grupo de ST retido na NFC-e (`fiscal.exige_st_retido_nfce`) | Regra tributária por UF | seção 8.3; grupo retido: conferir | Anexo IX |
| Tabela cBenef por CST e vigência | Referência por UF | V27 de 17.7.2026 | [SEFA-PR – cBenef][pr-cbenef] |
| Tabela IBPT (por NCM e UF) | Referência por UF | — | seção 9 |
| Regras de validação ativas por UF (CSRT, `infRespTec`, GTIN) | Referência por UF | `infRespTec` **obrigatório** (desde 3.6.2019); CSRT NFC-e futuro (modelo 55: obrigatório desde 1º.4.2025) | [NT 2018.005 v1.40][nt2018005] |
| Certificado A1 por CNPJ | Empresa/loja | e-CNPJ ICP-Brasil | [SEFA-PR – credenciamento][pr-cred] |

**UFs com outro equipamento/documento (SAT/MFE):** em **São Paulo** a emissão do CF-e-SAT foi encerrada — Portaria
SRE 79/2024; desde 1º.1.2026 todas as operações de varejo em SP emitem NFC-e ([CRC-SP][crcsp-sat]) **[secundária,
órgão de classe]**. No **Ceará**, extinção do MF-e **a partir de 1º.1.2026** segundo a Tecnospeed (Decreto 36.417/2025)
([Tecnospeed – fim do SAT e MFE][tecnospeed-sat]) **[secundária, texto oficial não conferido]**. Consequência: a fase FUT de SAT/MFE
(PDV 18.7) provavelmente **não será necessária**; manter só a interface.

## 13. O que pedir ao contador / à SEFA-PR

**Ao contador da Ice Beer**

- [ ] Regime de cada CNPJ (Simples Nacional / Lucro Presumido / Real) → CRT, CST × CSOSN e datas da Reforma (seções 8.4
      e 11).
- [ ] Lista de produtos por NCM/CEST com CST/CSOSN, alíquota, FECOP e cBenef de cada um (especialmente água mineral
      natural 2201, vinho 22.04, energéticos 2106.90 × 2202.99, cigarros e tabacaria).
- [ ] Confirmar se a **água mineral natural (2201.10, incluindo garrafão de 10 a 20 L, CEST 03.024) está ou não na
      ST** hoje: as notas do art. 24 indicam saída em 1º.5.2020, mas o título da Seção III, o § 4º do art. 24 e a página
      da pauta indicam o contrário (seção 8.3). Até a resposta, não presumir tributação na saída.
- [ ] Cigarros (24.02/24.03, 27%) × demais tabacaria (17,5%): confirmar a leitura da 8.1 e a ST de cigarros.
- [ ] Como preencher `pICMS` e `pFCP` em item tributado com FECOP (17,5% + 2% ou 19,5% + 2%?) e se o Simples destaca
      FECOP (seção 8.2).
- [ ] Se o PR exige na NFC-e o grupo de ICMS-ST retido anteriormente e o FCP-ST retido para CST 60/CSOSN 500 (liga
      `fiscal.exige_st_retido_nfce`).
- [ ] Atacarejo: preço de atacado direto em `vUnCom` ou preço de varejo + `vDesc` no item (seção 10).
- [ ] Vasilhame/casco: NCM, CFOP e CST do casco vendido; tratamento da troca casco vazio × cheio e de caução.
- [ ] Combos/kits: confirmar a emissão com um `det` por componente (cada um com a sua tributação) e o preço do combo
      rateado proporcionalmente ao preço de venda dos componentes (decisão do dono, PDV 10.9.1), e se o DANFE pode
      trazer uma linha informativa com o nome e o preço do combo acima dos componentes.
- [ ] Produtos com ficha técnica montados na loja (`produzido`): NCM e tributação do produto final.
- [ ] Procedimento no PR quando o cancelamento passa dos **30 min** (devolução? cancelamento extemporâneo?).
- [ ] Prazo de guarda dos XML: o art. 175 do RICMS/PR fala em "até que ocorra a prescrição" e a NPF 100/2014 em
      "prazo decadencial" — quantos anos reter (mínimo de 5 anos contados da prescrição?) e se a guarda em nuvem atende.
- [ ] Uso da tabela IBPT (ou outra) para a Lei 12.741 e formato do texto no DANFE.
- [ ] CFOP de venda a consumidor no PR (5.102 para tributado, 5.405 para ST?) e lista de CFOPs aceitos no modelo 65.

**À SEFA-PR (Receita Estadual do Paraná / SAC) ou ao suporte de credenciamento**

- [ ] Prazo de contingência: a NPF 100/2014 (24 h, baseada no RICMS/2012 revogado) ainda vale, ou só o "primeiro dia
      útil subsequente" do RICMS/2017, art. 32, § 1º, II? A exceção do art. 5º, I, da Res. SEFA 145/2015 (Simples
      abaixo de R$ 360 mil: até o dia 20 do mês seguinte) continua em vigor?
- [ ] QR Code: a versão 2 (com CSC) ainda é aceita para pessoa jurídica? Há data para a v3 obrigatória?
- [ ] Endereço exato de `urlChave` e do QR Code aceitos na validação (http × https).
- [ ] Existe NPF que **reduz** os limites de identificação (R$ 10.000) ou de valor máximo (R$ 200.000)?
- [ ] O Nota Paraná vale como "programa de cidadania fiscal" para substituir a impressão do DANFE (art. 31, § 3º, I,
      "b")? Há credenciamento da plataforma?
- [ ] Credencial de SISTEMA (NPF 063/2012): passos e documentos que a GenesisPDV, como fornecedora, precisa apresentar
      (pedido e alteração da credencial; vínculo do CNPJ com o `infRespTec`).
- [ ] CSRT na NFC-e (modelo 65): quando terá data no PR?
- [ ] Intervalo mínimo aceito para consulta de status do serviço (evitar bloqueio do art. 38-A).
- [ ] Cronograma do PR para as regras de validação do IBS/CBS na NFC-e (NT 2025.002).
- [ ] Internalização no RICMS/PR da vedação de NF-e de saída referenciando NFC-e (desde 5.10.2026, seção 2).
- [ ] Números das NPF da pauta de cerveja de 2026 (09/2026 e 31 RE/2026, só em fonte secundária).

## 14. Fontes

Fontes oficiais (acessadas em 30.10.2026):

- `ricms`: https://www.sefanet.pr.gov.br/dados/SEFADOCUMENTOS/106201707871.pdf — RICMS/PR (Decreto 7.871/2017),
  consolidado até o Decreto 15.266/2026. NFC-e: Anexo III, Subanexo I, arts. 23 a 38; alíquotas: art. 17; ST: Anexo IX
  (Seção III, arts. 24–25; Seção VIII, arts. 35–36); FECOP: Anexo XII.
- `res145`: https://www.sefanet.pr.gov.br/dados/SEFADOCUMENTOS/101201500145.pdf — Resolução SEFA 145/2015
  (obrigatoriedade da NFC-e).
- `npf100`: https://sped.fazenda.pr.gov.br/sites/sped/arquivos_restritos/files/migrados/File/NFCE/NPF_100_2014_NFCe_Consolidada_com_NPF036_2015.pdf
  — NPF 100/2014 consolidada com a NPF 036/2015.
- `pr-sped`: https://sped.fazenda.pr.gov.br/ — portal SPED/NFC-e da SEFA-PR.
- `pr-cred`: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Credenciamento-de-emissores
- `pr-csc`: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Codigo-de-Seguranca-do-Contribuinte-CSC
- `pr-ws`: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Web-Services-NFC-e
- `pr-qr`: https://sped.fazenda.pr.gov.br/NFCe/Pagina/QR-Code
- `pr-cont`: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Contingencia
- `pr-cbenef`: https://sped.fazenda.pr.gov.br/NFe/Pagina/CODIGO-DE-BENEFICIO-FISCAL
- `pr-consulta`: https://www.fazenda.pr.gov.br/servicos/Economia-e-Financas/Documentos-fiscais-eletronicos/Consultar-NFC-e-nota-fiscal-do-consumidor-eletronica-gzNEE1NO
- `pr-st`: https://www.fazenda.pr.gov.br/Pagina/ICMS-Substituicao-tributaria
- `pr-pauta`: https://www.parana.pr.gov.br/servicos/Economia-e-Financas/Tabela-de-precos-minimos/Consultar-pauta-fiscal-de-bebidas-0GNAKLr8
- `nt2025001`: https://inventti.com.br/wp-content/uploads/2025/09/NT2025.001_v1.02-NFCe_qrCode_v3.pdf — NT 2025.001
  v1.02 (documento oficial do Portal Nacional da NF-e, em cópia hospedada por terceiro).
- `nt2018005`: https://inventti.com.br/wp-content/uploads/2024/09/NT2018-005_v1_40.pdf — NT 2018.005 v1.40
  (responsável técnico e CSRT; documento oficial em cópia hospedada por terceiro).
- `rj-manual`: https://portal.fazenda.rj.gov.br/dfe/wp-content/uploads/sites/17/2023/01/DF-e_NFC-e.pdf — manual de
  NFC-e da SEFAZ-RJ (outra UF).
- `ro-nfce`: https://cdn.sefin.ro.gov.br/portalnfce/9ac05befca7d6499e3abec9bdfef2b68.pdf — material de NFC-e da
  Sefin-RO (outra UF).

Fontes secundárias (as marcadas com * não puderam ser conferidas na revisão, HTTP 403/406; o que se apoia só nelas
fica [secundária]):

- `lefisc-aj19`: https://www.lefisc.com.br/banco/2016/ajusteSINIEF19_16.htm — Ajuste SINIEF 19/2016 com alterações
  (o site do CONFAZ estava fora do ar).
- `inventti-cnpj`: https://inventti.com.br/?p=23078 — Ajuste SINIEF 30/2025 (NFC-e para CNPJ).
- `econet-cnpj`: https://blog.econeteditora.com.br/nfc-e-para-cnpj-volta-a-ser-permitida-o-que-muda-agora/ — Ajustes
  SINIEF 12/2026, 9/2026 e 13/2026.
- `inventti-csrt`: https://inventti.com.br/?p=21457 — post de divulgação da NT 2018.005 v1.40 (não diferencia os
  modelos 55 e 65; usar o PDF `nt2018005`).
- `tecnospeed-url`: https://blog.tecnospeed.com.br/urls-de-consulta-da-chave-da-nfc-e-lista-completa-e-atualizada/
- `coad-np`*: https://www.coad.com.br/home/noticias-detalhe/124406/programa-nota-parana-reforca-canais-de-fiscalizacao-sobre-documentos-fiscais-cancelados
- `granmoney`: https://granmoney.com/nfc-e/pr
- `consulta49`: https://www.legisweb.com.br/legislacao/?id=475213 — Consulta SEFA-PR 49/2022.
- `st-noticia`*: https://substituicaotributaria.com/SST/substituicao-tributaria/noticia/09/10/2026/parana-alterou-pauta-fiscal-de-cerveja
- `alterdata-938`: https://ajuda.alterdata.com.br/prosofterp/e1146-como-resolver-a-rejeicao-938-nao-informada-vbcstret-pst-vicmssubstituto-e-vicmsstret-149130837.html
- `legjur-8264`*: https://www.legjur.com/legislacao/htm/dec_00082642014 — Decreto 8.264/2014.
- `tecnospeed-rtc`: https://blog.tecnospeed.com.br/nota-tecnica-reforma-tributaria-nfe-nfce/
- `inventti-rtc`: https://inventti.com.br/nt-2025-002-v1-40-da-nf-e-nfc-e-amplia-controles-da-reforma-tributaria-com-novos-campos-grupos-e-validacoes-de-ibs-e-cbs/
- `tax360`: https://www.tax360.com.br/conteudo/nt-nfe-nfce-2025-002-rtc-v152
- `retributaria`*: https://retributaria.com/nt-2025-002-v1-52-nfe-ibs-cbs/
- `rt-2026`: https://www.reformatributaria.com/wp-content/uploads/2025/10/respostas-calculo-ICMS-2026.pdf
- `barbieri-lc214`: https://barbieriadvogados.com/lc-214/
- `contmatic-is`: https://simplifique.contmatic.com.br/blogs/imposto-seletivo-aliquotas-2027-medida-provisoria-setembro
- `crcsp-is`: https://online.crcsp.org.br/portal/noticias/noticia.asp?c=11012
- `crcsp-sat`: https://online.crcsp.org.br/portal/noticias/noticia.asp?c=10087
- `tecnospeed-sat`: https://blog.tecnospeed.com.br/sat-nfce/

[ricms]: https://www.sefanet.pr.gov.br/dados/SEFADOCUMENTOS/106201707871.pdf
[res145]: https://www.sefanet.pr.gov.br/dados/SEFADOCUMENTOS/101201500145.pdf
[npf100]: https://sped.fazenda.pr.gov.br/sites/sped/arquivos_restritos/files/migrados/File/NFCE/NPF_100_2014_NFCe_Consolidada_com_NPF036_2015.pdf
[pr-sped]: https://sped.fazenda.pr.gov.br/
[pr-cred]: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Credenciamento-de-emissores
[pr-csc]: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Codigo-de-Seguranca-do-Contribuinte-CSC
[pr-ws]: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Web-Services-NFC-e
[pr-qr]: https://sped.fazenda.pr.gov.br/NFCe/Pagina/QR-Code
[pr-cont]: https://sped.fazenda.pr.gov.br/NFCe/Pagina/Contingencia
[pr-cbenef]: https://sped.fazenda.pr.gov.br/NFe/Pagina/CODIGO-DE-BENEFICIO-FISCAL
[pr-consulta]: https://www.fazenda.pr.gov.br/servicos/Economia-e-Financas/Documentos-fiscais-eletronicos/Consultar-NFC-e-nota-fiscal-do-consumidor-eletronica-gzNEE1NO
[pr-st]: https://www.fazenda.pr.gov.br/Pagina/ICMS-Substituicao-tributaria
[pr-pauta]: https://www.parana.pr.gov.br/servicos/Economia-e-Financas/Tabela-de-precos-minimos/Consultar-pauta-fiscal-de-bebidas-0GNAKLr8
[nt2025001]: https://inventti.com.br/wp-content/uploads/2025/09/NT2025.001_v1.02-NFCe_qrCode_v3.pdf
[nt2018005]: https://inventti.com.br/wp-content/uploads/2024/09/NT2018-005_v1_40.pdf
[rj-manual]: https://portal.fazenda.rj.gov.br/dfe/wp-content/uploads/sites/17/2023/01/DF-e_NFC-e.pdf
[ro-nfce]: https://cdn.sefin.ro.gov.br/portalnfce/9ac05befca7d6499e3abec9bdfef2b68.pdf
[lefisc-aj19]: https://www.lefisc.com.br/banco/2016/ajusteSINIEF19_16.htm
[inventti-cnpj]: https://inventti.com.br/?p=23078
[econet-cnpj]: https://blog.econeteditora.com.br/nfc-e-para-cnpj-volta-a-ser-permitida-o-que-muda-agora/
[inventti-csrt]: https://inventti.com.br/?p=21457
[tecnospeed-url]: https://blog.tecnospeed.com.br/urls-de-consulta-da-chave-da-nfc-e-lista-completa-e-atualizada/
[coad-np]: https://www.coad.com.br/home/noticias-detalhe/124406/programa-nota-parana-reforca-canais-de-fiscalizacao-sobre-documentos-fiscais-cancelados
[granmoney]: https://granmoney.com/nfc-e/pr
[consulta49]: https://www.legisweb.com.br/legislacao/?id=475213
[st-noticia]: https://substituicaotributaria.com/SST/substituicao-tributaria/noticia/09/10/2026/parana-alterou-pauta-fiscal-de-cerveja
[alterdata-938]: https://ajuda.alterdata.com.br/prosofterp/e1146-como-resolver-a-rejeicao-938-nao-informada-vbcstret-pst-vicmssubstituto-e-vicmsstret-149130837.html
[legjur-8264]: https://www.legjur.com/legislacao/htm/dec_00082642014
[tecnospeed-rtc]: https://blog.tecnospeed.com.br/nota-tecnica-reforma-tributaria-nfe-nfce/
[inventti-rtc]: https://inventti.com.br/nt-2025-002-v1-40-da-nf-e-nfc-e-amplia-controles-da-reforma-tributaria-com-novos-campos-grupos-e-validacoes-de-ibs-e-cbs/
[tax360]: https://www.tax360.com.br/conteudo/nt-nfe-nfce-2025-002-rtc-v152
[retributaria]: https://retributaria.com/nt-2025-002-v1-52-nfe-ibs-cbs/
[rt-2026]: https://www.reformatributaria.com/wp-content/uploads/2025/10/respostas-calculo-ICMS-2026.pdf
[barbieri-lc214]: https://barbieriadvogados.com/lc-214/
[contmatic-is]: https://simplifique.contmatic.com.br/blogs/imposto-seletivo-aliquotas-2027-medida-provisoria-setembro
[crcsp-is]: https://online.crcsp.org.br/portal/noticias/noticia.asp?c=11012
[crcsp-sat]: https://online.crcsp.org.br/portal/noticias/noticia.asp?c=10087
[tecnospeed-sat]: https://blog.tecnospeed.com.br/sat-nfce/
