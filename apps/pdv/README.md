# GenesisPDV — frente de caixa (desktop)

PDV do GenesisPDV & ERP em **C# .NET 10 + Avalonia 12 + SQLite (EF Core)**, conforme a ADR-07. Roda no **Windows**,
o sistema dos caixas das lojas e o único distribuído e conferido na CI (decisão 80); o código também compila e os
testes rodam no Linux do ambiente de desenvolvimento. Funciona offline e grava tudo primeiro no banco local (ADR-08).

Este é o esqueleto da **Fase 0 – Fundação** (parte PDV do `docs/roadmap.md`): banco local com migrações e backup,
regras de venda no Core com testes, telas de ativação, login e venda operáveis só pelo teclado, hardware e emissor
"não fiscal" simulados, logs e tratamento global de erros. A ligação com a nuvem (ativação real, pull, push) entra na
Fase 1.

**Fase 1A (PDV)**: espelhos locais do catálogo (`produtos`, códigos de barras/embalagens, preços por loja e por
quantidade, grupos de preço por quantidade, combos com alternativas, restrições de horário, formas de pagamento,
unidades), a regra oficial de preço (PDV 11.3/11.3.1: varejo, loja, promocional, atacado, faixas, fardo e mix — vale o
menor), combo/kit com troca de componente e rateio para a NFC-e (10.9.1) e cobrança do casco retornável (10.12). A tela
de venda lê o catálogo local; em modo demonstração ele é carregado com produtos de exemplo.

## Estrutura

```
apps/pdv/
├── GenesisPDV.slnx               # solução (.NET 10, formato slnx)
├── Directory.Build.props         # net10.0, nullable, LangVersion latest, warnings como erro
├── Directory.Packages.props      # versões centralizadas dos pacotes NuGet
├── global.json                   # SDK 10 e "dotnet test" no Microsoft.Testing.Platform
├── dotnet-tools.json             # dotnet-ef (migrações)
├── nuget.config                  # só nuget.org (feeds da máquina não entram); cada projeto tem packages.lock.json
├── instalador/                   # implantação I3 (decisão 62; "Instalar na loja")
│   ├── windows/                  #   GenesisPDV.iss (Inno Setup 6), gerar-instalador.ps1 e testar-instalador.ps1 (CI);
│   │                             #   preparar-impressora-teste.ps1 (impressora RAW do teste do spooler, I4)
│   └── linux/                    #   gerar-pacote.sh/gerar-deb.sh (.deb), testar-deb.sh, postinst/postrm e o .desktop
│                                 #   (sem uso na CI nem no release desde a decisão 80; ficam como referência)
├── src/
│   ├── GenesisPDV.Core/          # domínio, sem UI nem banco: Venda, rateio, arredondamento, gramática do código;
│   │                             #   Precos/ (MotorPreco 11.3, RateioCombo 10.9.1), Produtos/ (ProdutoVenda, combo)
│   ├── GenesisPDV.Data/          # EF Core SQLite: PdvDbContext, conversores, migrações, repositórios, backup,
│   │                             #   espelhos dos 6 fluxos (Entidades/Tabelas*.cs) e CatalogoLocal;
│   │                             #   Esquema.g.cs gerado pela API (pnpm --filter api gerar:esquema-pdv)
│   ├── GenesisPDV.Sync/          # contratos do protocolo (formato da API), JCS, eventos do outbox, cliente HTTP;
│   │                             #   Ativacao/ (assistente real, id de hardware, X25519/ECIES, protetor de segredos)
│   │                             #   Token/ (guarda do token e rotação), Pull/ (aplicador do pull e carga inicial),
│   │                             #   Acesso/ (login offline pelo PIN, argon2id via libsodium), Push/ (lote de
│   │                             #   auditoria, envelope e envio do outbox), Ciclo/ (comandos), Relogio/ (desvio) e
│   │                             #   Cliente/ServicoSincronizacaoHttp (ciclo online: handshake, pull, push, heartbeat)
│   ├── GenesisPDV.Hardware/      # impressora ESC/POS (perfis Epson/Bematech/Genérica, adaptador, QR, transportes
│   │                             #   spooler RAW/TCP/serial/dispositivo, decisão 63), gaveta, leitor, balança e simuladores
│   ├── GenesisPDV.Fiscal/        # IEmissorDocumento / IEmissorFiscal + emissor "não fiscal", layout do cupom e
│   │                             #   validadores de CPF, CNPJ alfanumérico e chave de acesso
│   └── GenesisPDV.App/           # Avalonia 12, MVVM (CommunityToolkit.Mvvm), Serilog; Assets/ (ícone do exe,
│                                 #   da janela, do instalador e do .deb)
└── tests/
    ├── GenesisPDV.Core.Tests/    # regras de venda, rateio, preço, combo e casco (propriedades com 10.000 vendas/combos), parser
    ├── GenesisPDV.Data.Tests/    # PRAGMAs, backup antes da migração, inteiro escalado, outbox no mesmo commit,
    │                             #   modelo EF × Esquema.g.cs
    ├── GenesisPDV.Fiscal.Tests/  # validadores com a tabela de casos de packages/shared (validadores.casos.json)
    ├── GenesisPDV.Sync.Tests/    # contrato do sync com as fixtures de packages/shared/testes/sync, vetores JCS e
    │                             #   ECIES, ativação/rotação contra a ApiFalsa, protetores, payload da venda,
    │                             #   aplicador do pull, carga retomável, login offline (vetores argon2 da API) e o
    │                             #   ciclo online (push, comandos, handshake, desativação, relógio, indicador)
    ├── GenesisPDV.App.Tests/     # UI headless (venda, Montar combo, Cascos trazidos, desativação, revogado) + hardware
    └── GenesisPDV.E2E.Tests/     # e2e PDV ↔ API: o PDV headless contra a API local (só com GENESIS_E2E_API)
```

Dependências entre projetos: `App → Core, Data, Sync, Hardware, Fiscal`; `Data → Core`; `Sync → Core, Data`;
`Fiscal → Core, Hardware`. O Core não conhece UI nem banco (interfaces de repositório).

## Pré-requisitos

- **.NET SDK 10** (10.0.100 ou mais novo; o `global.json` aceita qualquer 10.0.x mais recente).
- Windows 10 22H2+/Windows 11 64 bits, ou Linux 64 bits (Ubuntu 22.04+/Debian 12).
- Linux com interface gráfica X11 (ou Wayland com XWayland). Em servidores sem tela use `xvfb-run` (abaixo).
  Pacotes usados pelo Avalonia no Debian/Ubuntu: `libx11-6 libice6 libsm6 libfontconfig1`.

## Compilar e testar

### Windows (PowerShell)

```powershell
cd apps\pdv
dotnet restore GenesisPDV.slnx
dotnet build GenesisPDV.slnx
dotnet test --solution GenesisPDV.slnx
```

### Linux (bash)

```bash
cd apps/pdv
dotnet restore GenesisPDV.slnx
dotnet build GenesisPDV.slnx
dotnet test --solution GenesisPDV.slnx
```

O `dotnet test` usa o **Microsoft.Testing.Platform** (configurado no `global.json`). Um projeto só:
`dotnet test --project tests/GenesisPDV.Core.Tests`. Os testes de UI são headless (não abrem janela) e rodam igual em
Windows e Linux; na CI, só no Windows (decisão 80).

**E2E PDV ↔ API** (Fase 1B e 1C; job `e2e-sync` do CI): da raiz do repositório, com o PostgreSQL local e o pnpm
instalado, `apps/api/test/e2e-pdv/rodar.sh` sobe a API do e2e (`apps/api/test/e2e-pdv/servidor.ts`: faixa de empresas
600000–699999, a loja de treino com quatro caixas — o quarto é o da recuperação do backup de 2 h, C17 —, operador e
gerente com PIN, um produto e o catálogo do caixa da 1C),
espera o estado ficar pronto e roda o `GenesisPDV.E2E.Tests` com `GENESIS_E2E_API`/`GENESIS_E2E_ESTADO`; no fim a API
apaga os bancos que criou. Sem essas variáveis, os roteiros são pulados (no `dotnet test` da solução); o `rodar.sh` os
exige (`GENESIS_E2E_EXIGIR=1`, `--fail-skips on`, `--minimum-expected-tests 5`), então ali nenhum é pulado em silêncio.
`GENESIS_E2E_RELATORIOS=<pasta>` grava o resultado do PDV 30.7 (`pdv-30-7.json`) e `GENESIS_E2E_30_7_MINUTOS=240`
espalha as 200 vendas pelas 4 h do critério (o workflow manual "Aceite PDV", decisão 57). Se
o servidor falhar no meio do preparo, ele mesmo apaga o que criou; restos de execuções mortas (`kill -9`) saem com
`pnpm --filter api test:limpar`.

**Ensaio do piloto com a carga real** (implantação I5; local, fora do CI; decisão 64): da raiz,
`GENESIS_PLANILHA_REAL=/caminho/Produtos.xlsx apps/api/test/e2e-pdv/ensaio-piloto.sh` importa a planilha do Nuvem3
pelo importador de verdade (`apps/api/test/e2e-pdv/ensaio-piloto.ts`) e roda só o `EnsaioPilotoTests` (`--explicit
only`): ativação e carga inicial, busca no catálogo real, vendas sorteadas em dinheiro, PIX, débito e crédito, sangria,
fechamento cego e a conferência no ERP e na Prontidão da loja. `GENESIS_ENSAIO_RELATORIO` (arquivo) recebe os tempos e
as contagens, sem nome de produto nem código; `GENESIS_ENSAIO_VENDAS` muda as 30 vendas. Sem a planilha, sai com 0
dizendo que pulou. A planilha nunca entra no repositório.

Capturas de tela dos testes de UI (PNG renderizado pelo Skia, sem janela):

```bash
GENESISPDV_CAPTURAS=/tmp/telas dotnet test --project tests/GenesisPDV.App.Tests
```

## Executar

```bash
# Linux
dotnet run --project src/GenesisPDV.App
# Linux sem tela (servidor)
xvfb-run -a dotnet run --project src/GenesisPDV.App
```

```powershell
# Windows
dotnet run --project src\GenesisPDV.App
```

Pastas (PDV 5.1):

| Item | Windows | Linux |
|---|---|---|
| Banco local | `%ProgramData%\GenesisPDV\dados\pdv.db` | `/var/lib/genesispdv/pdv.db` |
| Backups | `%ProgramData%\GenesisPDV\backup\` | `/var/lib/genesispdv/backup/` |
| Logs (Serilog, diário, 30 arquivos de até 20 MB; decisão 67) | `%ProgramData%\GenesisPDV\logs\` | `/var/log/genesispdv/` |
| Impressora simulada (`.bin` ESC/POS + `.txt`) | `%ProgramData%\GenesisPDV\impressao\` | `/var/lib/genesispdv/impressao/` |

No Linux, se `/var/lib/genesispdv` não for gravável pelo usuário (rodando sem o pacote instalado, ou fora do grupo
`genesispdv` que o `.deb` cria, decisão 62), o PDV usa `~/.local/share/genesispdv/`. Para desenvolvimento e testes, a variável **`GENESISPDV_DADOS=/alguma/pasta`** coloca
tudo (dados, backup, logs, impressão) sob essa pasta.

### Roteiro rápido (modo demonstração)

1. Primeira execução: abre o **Assistente de ativação** (boas-vindas com os requisitos → conexão → código →
   confirmação). A ativação real fala com a API (`POST /sync/ativar`): para usar a API local, defina
   `GENESISPDV_API=http://localhost:3000` (http só para localhost) e gere o código no ERP (Cadastros › PDVs /
   Terminais). Depois da carga inicial e do login pelo PIN, o ciclo online roda em segundo plano (pull a cada 30 s,
   heartbeat, comandos e o push da auditoria); desde a 1C (C11a) o terminal ativado vende de verdade (fim da D18, decisão 54).
2. **F8** ativa um terminal de demonstração (Loja 1, Caixa 02) sem nuvem — só nos builds de desenvolvimento: no
   executável publicado (o do instalador) a tecla e o botão não existem (decisão 62).
3. Login: usuário **1** (MARIA, limite de desconto 10%) senha **1234**, ou **2** (CARLOS, gerente/Master) senha
   **4321**. Esses operadores só existem nos builds de desenvolvimento (`dotnet build/run/test`); veja "Publicar".
4. Tela de venda — o campo de código está sempre com foco:

| Código | Produto | Preço |
|---|---|---|
| `7891149103102` (`0123`) | CERV BRAHMA LT 350ML | 3,49; atacado 12+ a 3,19; membro do MIX LATAS 350ML |
| `17891149103109` | Fardo com 12 BRAHMA (fator 12, preço do fardo 37,90) | baixa 12 UN e ativa o "12+" |
| `7891991010856` (`0125`) | CERV SKOL LT 350ML | 2,99; atacado 12+ a 2,79; MIX LATAS 350ML |
| `7891991000826` (`0126`) | CERV ANTARCTICA LT 350ML | 3,29; atacado 12+ a 2,99; MIX LATAS 350ML |
| `7896045506873` | ÁGUA CRYSTAL 500ML | 2,50; faixas 6–11 a 2,29 (geral) e 12+ a 1,99 (só nesta loja) |
| `7894900027013` | REFRI COCA-COLA 2L | 9,99 |
| `7896045504831` | CERV HEINEKEN LN 330ML | 6,99 geral; 6,49 nesta loja (`produtos_lojas`) |
| `0044` ou `44` | GELO ESCAMA 5KG | 12,90 |
| `0050` | QUEIJO COALHO KG (fracionável) | 19,99/kg |
| `0077` | CARVÃO VEGETAL 3KG | 18,90 |
| `0500` ou `7890000005003` | COMBO DE WHISKY 1L (abre Montar combo) | 129,90; Monster +2,00 |
| `0510` | KIT CHURRASCO (combo sem alternativas) | 49,90 |
| `0600` ou `7891991015301` | CERV ORIGINAL 600ML RET (pergunta os cascos) | 9,90 + casco 2,50 se não trouxer |
| `17891991015308` | Engradado 24 ORIGINAL 600ML RET | 24 × 9,90, 24 cascos devidos |
| `0999` | produto inativo (para ver a recusa) | — |

   O MIX LATAS 350ML está no modo `produto`: 6 Brahma + 6 Skol somam 12 e cada uma cai para o próprio atacado. O
   terminal de demonstração liga "Usa Produto Preço Volume" (faixas por quantidade).

   Combo: `0500` ⏎ abre **Montar combo** (↑/↓ ou 1–9 escolhe, ⏎ confirma a posição — ⏎ ⏎ aceita os padrões, Esc
   volta). Retornável: `0600` ⏎ pergunta **Cascos trazidos** (⏎ aceita todos; 0 cobra o casco). `12*7891149103102` ⏎
   mostra "ATAC 12+" e a economia; `6*7891149103102` + `6*0125` ativam o mix.
   Exemplos: `3*0044` ⏎ (três gelos), `0,795*0050` ⏎ (queijo pesado), `2*` ⏎ e depois o código (multiplicador
   pendente), `+`/`-` ⏎ no último item, texto (`cerv`) ⏎ abre a pesquisa.
5. Atalhos: **F1** ajuda · **F2** pesquisar · **F3** quantidade · **F4** remover item · **Shift+F4** cancelar venda
   (a MARIA pede a liberação do CARLOS; motivo livre de 15 a 255) · **F6** desconto (1 item, 2 total, 4 remover o do total, 5 remover o do item) · **F10** pagamento · **↑/↓** seleciona item ·
   **Ctrl+Alt+T** tema claro/escuro · **F11** funções: **1** sangria (F2 quem retira, F3 cédulas, F12 movimentos com
   Ctrl+Del cancelando, liberado pelo CARLOS), **2** reforço, **3** fechamento, **4** reimprimir e **5** cancelar a
   última venda, **6** resumo diário, **S** status do sync, **V** devolução de cascos (com a venda em andamento,
   desconta os vazios a mais pelo valor do casco; F3 passa a só a entrada). **F12** gestão de vendas da
   sessão (Enter detalhes, **Ctrl+R** reimprime com a marca da 2ª via, **Ctrl+Del** cancela a venda paga: F2/F3
   escolhem a devolução de cada pagamento, o CARLOS libera). **F5** CPF na nota ou cliente (Ctrl+Del tira). F7, F8,
   F9, Ctrl+N e Ctrl+T mostram "próximas fases". Todas essas teclas também são **botões** na barra de baixo (o
   mesmo comando, decisão 65), e o **duplo clique** num item abre a janela do item (quantidade, desconto, remover).
6. Pagamento (F10): as formas da loja (espelho `formas_pagamento`; a demonstração só tem Dinheiro — débito, crédito e
   PIX vêm do ERP › Formas de pagamento), **↑/↓** ou **Alt+1..9** escolhem; o valor vem preenchido com o saldo, o troco
   aparece enquanto se digita (só no dinheiro) e, quitado o total, a venda finaliza: grava venda + evento
   `venda.finalizada` no outbox num único commit, emite o comprovante não fiscal, imprime na impressora simulada (o
   cupom aparece no painel direito e em arquivo), abre a gaveta simulada (só ligada na configuração do terminal e com
   forma "Abrir gaveta", decisão 63) e mostra
   **TROCO R$ x** até a próxima leitura. Cartão abre "Passe na maquininha" (bandeira obrigatória); PIX mostra o QR da
   chave da loja e pede o nome de quem pagou, o horário do banco e o supervisor. O contador `⇅ N` mostra os eventos
   pendentes.
7. Feche o aplicativo no meio de uma venda (ou mate o processo): ao entrar de novo, a venda volta com a faixa
   "Venda recuperada após interrupção". Alt+F4 com venda em andamento é bloqueado.

## Publicar o executável do Windows (self-contained, arquivo único)

Funciona tanto no Windows quanto cruzado a partir do Linux:

```bash
cd apps/pdv
dotnet publish src/GenesisPDV.App/GenesisPDV.App.csproj -c Release -r win-x64 --self-contained \
  -p:PublishSingleFile=true -p:GenesisUrlApiPadrao=https://api.grupoicebeer.com.br -o publish/win-x64
```

Resultado: `publish/win-x64/GenesisPDV.exe` (não precisa de .NET instalado; as bibliotecas nativas do SQLite, Skia e
HarfBuzz vão dentro do exe e são extraídas na primeira execução). Para Linux: troque por `-r linux-x64`
(`publish/linux-x64/GenesisPDV`). Para a loja, use o **instalador** (`GenesisPDV-Setup-x.y.z.exe`), que publica e
confere o executável sozinho: veja "Instalar na loja" e as decisões 62 e 80.

**Demonstração fica fora de todo `dotnet publish`**: a propriedade MSBuild `ModoDemonstracao` (símbolo
`MODO_DEMONSTRACAO`) vale `true` em build/run/test e `false` ao publicar, então o executável entregue a uma loja não
aceita `maria/1234` nem `carlos/4321`, a tela de login não mostra a dica e o assistente não tem o **F8** (terminal de
demonstração) nem o botão dele. Para gerar um executável de demonstração, peça explicitamente:
`dotnet publish ... -p:ModoDemonstracao=true`.

**O que o build grava no executável** (decisão 62): a versão (`<Version>` do `Directory.Build.props`, ou
`-p:Version=X.Y.Z`), a URL padrão da API do assistente (`-p:GenesisUrlApiPadrao=https://...`, padrão
`https://api.genesispdv.com.br`; os instaladores do piloto saem com `https://api.grupoicebeer.com.br`) e o modo de
demonstração. `GenesisPDV --info-build arquivo.json` grava os três e sai, sem abrir tela nem banco (é assim que o CI
confere o executável publicado).

## Instalar na loja

O caixa da loja usa o **instalador do Windows** (`GenesisPDV-Setup-x.y.z.exe`): as lojas são todas Windows (D21). Ele
sai do CI e do workflow **PDV release** (decisão 62). Desde 05/11/2026 não há pacote para Linux (decisão 80).

**Na loja, baixe sempre pela página de download: <https://download.grupoicebeer.com.br>.** É o endereço que a loja
conhece (sem procurar o arquivo certo no GitHub); a página oferece o instalador do release `pdv-vX.Y.Z` mais novo
publicado, com a versão, o tamanho, o sha256 e estas instruções resumidas. Ela só passa a oferecer uma versão nova **depois da
próxima implantação**: publique com **Actions › PDV release** e depois rode **Actions › Implantação**
(infra/producao/README.md › Página de download do PDV).

**Requisitos mínimos** (PDV 32.7): Windows 10 64 bits 22H2 ou Windows 11 (o instalador recusa versões mais antigas e
32 bits), 2 núcleos, 4 GB de memória, SSD com 20 GB livres, tela 1024×768, internet só para ativar (depois o caixa
funciona offline). Recomendado: 8 GB, SSD, cabo de rede e **nobreak**.

### Windows, passo a passo

1. **Baixe o instalador** no próprio PC do caixa: abra <https://download.grupoicebeer.com.br> e clique em **Baixar o
   instalador** (`GenesisPDV-Setup-X.Y.Z.exe`; a página mostra a versão, o tamanho e o sha256). Enquanto o
   instalador não for assinado, o navegador pode segurar o download: no Edge, "GenesisPDV-Setup-X.Y.Z.exe não é
   baixado com frequência", e o arquivo só vai para Downloads depois de **"..." › Manter › Mostrar mais › Manter
   assim mesmo** (no Chrome, **Manter** ou **Baixar mesmo assim**). Se a página disser que o instalador ainda não foi
   publicado, falta o release ou a implantação seguinte (acima). Com acesso ao
   repositório, também dá para baixar do GitHub, em *Releases* › `pdv-vX.Y.Z` (o `.exe` e o `.exe.sha256`). Para
   testar uma versão ainda sem release: em *Actions › CI*, na execução verde, o artefato `GenesisPDV-Setup`, guardado
   por 14 dias.
2. **Confira o arquivo** (garante que veio inteiro e é o publicado): a página mostra o comando pronto para o
   PowerShell, que responde `True` quando confere. À mão, na pasta do download:
   `Get-FileHash .\GenesisPDV-Setup-X.Y.Z.exe -Algorithm SHA256` — o número tem de ser igual ao sha256 da página (ou
   ao do `.sha256`, aberto no Bloco de Notas; maiúsculas e minúsculas não importam).
3. **Instale** com dois cliques no arquivo e **Sim** no aviso do Windows (pede administrador: na conta comum do caixa,
   o Windows pede o usuário e a senha de um administrador do computador). Enquanto o instalador
   não for assinado, o Windows pode mostrar "O Windows protegeu o computador" (SmartScreen): clique em
   **Mais informações › Executar assim mesmo**. As opções "Criar o atalho na área de trabalho" e "Abrir o GenesisPDV
   ao entrar no Windows" já vêm marcadas; deixe-as assim. No fim, "Abrir o GenesisPDV agora" abre o caixa.
   - **"O Controle Inteligente de Aplicativos bloqueou um aplicativo que pode não ser seguro"** (Windows 11, comum em PC
     novo instalado do zero): esse bloqueio não tem "Executar assim mesmo" e vale para o instalador e para o
     `GenesisPDV.exe` instalado enquanto eles não forem assinados. A saída é desligar o recurso em **Segurança do
     Windows › Controle de aplicativos e navegador › Configurações do Controle Inteligente de Aplicativos ›
     Desativado** e instalar de novo. Atenção: em algumas versões do Windows 11 ele não volta a ser ligado sem
     reinstalar o sistema (versões mais novas já deixam religar). Com o instalador assinado (o certificado da decisão
     62) o bloqueio não acontece; enquanto não houver certificado, prefira para o caixa um PC em que o recurso esteja
     em "Avaliação" ou "Desativado".
4. **Use sempre a mesma conta do Windows no caixa.** A ativação fica protegida pela conta do Windows que ativou o PDV
   (DPAPI, D21), mas o banco é do computador e o PDV abre sozinho para **qualquer** conta que entrar no Windows. Em
   outra conta (a do técnico, a do administrador), ele mostra **"Caixa ativado com outra conta"**, com o nome da conta
   certa (ex.: `LOJA-PC\Caixa`): saia (Alt+F4), entre com ela e abra de novo, nada se perde. Ele **não** reativa por
   cima: se a conta que ativou não existe mais, chame o suporte (as vendas ainda não enviadas só sobem por ela, e a
   reativação começa com um banco local novo). O instalador abre o PDV com a conta de quem o executou, não com a do
   administrador que digitou a senha: **ative entrando com a conta do caixa** (a conta comum da loja).
5. **Ative.** Na primeira abertura aparece o **Assistente de ativação**, com o endereço do servidor já preenchido
   (`https://api.grupoicebeer.com.br`; só mude se o suporte pedir). No ERP, em **Cadastros › PDVs / Terminais ›
   Gerar código de ativação**, escolha a loja e o caixa e anote o código da empresa e o código de ativação; digite os
   dois no caixa, confira loja e caixa e deixe a carga inicial terminar. Depois, cada operador entra com o próprio
   usuário e PIN.

**Atualizar:** baixe o instalador da versão nova, **feche o PDV pelo próprio programa** (termine a venda em andamento
e saia com Alt+F4: a saída faz o backup do caixa) e instale por cima. Banco, backups e ativação continuam, e o caixa
abre já ativado. Se o PDV estiver aberto, o instalador avisa e espera ele ser fechado (nunca fecha o caixa sozinho).
Quando a nuvem passa a exigir uma versão mais nova, o login mostra em âmbar qual instalar
(`GenesisPDV-Setup-X.Y.Z.exe`); o caixa continua vendendo até lá. **Nunca instale uma versão mais antiga por cima**
(o Setup velho que ficou em Downloads): o instalador avisa e, em silêncio, desiste; e o PDV antigo não abre um banco que
a versão nova já atualizou ("Este caixa já usa uma versão mais nova do GenesisPDV"), sem mexer em nada — basta
instalar de novo a versão nova.

**Desinstalar:** *Configurações › Aplicativos › GenesisPDV › Desinstalar*. O programa sai, mas **os dados do caixa
ficam** em `C:\ProgramData\GenesisPDV` (o desinstalador diz onde): reinstalando, o PDV continua de onde parou. Para
apagar de vez, confira antes no ERP (PDVs / Terminais) que o caixa não tem nada pendente e apague a pasta à mão.

**Onde fica cada coisa no Windows:**

| Item | Pasta |
|---|---|
| Programa | `C:\Program Files\GenesisPDV\GenesisPDV.exe` |
| Banco do caixa | `C:\ProgramData\GenesisPDV\dados\pdv.db` |
| Backups (a cada 2 h, no fechamento e na saída) | `C:\ProgramData\GenesisPDV\backup\` |
| Logs (30 arquivos, cerca de 30 dias) | `C:\ProgramData\GenesisPDV\logs\` |
| Impressão simulada | `C:\ProgramData\GenesisPDV\impressao\` |

O instalador dá ao grupo **Usuários** permissão de modificar `C:\ProgramData\GenesisPDV` (o caixa roda com a conta
comum da loja). Só um GenesisPDV abre por computador: o segundo avisa "já está aberto".

### Linux (.deb) — sem distribuição desde a decisão 80

O Linux deixou de ser plataforma de distribuição: nem o CI nem o **PDV release** geram ou testam o `.deb`, e a página
de download só oferece o instalador do Windows. Os scripts de `instalador/linux` ficam no repositório, sem uso na CI
e sem garantia de que continuem funcionando; o texto abaixo vale só para quem gerar o pacote à mão
(`instalador/linux/gerar-pacote.sh`).

```bash
sha256sum -c genesispdv_X.Y.Z_amd64.deb.sha256
sudo apt install ./genesispdv_X.Y.Z_amd64.deb
sudo usermod -aG genesispdv <a conta que opera o caixa>   # e saia e entre de novo na sessão
```

O pacote instala `/opt/genesispdv/GenesisPDV`, o comando `genesispdv` e o atalho "GenesisPDV" no menu, e cria o grupo
`genesispdv` com `/var/lib/genesispdv` (banco e backups) e `/var/log/genesispdv` (`root:genesispdv`, `2770`). Quem não
está no grupo usa `~/.local/share/genesispdv`. `sudo apt remove genesispdv` (ou `purge`) tira o programa e mantém os
dados.

**Use sempre a mesma conta do Linux no caixa**, como no Windows: a chave que protege a ativação fica por conta
(`~/.config/genesispdv`). Outra conta do grupo abre o PDV (o banco, os backups e o log saem com escrita para o grupo:
`umask 007` no PDV e `g+rw` no `pdv.db`), mas cai na tela "Caixa ativado com outra conta", que diz com qual entrar.

### Gerar o instalador e publicar uma versão (desenvolvimento)

- **Versão única:** a `<Version>` do `apps/pdv/Directory.Build.props` (hoje `0.10.0`: a `0.9.0` abriu o piloto, decisão 62; a `0.9.1` trouxe a usabilidade da decisão 65; a `0.10.0` traz a Central do PDV, decisões 66 a 79). A mesma aparece no
  nome do instalador, no rodapé do login e do assistente e no `versao_app` que vai à nuvem.
- **Windows** (SDK do .NET 10; o Inno Setup 6 vem pelo Chocolatey se faltar):
  `pwsh apps/pdv/instalador/windows/gerar-instalador.ps1 [-Versao X.Y.Z] [-UrlApi https://...]` →
  `apps/pdv/publish/instalador/GenesisPDV-Setup-X.Y.Z.exe` e o `.sha256`. O `testar-instalador.ps1` é o teste de
  fumaça do CI (instala, abre, reinstala e desinstala; mexe na máquina: rode só numa VM ou no runner).
- **Linux (sem distribuição, decisão 80):** `apps/pdv/instalador/linux/gerar-pacote.sh [X.Y.Z] [URL]` →
  `apps/pdv/publish/deb/`; o `testar-deb.sh` instala de verdade (sudo). Fora do CI e do release.
- **Release:** `git tag pdv-vX.Y.Z && git push origin pdv-vX.Y.Z` num commit **da main** (ou *Actions › PDV release ›
  Run workflow* **na main**, com "publicar" marcado, que cria a tag) gera, testa e publica o Release com o `.exe` e o
  `.exe.sha256` (só Windows, decisão 80). A URL padrão vem da variável do repositório `PDV_URL_API_PADRAO` (sem ela, a do piloto). O
  workflow recusa publicar commit fora da main, uma tag que já existe em outro commit (suba a versão: os binários de
  uma tag nunca mudam) e um release que já tem arquivos; para refazer o mesmo commit (ex.: upload interrompido), rode
  à mão escolhendo a própria tag em *Use workflow from*, com "publicar" e "substituir" marcados.
- **Assinatura (opcional):** com os segredos `PDV_CERT_PFX_BASE64` (o `.pfx` em base64) e `PDV_CERT_SENHA`, o
  executável, o instalador e o desinstalador saem assinados (Authenticode com carimbo de tempo); o `.pfx` nunca entra no
  repositório. Configure assim, senão qualquer pessoa com escrita no repositório consegue ler o certificado de um
  branch próprio:
  1. *Settings › Environments › New environment* `release-pdv`; em *Deployment branches and tags*, só `main` e o
     padrão de tag `pdv-v*`; recomendado: *Required reviewers* com o dono (cada release espera a aprovação dele).
  2. Os dois segredos como **segredos do ambiente** `release-pdv` (nunca do repositório).
  3. *Settings › Rules › Rulesets › New tag ruleset* para `pdv-v*`: criar, mover e apagar restritos, com só o dono na
     lista de exceção; senão qualquer um com escrita cria a tag que libera o ambiente. Com o ruleset, o release sai da
     tag que o dono cria (o "Run workflow" com "publicar" cria a tag pelo token do workflow, que o ruleset pode
     recusar).

## Configurar a impressora (e a gaveta)

Passo a passo para o dono (implantação I4, decisão 63). As lojas do piloto terão **Epson** (TM-T20 II/III/X ou
TM-T88 V/VI) ou **Bematech MP-4200 TH**; sem impressora configurada o caixa **vende normalmente** e a barra mostra
"🖶 Sem impressora" (o cupom fica guardado para a reimpressão).

1. **Instale o driver do fabricante** no computador do caixa, com a impressora ligada no USB: Epson "Advanced Printer
   Driver" (APD) da TM-T20/TM-T88, ou o "Bematech MP-4200 TH Driver" (USB/spooler). Imprima a página de teste do
   Windows para conferir que ela aparece em *Configurações › Impressoras*. **Bematech:** deixe a MP-4200 TH no **modo
   ESC/POS** (utilitário da Bematech, "Modo de comandos: ESC/POS"); no modo ESC/Bema os acentos e o corte saem errados.
2. **Abra a Central do PDV, aba 3 Impressora e gaveta:** no login, **Ctrl+Alt+C** (ou o botão **⚙ Central do PDV**),
   o usuário e o PIN, e a tecla **3** (ou o clique em "3 Impressora e gaveta"); com o caixa aberto, **F11 › 8** (ou o
   **⚙** no fim da barra) e o **3**. Quem não tem a permissão de configurar o terminal vê o cadeado: a aba pede o
   usuário e o PIN do gerente/Master. Esc volta ao menu e, de lá, ao login ou à venda (decisão 68).
3. **Escolha** o modelo, a conexão **"Impressora instalada no Windows"** e a impressora na lista (o nome do driver),
   o papel (**80 mm**, o comum; 58 mm = bobina estreita), a guilhotina (corte parcial) e deixe "A do modelo" na página
   de código e no QR. Abaixo do papel a tela mostra as colunas do modelo: **48** no 80 mm e **32** no 58 mm na TM-T20,
   na MP-4200 TH e na Genérica; **42** e **30** na **TM-T88** (a cabeça dela tem menos pontos) — escolha o modelo certo,
   senão a linha passa da largura. Impressora de rede: "Rede", o IP e a porta 9100. Na serial (ou na COM virtual que o driver USB
   cria): a porta (`COM3`) e a velocidade da impressora (9600/115200, a da etiqueta de autoteste).
4. **F5 Imprimir teste:** sai o nome da loja, o modelo, os acentos `ÁÉÍÓÚ ÇÃÕ âêô`, uma régua com as colunas do modelo
   (48/32; 42/30 na TM-T88), um QR de exemplo e o corte. Confira: a régua cabe numa linha só e os acentos saíram certos.
   - **Acento trocado por outro sinal** (ex.: `Ã` virou `Ò`): troque a página de código (CP860 ↔ CP850) e imprima de
     novo; na Epson há ainda a WPC1252. Na Bematech, confira o modo ESC/POS (passo 1).
   - **Régua quebrada em duas linhas:** confira primeiro o **modelo** (a TM-T88 escolhida como TM-T20 sai com 48 colunas
     onde só cabem 42); com o modelo certo, o papel é o de 58 mm — escolha "58 mm".
   - **Régua curta (sobra papel à direita):** o contrário — papel de 80 mm marcado como 58 mm, ou a TM-T20 marcada como
     TM-T88.
   - **QR não saiu ou saiu riscado:** escolha "Imagem" no QR Code.
   - **Nada saiu:** a mensagem diz o motivo (impressora não encontrada no Windows, sem papel, offline, "Usar impressora
     offline" marcado, rede sem resposta, porta ocupada, nenhuma resposta no tempo limite).
5. **F2 Salvar.** A mudança fica na auditoria (quem, quando, antes e depois).
6. **Gaveta:** só se a gaveta estiver ligada na impressora (cabo RJ-11). Marque "Gaveta ligada", o pino (2 é o comum; 5
   em algumas gavetas) e **F6 Abrir gaveta (teste)** (o pulso é de verdade: cada F6 fica na auditoria `gaveta_aberta`
   com quem está na tela e quem liberou). Ligada, ela abre na venda com forma "Abrir gaveta" (o dinheiro) e
   pelo **F11 › 9** (com a liberação do gerente e o motivo); "Abrir também na abertura, sangria…" é opcional. As lojas da
   Ice Beer **não** têm gaveta na impressora: deixe desmarcado (padrão), e nenhum comando de gaveta é enviado.
7. **Se a impressora falhar** no meio do dia (papel, cabo, desligada): a venda segue, o operador vê "Cupom não impresso
   — ficou na fila" e pode reimprimir pelo **F12 › Ctrl+R**; resolvido o problema, **F7 Imprimir pendentes** na
   configuração manda o que ficou (ou **F8 Descartar pendentes**, se não interessa mais). A cobrança PIX do F4 que não
   saiu **não** fica pendente (o QR só serve na frente do cliente).
   - **Pela impressora do Windows** (a conexão padrão), o Windows guarda o documento na fila dele e imprimiria sozinho
     quando a impressora voltasse. O PDV evita isso: pergunta ao Windows se a impressora está pronta antes de mandar (sem
     papel, tampa aberta, desligada/offline, "Usar impressora offline", pausada → falha na hora) e acompanha o documento
     até ele sair; com erro ou parado mais de 10 s, **tira o documento da fila do Windows** e marca a falha na fila do PDV.
     Limite: um driver que não informa a situação (sem "comunicação bidirecional") e aceita o documento num buffer próprio
     ainda parece impresso — no driver da Epson/Bematech, deixe a comunicação bidirecional ligada (padrão).
   - **Sobrou documento na fila do Windows** (uma versão antiga do PDV, outro programa, a impressora pausada à mão):
     *Configurações › Impressoras › a impressora › Abrir fila › Impressora › Cancelar todos os documentos* antes de
     religar, senão eles saem todos juntos.

## Banco local e migrações

- `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` em **toda** conexão
  (interceptor `PragmasSqlite`); `PRAGMA integrity_check` na inicialização (falhou → tela de erro, nada é apagado).
- Na inicialização: se o `pdv.db` já existe e há migração pendente, é feito um **backup pela API de backup online do
  SQLite** em `backup/pdv-<data>-antes-migracao.db` e só então as migrações são aplicadas.
- Banco com migração aplicada que este executável não conhece (versão mais antiga instalada por cima da nova): **não
  abre** (`BancoDeVersaoMaisNovaException`, tela "Este caixa já usa uma versão mais nova do GenesisPDV"), antes de
  apagar o `encerramento.json` e de migrar; nada é gravado (decisão 62).
- Decimais em `INTEGER` escalado (MD 4.1): toda propriedade `decimal` mapeada precisa de `[Escala(n)]`; o conversor
  `EscalaDecimal` lança exceção se o valor tiver mais casas que a coluna. UUID v7 (`Guid.CreateVersion7()`) em TEXT
  minúsculo de 36 caracteres; datas em TEXT `AAAA-MM-DDTHH:MM:SS.fffZ` (24 caracteres). Colunas em snake_case
  derivadas das propriedades.
- **Espelhos do catálogo** (MD 4.2, fluxo `catalogo`/`configuracao`): `produtos`, `produtos_codigos_barras`,
  `produtos_lojas`, `produtos_precos_quantidade`, `grupos_preco_quantidade` (+ `_faixas`), `produtos_componentes`
  (+ `_alternativas`), `restricoes_horario_venda`, `formas_pagamento`, `unidades_medida` e `configuracoes`, com a projeção do MD 6.2
  (sem custo, markup etc.), `versao`/`criado_localmente` com `DEFAULT 0`, sem FKs entre espelhos e com os índices das
  buscas do caixa. `RepositorioEspelhos.GravarAsync` faz o upsert por `id` só com versão maior (base do pull).
- **`Esquema.g.cs`** (MD 4.1) é gerado pela API a partir do schema Drizzle: `pnpm --filter api gerar:esquema-pdv`
  (o CI roda `verificar:esquema-pdv` e falha se o arquivo versionado estiver diferente). Ele descreve as tabelas lidas
  pelos fluxos do pull e as de movimento que já existirem no Drizzle (nome, tipo, escala do `numeric(p,s)`, nulidade,
  CHECKs); o teste `EsquemaNuvemTests` compara o modelo EF com ele em toda tabela presente nos dois lados.
- Nova migração:

  ```bash
  cd apps/pdv && dotnet tool restore
  cd src/GenesisPDV.Data && dotnet tool run dotnet-ef migrations add NomeDaMigracao --output-dir Migracoes
  ```

## Pacotes e versões

| Pacote | Versão | Observação |
|---|---|---|
| .NET SDK / runtime | 10.0 (testado com SDK 10.0.403) | LTS |
| Avalonia, Avalonia.Desktop, .Themes.Fluent, .Fonts.Inter, .Skia, .Headless, .Headless.XUnit | 12.1.4 | |
| CommunityToolkit.Mvvm | 8.4.2 | propriedades parciais `[ObservableProperty]` |
| Microsoft.EntityFrameworkCore.Sqlite / .Design, dotnet-ef | 10.0.14 | a 11.0 ainda é RC |
| Microsoft.Extensions.DependencyInjection / Logging / Http | 10.0.14 | |
| Serilog / Serilog.Sinks.File / Serilog.Extensions.Logging | 4.4.0 / 7.0.0 / 10.0.0 | |
| BouncyCastle.Cryptography | 2.7.0 | X25519 (chave do terminal e ECIES da API): o .NET não tem X25519 no Linux |
| System.Security.Cryptography.ProtectedData | 10.0.14 | DPAPI do token no Windows (D21) |
| Sodium.Core (libsodium 1.0.22) | 1.4.1 | argon2id do login offline (`crypto_pwhash_str_verify`, SYNC 4.2); nativo de win-x64 e linux-x64 no pacote |
| QRCoder | 1.6.0 | QR do PIX estático na tela de pagamento (PDV 16.7; C11a): só o PNG da matriz (`PngByteQRCode`), sem System.Drawing; no Hardware, a matriz do QR em imagem `GS v 0` (I4) |
| System.IO.Ports | 10.0.14 | impressora na serial/COM virtual do USB (I4, decisão 63); traz o `runtime.native.System.IO.Ports` de cada RID no lock |
| xunit.v3 | **3.2.2** (fixado) | ver abaixo |

- **xunit.v3 fixado em 3.2.2** (a mais nova é 4.0.2): o `Avalonia.Headless.XUnit` 12.1.4 é compilado contra
  `xunit.v3.extensibility.core` 3.2.2 e, com o xunit.v3 4.x, todos os testes `[AvaloniaFact]` falham na descoberta
  com `MissingMethodException` (`TestIntrospectionHelper.GetTestCaseDetails`). Voltar ao 4.x quando o Avalonia
  publicar o adaptador compatível.
- O `SQLitePCLRaw` vem transitivo do EF Core (2.1.x); não foi forçado para a 3.x.
- **Restore travado**: `RestorePackagesWithLockFile` gera um `packages.lock.json` por projeto (versionados) e o CI usa
  `dotnet restore --locked-mode` com cache do NuGet pela chave desses arquivos. Ao trocar uma versão em
  `Directory.Packages.props`, rode `dotnet restore GenesisPDV.slnx --force-evaluate` e versione os lock files. O
  `GenesisPDV.App` declara `RuntimeIdentifiers` `win-x64;linux-x64`, mas o `dotnet publish -r win-x64` ainda edita os
  lock files (acrescenta `Microsoft.NET.ILLink.Tasks` e seções `net10.0/win-x64`): **não versione essas mudanças**;
  depois de publicar, rode `git checkout -- '**/packages.lock.json'`.

## Decisões de implementação

Precedência usada nas divergências entre documentos: ADR > MD (modelo de dados) > SYNC > ERP/PDV.

1. **Pastas `src/` e `tests/`**: o MD 4.1 já cita `apps/pdv/src/GenesisPDV.Data/Esquema.g.cs`.
2. **`IEmissorDocumento` × `IEmissorFiscal`**: a ADR-11 fala em `IEmissorFiscal`; o emissor "não fiscal" não é fiscal.
   Ficou `IEmissorDocumento` (base, usada pela venda) e `IEmissorFiscal : IEmissorDocumento` (acrescenta o
   cancelamento) para NFC-e/SAT/MFE.
3. **Colunas novas do MD** (migração `ColunasMdAtualizado`): `vendas.desconto_total_origem`
   (`ck_vendas_desconto_total_origem`), `idade_confirmada_por_id`/`idade_confirmada_em` (`ck_vendas_idade_confirmada`);
   `itens_venda.desconto_promocao`, `promocao_id` (`ck_itens_venda_promocao`), `origem_entrada`
   (`ck_itens_venda_origem_entrada`), `peso_digitado`, `vasilhame_item_origem_id`; `pagamentos_venda.valor_taxa_servico`
   (no `ck_pagamentos_venda_valor`) e `transferido_de_id`; `eventos_saida.versao_nuvem_fim`;
   `identidade_terminal.restaurado_em`; `estado_conexao.desvio_amostra_utc_local`, `desvio_amostra_boot_id`,
   `maior_hora_vista`, `segundos_offline_acumulados`; `log_auditoria_local.sessao_caixa_id` e `motivo`. A base do rateio
   é `valor_bruto − desconto_item − desconto_promocao` (PDV 12.4) e `desconto_total_origem = 'operador'` quando o
   operador dá desconto no total (o de origem `cliente` não conta no limite, 12.3). Na Fase 0 `desconto_promocao` fica 0,
   `origem_entrada` só é preenchida como `busca` (F2), porque o leitor ainda não está ligado à tela, e as colunas de
   idade/taxa de serviço/transferência ficam nulas/zero. Como no SQLite o EF reconstrói a tabela para mudar CHECKs, as
   colunas novas não têm `DEFAULT` no banco (como as da migração inicial): quem grava é sempre o EF, com todos os valores.
4. **`eventos_saida.payload` é `NOT NULL` no MD**, mas o MD/SYNC dizem que o payload de confirmados é apagado após 90
   dias. Mantido `NOT NULL`; a limpeza (fase futura) precisa que o MD defina se vira nulo ou `{}`.
5. **Modelo EF escrito à mão, conferido contra o gerado**: o `Esquema.g.cs` (gerador `pnpm --filter api
   gerar:esquema-pdv`) é um descritor (colunas, tipos, escalas, nulidade, CHECKs), não as entidades EF: as tabelas de
   movimento (`vendas`, `itens_venda`…) só entraram no Drizzle na 1C (decisão 48) e as espelho só serão usadas
   com o pull. As tabelas de fluxo vêm de `TABELAS_FN_VERSAO` (`versionamento.ts`), que é o registro de fluxos até o
   `src/sync/fluxos.ts` existir. O teste `EsquemaNuvemTests` falha se uma tabela mapeada no EF que também está no
   gerado tiver coluna faltando/sobrando, tipo, escala ou nulidade diferente. Só as tabelas necessárias na
   inicialização e na venda foram criadas:
   `identidade_terminal`, `configuracao_terminal`, `estado_sincronizacao`, `estado_conexao`, `eventos_saida`,
   `sequencias_locais`, `estado_operacao`, `fila_impressao`, `log_local`, `log_auditoria_local`, `vendas`,
   `itens_venda`, `pagamentos_venda`, `parcelas_venda` (estas com todas as colunas do MD 3.11). Tabela de histórico de
   migrações: `__ef_migracoes`.
6. **Ativação de demonstração (F8)**: grava `identidade_terminal` com `url_api = demonstracao://local`, token vazio e
   `empresa_codigo = 0`, os 7 cursores de `estado_sincronizacao` e as sequências locais, na mesma transação da ativação
   real (SYNC 3.5). `IdentidadeTerminal.Demonstracao` (não é coluna) marca esse terminal: a guarda do token não tem
   candidatos, a rotação não roda e a venda continua completa. Nome e código da loja vêm de valores de demonstração até
   os espelhos `lojas`/`caixas` descerem.
7. **Venda em andamento**: cada operação é um commit (venda + itens + pagamentos + `estado_operacao.venda_atual_id`).
   O número da venda (`sequencias_locais['venda']`) só é reservado depois que o primeiro produto passa nas validações,
   para um produto recusado não gastar número.
8. **Com pagamento lançado, não se reduz o total** (cancelar item, diminuir quantidade, desconto, diminuir o
   acréscimo): é preciso remover o pagamento antes (Del na tela de pagamento). A especificação só exige isso para pagamento eletrônico; a regra
   conservadora garante Σ pagamentos ≤ total sem estorno parcial de dinheiro.
9. **Cancelamento parcial** de item com desconto é recusado (remova o desconto antes), para não ter de ratear o
   desconto do item entre a linha cancelada e a nova.
10. **Rateio (PDV 12.4)**: além da regra da âncora, quando o arredondamento "meio para cima" de muitos itens passa do
    valor (ex.: R$ 0,05 em 10 itens iguais), a âncora fica em 0,00 e os centavos excedentes voltam, um a um, do fim da
    ordem para o começo — garante "nenhuma parte negativa". O desconto no total máximo é Σ base − R$ 0,01 por item.
11. **Limite de desconto**: o Core suporta a liberação por supervisor (`Liberacao`); desde a 1C/C10a, desconto acima do
    limite do operador abre o diálogo de liberação (decisão 52) e entra em `liberacoes` da venda. Usuário Master =
    100% para operador e supervisor (`LimiteDesconto.DoUsuario`, PDV 12.3), qualquer que seja
    `usuarios.limite_desconto_pct`.
    - **Folga do arredondamento**: o % digitado vira R$ com arred2 (12.1), então 10% de 0,99 = 0,10 (10,10%). Para
      "limite 10% aplica 10% sem senha" (12.5) valer, cada desconto que pode ter vindo de um % ganha meio centavo de
      folga: aceita-se `desconto ≤ valor_tabela × limite ÷ 100 + 0,005 × n` (n = descontos em % na conta). Desconto
      digitado em R$ não tem folga (R$ 0,10 em 0,99 pede liberação). O % informado continua o exato (10,10%).
    - **Revalidação depois de diminuir/cancelar**: o desconto do item fica em R$ (o MD não tem coluna para o % do
      item), então diminuir a quantidade ou cancelar um item (com desconto fixo em R$ no total) faz o % subir.
      `AlterarQuantidade`/`CancelarItem` recebem o limite do operador e recusam (desfazendo a operação) quando o novo %
      passa do limite e do % já aceito antes (um desconto liberado por supervisor não é derrubado por arredondamento). A
      tela orienta a remover o desconto: **F6 › 5** remove o desconto do item selecionado (o 12.2 só numera 1–4).
12. **Login**: operadores simulados validados localmente; o bloqueio por 5 tentativas é em memória. Na Fase 1 vira
    `usuarios.senha_pdv_hash` (argon2id) + `bloqueios_senha_local`. Os simulados só são compilados com
    `MODO_DEMONSTRACAO` (fora de todo `dotnet publish`, ver "Publicar"); sem ele o login responde que não há operadores.
13. **Desconto no total em %** é recalculado quando os itens mudam; em R$ fica fixo e é zerado com aviso se passar do
    máximo (PDV 12.2).
14. **Sincronização**: o ciclo online é o `ServicoSincronizacaoHttp` (decisões 40–47); sem identidade real
    (demonstração) ele só conta o outbox. O cliente HTTP (`ClienteSyncHttp`) monta os cabeçalhos da SYNC 2.2, traduz o
    envelope de erro, aplica o tempo limite de cada rota (`TemposLimiteSync`, decisão 40) e é usado pela ativação, pela
    rotação do token (decisões 30–34) e pelo ciclo.
    `X-Requisicao-Id` (SYNC 20.4): leituras (pull, saúde) usam um id novo por envio; a ativação usa o
    `requisicao_ativacao_id`, o push aceita o id do lote e as chamadas online que alteram estado (`AlterarAsync`) exigem
    o id da operação lógica, repetido em toda nova tentativa. Na renovação de token (Fase 1) esse id é o gravado em
    `configuracao_terminal['token.pendente']` antes do `POST /sync/token/renovar`.
15. **Payload `venda.finalizada`/`venda.cancelada`**: chaves = nomes de tabela, colunas do MD, decimais em string na
    escala da coluna, serializado em JCS próprio (não `System.Text.Json`, que escaparia acentos) e `payload_sha256`.
16. **Banco cifrado (SQLCipher) e backups cifrados** (MD 4, PDV 32.5) ainda não (a proteção do token, decisão 32, já
    está). Retenção de backups e backup periódico (2 h / fechamento) também ficam para a PDV-1.

17. **Venda atômica**: toda operação pública do agregado `Venda` é tudo-ou-nada (foto do estado antes; qualquer
    exceção devolve itens, pagamentos e totais ao que eram). O `ServicoVenda` também relê do banco a venda atual em
    qualquer falha (da regra ou do SQLite), e a auditoria local (`desconto_item`, `desconto_total`, `item_cancelado`,
    `venda_cancelada`…) é gravada **no mesmo commit** da mudança da venda (PDV 32.1, 32.3).
18. **Item de R$ 0,00 é recusado**: `arred2(quantidade × preço) < 0,01` (ex.: 0,001 kg × 3,49) não entra, nem por
    alteração de quantidade nem como sobra de cancelamento parcial — um item sem valor não tem base de rateio (12.4).
    Venda antiga com item de base zero é restaurada com esse item fora do rateio.
19. **Pagamentos acima do total** só podem vir de dado antigo/corrompido (as regras acima impedem); `Finalizar` dá
    uma mensagem própria ("os pagamentos passam do total") em vez de "Falta R$ 0,00".
20. **Espelhos do catálogo** (migração `CatalogoPrecosCombo`): mesmas colunas do `Esquema.g.cs` menos as que não
    descem (MD 6.2: `produtos.preco_custo`/`custo_medio`/`markup_pct`/peso/…, `produtos_lojas.estoque_maximo`/
    `st_nota_entrada_id`, `formas_pagamento.conta_corrente_id`/`plano_contas_id`/`dias_recebimento`), mais os campos
    calculados `produtos.foto_url`/`foto_sha256`. A projeção vem do próprio `Esquema.g.cs` (`DescidaColuna.Omitida`/
    `Projetada`, geradas do registro de fluxos da API): o `EsquemaNuvemTests` não tem mais lista à mão e recusa coluna
    omitida no espelho. Por isso `peso_g`/`peso_abatimento_g`/`peso_pacote_kg`, que a API nunca mandou, saíram do
    espelho (migração `ProdutosSemPeso`). Os CHECKs de domínio
    da nuvem não são repetidos nos espelhos (a linha já foi validada lá e um valor novo de enumeração não pode travar o
    pull). O MD 4.1 não lista `time` nem arrays: `time` vira TEXT `HH:MM:SS` (`TimeOnly`) e `smallint[]` vira TEXT
    JSON (`short[]`, `json_valid`). `itens_venda` ganhou `grupo_preco_quantidade_id`, `quantidade_referencia_preco`,
    as colunas `kit_*` (com `ck_itens_venda_kit` e `ix_itens_venda_kit_grupo_id`), `v_fcp`, `v_icms_st_ret`,
    `v_fcp_st_ret` e `ck_itens_venda_origem_preco`.
21. **Regra de preço** (`Core/Precos/MotorPreco`, PDV 11.3/11.3.1): função pura que monta os candidatos e escolhe o
    menor (desempate do passo 10). A `Venda` guarda o produto da **primeira inclusão** (faixas, grupo, preço base e a
    vigência da promoção fixada nesse instante) e, a cada inclusão/alteração/cancelamento, recalcula todas as linhas
    que contam (não contam combo e casco). Faixa: `inicial ≤ Q ≤ final` (final inclusivo, como no 11.3; se duas faixas
    se tocam no limite, vale a de maior início) e a da loja prevalece sobre a geral na mesma quantidade.
    `preco_tabela` = preço aplicado pela regra, então atacado/mix/embalagem/combo não são "redução de preço manual"
    (12.3: `reducao_preco_manual` só existe para origem `manual`).
    - Recuperação após queda: o snapshot da primeira inclusão de cada produto (`ProdutoVenda` + `TabelaPreco` em JSON e
      a vigência da promoção) fica na tabela só local `produtos_venda_snapshot` (PK `venda_id, produto_id`, FK para
      `vendas`, não sobe), gravada **no mesmo commit** do item e apagada no encerramento da venda. A venda relida é
      reconstituída com ele, nunca com o espelho atual: um pull no meio da venda (preço, atacado, DUN excluído) não muda
      as linhas já incluídas nem a do fardo, e o "varejo 3,49"/"Economia no atacado" do cupom são os da hora da venda
      (PDV 11.3.1). Componentes de combo e cascos também entram no snapshot. Um fardo cujo código foi cadastrado depois
      da primeira inclusão é acrescentado ao snapshot; a linha usa o preço do fardo do snapshot quando código e fator
      são os mesmos. Produto **sem** snapshot (venda gravada antes da migração `SnapshotProdutosConfiguracoes`) é lido do
      espelho, mas as linhas já gravadas dele ficam com o preço fixo (`PrecoFixado`, nunca recalculadas), sem "varejo"
      nem limiar no cupom ("ATACADO" sem "12+": o limiar nunca é a quantidade do cliente).
    - Com pagamento lançado, uma inclusão/alteração cujo recálculo **reduza** o total (a 12ª lata) é recusada e desfeita
      (decisão 8 estendida).
    - Desconto do item: o % digitado fica só em memória (o MD não tem coluna) e é reaplicado quando o preço muda; em R$ é
      mantido e limitado a `valor_bruto − 0,01` com aviso. Venda recuperada trata o desconto como R$.
    - `pdv.usa_preco_volume`: lido do espelho `configuracoes` (decisão 28) a cada entrada na tela de venda; o terminal de
      demonstração grava a chave ligada para a loja de demonstração. Enquanto o aplicador do pull não existir, um
      terminal real fica no padrão (`false`): faixas por quantidade e mix modo `grupo` não valem nele (o mix modo
      `produto` e o atacado valem sempre).
    - Faixa da loja × faixa geral: quando as duas contêm Q, **vale a da loja** mesmo mais cara (texto do 11.3: "a da
      loja prevalece na mesma quantidade"; teste "faixa da loja prevalece mesmo mais cara"). Isso contraria "vale o
      menor" e é armadilha de cadastro (loja 6+ a 3,39 esconde a geral 12+ a 3,09): **confirmado pelo dono** (O7 da 1C,
      roadmap D34, C11a): a faixa da loja prevalece quando existe, mesmo mais cara; o "menor preço vence" vale só entre
      mix e atacado.
22. **Embalagem/fardo** (10.2): `valor_bruto = arred2(preço do fardo × multiplicador)` é autoritativo e o preço do fardo
    (`preço ÷ fator`) é mais um candidato; alterar ou cancelar parcialmente a linha do fardo só em múltiplos do fator e
    `+`/`−` soma/tira um fardo.
23. **Combo** (10.9.1): uma linha de `itens_venda` por posição (o título do combo existe só na tela e no cupom). Preço de
    1 combo = varejo/loja/promocional do kit (nunca atacado, faixa ou mix) + acréscimos; rateio (`RateioCombo`) pelo
    varejo do componente escolhido × quantidade, resíduo na linha de maior peso e, além da especificação, **mínimo de
    R$ 0,01 por linha** (um `det` da NFC-e não pode ter `vProd` zero; combo mais barato que 1 centavo por componente é
    recusado). `preco_unitario = arred4(valor_bruto ÷ quantidade)`. Componente/alternativa exige ativo, vendável e preço
    **≥ 0** com até 4 casas (preço 0 = "GELO BRINDE", fica com o mínimo de R$ 0,01; todos 0 = rateio pela quantidade); o
    preço > 0 vale só para o kit e para o item avulso. **Retornável** (`vasilhame_produto_id`) e **produzido** não
    entram em combo na Fase 1 (a linha do kit não pergunta/cobra cascos e o produzido não tem estoque próprio): a opção
    aparece indisponível ("retornável"/"produzido") e `AdicionarCombo` recusa — defesa para cadastros antigos ou
    importados, já que o ERP recusa no cadastro (PDV 10.9.1). O rodapé "Combo: R$ …" do diálogo usa `Venda.PrecoKit`
    com o relógio corrigido da venda (30.5), o mesmo da inclusão. A quantidade de combos é inteira; alterar a
    quantidade ou cancelar parte de uma linha do combo é recusado (cancela-se o grupo e inclui de novo); desconto de item
    numa linha vale para o combo e é rateado pelo `valor_bruto`. A opção "sem estoque" depende do saldo estimado, que
    ainda não é local (`saldos_estoque`): hoje só fica fora a alternativa inativa na loja. `pdv.desmembra_produto_kit`
    ainda não desce: a tela mostra sempre os componentes sob o título. Diálogo Montar combo: ↑/↓ ou 1–9, Enter confirma
    a posição (na última inclui), Tab/Shift+Tab andam, Esc volta e, na primeira posição, fecha sem incluir.
24. **Casco** (10.12, parte PDV-1): os cascos **trazidos** não têm coluna no MD; são derivados (`devidos − cobrados`,
    com o item do casco ligado por `vasilhame_item_origem_id`) e vão no bloco `vasilhames` do `venda.finalizada`. Por
    isso o diálogo aceita de 0 aos devidos: excedente é devolução avulsa (F11 › V: entrada dos vazios no C10b, decisão 53,
    ou desconto na venda no C11c, decisão 56). Esc não fecha
    a pergunta; uma queda entre a inclusão e a resposta deixa "todos trazidos". O casco tem preço sem quantidade
    (varejo/loja/promocional) e não é recalculado; diminuir o item cheio limita o casco ao devido e a tela pergunta de
    novo; o cancelamento parcial do cheio cancela o casco e pergunta para o restante. Casco com preço 0 não pode ser
    cobrado (seria item de R$ 0,00, decisão 18): a resposta com faltantes é recusada com "Casco … sem preço".
25. **Payload `venda.finalizada`**: itens com `grupo_preco_quantidade_id`, `quantidade_referencia_preco`, `kit_*` e
    `componentes_estoque: []` (vazio também no combo, sincronizacao.md 9.7); bloco `vasilhames` com
    `{produto_vasilhame_id, devolvidos, vendidos, emprestados: 0, pessoa_id: null}`. Completo pelo contrato na 1C
    (decisão 49).
26. **Catálogo de demonstração** (`App/Servicos/CatalogoDemonstracao.cs`, só com `MODO_DEMONSTRACAO`): gravado nos
    espelhos na ativação F8 e na inicialização de um terminal de demonstração com catálogo vazio. A tela de venda usa
    sempre o `CatalogoLocal`; o antigo `CatalogoSimulado` em memória foi removido.
27. **Desconto em R$ e recálculo de preço** (12.3 × 11.3.1): a especificação só limita o desconto do item a
    `valor_bruto − 0,01` quando o preço muda; aqui o desconto em R$ também não pode passar do **teto aceito** — o maior
    entre o limite do operador e o % efetivamente aceito (liberado por supervisor). Quando a 12ª lata derruba a linha ao
    atacado (38,39 → 35,09), o desconto de R$ 3,83 (9,98%, limite 10%) vira R$ 3,50 com aviso, em vez de 10,91% sem
    supervisor. Vale para o desconto do item (`TetoDescontoPct`, só em memória) e para o desconto no total em R$ nas
    inclusões e aumentos de quantidade; ao diminuir/cancelar continua a recusa da decisão 11. O desconto em % continua
    reaplicado em %. Na recuperação o teto é o limite do operador logado ou o % gravado, o que for maior. Cortar o
    desconto (em vez de pedir supervisor) foi escolhido porque a inclusão não pode ficar bloqueada por um diálogo.
28. **Espelho `configuracoes`** (fluxo `configuracao`, MD 3.1.1): todas as colunas da nuvem (`valor` jsonb em TEXT
    JSON, `valor_cifrado` BLOB, que desce nulo), índice `ix_configuracoes_chave`. `RepositorioConfiguracoes` lê a chave
    com a linha da loja do terminal prevalecendo sobre a da empresa e, sem linha (só existem as diferentes do padrão),
    o padrão do catálogo de chaves. Hoje só `pdv.usa_preco_volume` é lida (`SessaoTerminal.CarregarConfiguracoesAsync`).
29. **Contratos do sync no formato da API** (Fase 1B, bloco B1): `Protocolo/Contratos.cs` espelha os schemas zod de
    `packages/shared/src/sync/contratos.ts` (ativação com `nome_maquina`/`sistema_operacional`/`plataforma`/
    `versao_schema_local` e `chave_publica_terminal`; resposta completa com numerações, fluxos e chave de backup;
    estado; pull com `desde`/`cursor_teto`; push com `lote_id`/`terminal_id`/`enviado_em`; heartbeat). O JSON usa
    `ContratosJson.Opcoes` (nulo omitido na escrita: o zod recusa `null` em campo só opcional); instantes ficam em
    texto ISO para a ida e volta não mudar a forma. O `ClienteSyncHttp` ganhou `EstadoAsync`, `HeartbeatAsync`,
    `PullAsync(…, teto)` e `PushAsync(lote)`, este com `X-Requisicao-Id` = `lote_id` (o reenvio do lote repete os
    dois). `RespostaAtivacao.ToString()` omite o token. O `GenesisPDV.Sync.Tests` faz ida e volta de cada fixture de
    `packages/shared/testes/sync` (as mesmas do Vitest), recalcula o `payload_sha256` e roda os vetores JCS; o `Jcs`
    passou a escrever números no formato ES6 (vetor "números do envelope") e continua recusando `decimal`. A ida e
    volta compara sem nulos, então os testes desserializam com `Fixtures.Estritas` (`UnmappedMemberHandling.Disallow`):
    campo da fixture sem propriedade no record quebra mesmo quando vem `null` (em produção o PDV tolera campo novo).
    `ErroSyncException.RepetirApos` expõe o `Retry-After` de 429/503 (SYNC 18.3), conferido pelo caso `IP_BLOQUEADO`
    de `erros.json`.
30. **Ativação real** (SYNC 3.2–3.5; PDV 5.3; Fase 1B, B3). `ServicoAtivacao` (GenesisPDV.Sync) monta o
    `POST /sync/ativar` com a máquina (`MaquinaLocal`: nome, sistema, id de hardware, versão, plataforma,
    `versao_schema_local` = migrações aplicadas) e dois pares X25519 novos (permanente do terminal e efêmero de backup).
    Uma **tentativa** (mesmo servidor, empresa e código) guarda em memória o `requisicao_ativacao_id` e os pares: a
    repetição depois de rede caída, 503 ou falha local leva o mesmo corpo, e a API devolve o mesmo terminal com token
    novo (SYNC 3.4). Só a resposta 201 conferida grava algo, numa transação (`RepositorioTerminal.RegistrarAtivacaoAsync
    (DadosAtivacao)`, o Data não conhece os contratos do Sync): identidade com o token protegido e a `url_api`
    normalizada (barra no fim, para `sync/*` não perder um caminho como `/genesis`); `sequencias_locais` `evento` = 0,
    `venda`, `vale` e `nfce:<serie>:<ambiente>` como a API mandou (com o salto da 13.3); os 7 cursores em 0;
    `estado_conexao` online com o desvio do relógio (hora do servidor contra o meio da ida e volta) e o par da amostra
    (`IdBoot`), sem desvio nem par quando a ida e volta passa de 3 s (regra da SYNC 12.2: o primeiro heartbeat ou
    `/sync/estado` mede); a auditoria local `terminal_ativado`, no mesmo commit; `configuracao_terminal` `backup.chave` (decifrada do envelope ECIES da API e re-protegida),
    `terminal.chave_privada` (protegida) e `ativacao.resumo` (empresa, loja, CNPJ e caixa para o cabeçalho do login
    até os espelhos `lojas`/`caixas` descerem; as chaves internas ficam em `ChavesConfiguracaoTerminal.Internas`, MD
    4.4.2). Depois do commit nada mais grava: uma falha local sempre significa "nada gravado" e a repetição usa a mesma
    tentativa; se a falha vier na releitura logo depois, o assistente relê a identidade e, gravada, segue para a
    confirmação em vez de pedir outra tentativa (que gastaria o código). `IdBoot` é calculado uma vez por processo:
    `boot_id` do kernel no Linux, contador `BootId` do registro no Windows e, sem eles, o instante do boot arredondado
    ao minuto (SYNC 12.2). Token de outro terminal ou chave de backup que não abre →
    "resposta não pôde ser conferida" e nada gravado. Recusas da API têm mensagem própria (`MensagensAtivacao`:
    `CODIGO_INVALIDO`, `CODIGO_EXPIRADO`, `CODIGO_USADO`, `LIMITE_PLANO`, `CAIXA_OCUPADO`, `PDV_DESABILITADO`,
    `LOJA_INATIVA`, 426 com a versão mínima, `IP_BLOQUEADO`, `ATIVACAO_BLOQUEADA`, 503/5xx); sem resposta, "sem
    conexão" com o mesmo código ainda valendo. Nunca vão para log o token, o código de ativação nem as chaves.
    **Confirmação depois de gravar**: o passo 4 do assistente mostra empresa, loja, CNPJ e caixa de um terminal já
    ativado (a nuvem já emitiu o token; guardar só em memória até o "confirmar" arriscaria perder o terminal numa
    queda). Loja ou caixa errados → revogar no ERP e gerar outro código. O assistente: 1 boas-vindas com os
    requisitos da 32.7 que dá para medir (sistema 64 bits, núcleos, memória, disco livre; a resolução fica de fora),
    2 conexão (`GET /saude`, Enter tenta de novo; endereço padrão `https://api.genesispdv.com.br` ou `GENESISPDV_API`),
    3 código, 4 confirmação, 5 carga inicial (decisão 38); o proxy HTTP do passo 2 e o passo 6 (hardware) ficam para
    depois. Esc volta (no código, primeiro limpa); F8 (demonstração) vale até a confirmação.
31. **Id de hardware**: `sha256_hex` do `MachineGuid` (Windows, visão de 64 bits do registro) ou do
    `/etc/machine-id` (Linux), normalizado (minúsculas, sem espaços). O número de série da placa-mãe da SYNC 3.2 ficou
    de fora: no Linux só root o lê e no Windows exige WMI, e um id que muda com o usuário que roda o PDV daria `409
    HARDWARE_ALTERADO` falso. Sem id no sistema (contêiner), um aleatório fica em `dados/id_maquina`.
32. **Proteção dos segredos** (SYNC 3.6; D21). `IProtetorSegredos` com a finalidade de cada valor
    (`token:<terminal>`, `backup.chave:<terminal>`, `terminal.chave_privada:<terminal>`) como entropia/AAD e o 1º byte
    com o esquema (um banco copiado de outro sistema falha ao abrir em vez de devolver lixo). **Windows**:
    `ProtetorDpapi`, DPAPI `CurrentUser` (a conta do Windows que roda o caixa; outro usuário ou outra máquina não abre;
    `LocalMachine` não é usado). A chave CNG não exportável/TPM da SYNC 3.6 fica como endurecimento depois do piloto
    (a SYNC 3.6 e a PDV 5.3 foram alinhadas). **Linux**: `ProtetorArquivo`, AES-256-GCM com chave HKDF-SHA256 de 32
    bytes aleatórios num arquivo `0600` (pasta `0700`) com o `machine-id` como sal; o arquivo é
    `/etc/genesispdv/chave_terminal` quando o pacote o instala, senão `~/.config/genesispdv/chave_terminal` e, com
    `GENESISPDV_DADOS`, `<raiz>/chave/chave_terminal` (fora da pasta `dados`, para uma cópia do `pdv.db` não levar a
    chave). Criado na 1ª proteção; ausente na leitura é erro (nunca gera chave nova que não abriria nada); permissão
    aberta volta a `0600`. Sem libsecret (D21). O teste da DPAPI roda no job `windows-latest` do CI.
33. **Chaves e envelope**: X25519 pelo BouncyCastle (o .NET não tem a curva no Linux), SPKI/PKCS#8 com os prefixos
    DER fixos da RFC 8410 (os mesmos do `generateKeyPairSync('x25519')` da API). `Ecies.Decifrar` é o lado PDV de
    `apps/api/src/seguranca/ecies.ts` (HKDF com a SPKI efêmera como sal, info `genesis-ecies-v1`, AES-256-GCM);
    `packages/shared/testes/ecies/vetores.json`, gerado pela API e conferido pelo Vitest dela, passa no
    `CriptografiaTests`. O PDV só decifra; o lado que cifra, para a `ApiFalsa` montar respostas, é o `EciesApi` dos
    testes (escrito de novo, não reaproveita o do PDV). `chave_publica_terminal.algoritmo` é sempre `x25519` nesta fase.
34. **Token e rotação** (SYNC 3.7). `CofreToken` (`IFonteToken` do `ClienteSyncHttp`) decifra o token e o
    `token.pendente` só quando precisa e os guarda em memória; o cliente tenta "pendente, depois atual": `401
    TOKEN_INVALIDO` passa ao próximo, e o primeiro 200 com o pendente o promove (`identidade_terminal.token_protegido`
    = novo e `token.pendente` apagado no mesmo commit). Depois de cada 401 o cliente relê os candidatos: se outra
    chamada promoveu o pendente nesse meio-tempo, repete com ele, e não com o atual da lista antiga (que já virou o
    anterior; a API o trataria como cópia, mesmo com a margem de 30 s dela). `RotacaoToken.RenovarAsync` gera o segredo (32 bytes de
    CSPRNG, base64url), grava o pendente protegido (`{token_protegido, requisicao_id, criado_em}`) **antes** do
    `POST /sync/token/renovar` e manda só o `sha256_hex` do segredo; com pendente já gravado repete com o mesmo id e o
    mesmo hash. O pendente só é descartado quando o atual responde 200, ele vem levando 401 há mais de 24 h e nenhuma
    renovação foi confirmada nesse meio-tempo (descartar um pendente que a API aplicou deixaria o PDV só com o
    anterior, que vence em 7 dias). O 200 da própria renovação, obtido com o atual, não conta: é ele que aplica o
    pendente na API (`CofreToken.IniciarRenovacao` marca a chamada). Quem chama a rotação é o ciclo online, quando o heartbeat responder
    `renovar_token: true` (B5); a mecânica está pronta e testada contra a `ApiFalsa`
    (`tests/GenesisPDV.Sync.Tests/ApiFalsa.cs`, também ligada ao App.Tests) e contra a API local.
35. **D18 já no B3**: com identidade real (não demonstração), `ServicoVenda` recusa pagamento e finalização
    (`MensagemVendaSoMontagem`): um `venda.finalizada` no outbox não teria quem o aplicasse na nuvem até a 1C. Itens,
    quantidade, desconto e consulta de preço funcionam. O plano previa o bloqueio no B5; entrou junto com a ativação
    real porque é ela que cria a identidade real. No B5 a **venda em andamento voltou a poder ser cancelada**
    (Shift+F4; a D18 só veda finalizar e cancelar venda finalizada): sem isso o caixa ficava preso numa venda aberta
    (Alt+F4 bloqueado, desativação sem "terminar a venda em andamento"). O cancelamento grava a venda `cancelada` no
    banco local **sem** `venda.cancelada` no outbox (o envio pararia no `SCHEMA_DESCONHECIDO` até a 1C) e a auditoria
    `cancelar` (catálogo da nuvem) sobe no `auditoria.registros`; o número da venda não volta. **Encerrada no C11a**
    (decisão 54): o terminal real finaliza e o cancelamento em andamento gera o `venda.cancelada` forma B.
36. **Espelhos dos 6 fluxos** (MD 4.2, 6.1; Fase 1B, B4). Todas as tabelas espelho do `Esquema.g.cs` têm entidade
    (`Entidades/TabelasAcesso.cs`, `TabelasConfiguracao.cs`, `TabelasReferencia.cs`, `TabelasEstoque.cs`,
    `TabelasPessoas.cs`, `TabelasCatalogoComplementar.cs`), geradas a partir do esquema e conferidas pelo
    `EsquemaNuvemTests` (colunas, tipos, escala, nulidade, **chave primária e fluxo**; um espelho novo na nuvem sem
    entidade aqui falha o teste). Bases: `LinhaEspelho` (id + autoria), `LinhaEspelhoSemAutoria` (projeções P, como
    saldos e relevância) e `LinhaReferencia` (chave natural: `ufs.sigla`, `ncms.codigo`, `permissoes.chave`…); as três
    têm `criado_localmente`. Arrays (`text[]`, `smallint[]`) em TEXT JSON. Locais novas: `bloqueios_senha_local` e
    `comandos_recebidos` (usada pelo ciclo online do B5). Migração `EspelhosDescida`.
37. **Aplicador do pull** (SYNC 6.10; `Pull/AplicadorPull.cs`, `Pull/ConversorLinha.cs`). SQL em lote gerado do
    `Esquema.g.cs`, não o change tracker do EF: `insert … on conflict(<chave>) do update set <colunas presentes> where
    excluded.versao > versao`, um comando preparado por tabela e conjunto de colunas. Colunas locais pelo `pragma
    table_info` (coluna ou tabela desconhecida → ignorada com log, sem travar o cursor; coluna conhecida ausente fica
    fora do `update` e mantém o valor local; numa linha nova, `NOT NULL` ausente recebe valor neutro). Decimal em texto
    → INTEGER na escala da coluna, sem arredondar (casa a mais = erro e a página inteira volta). Página e cursor
    (`estado_sincronizacao`) no mesmo commit. `criado_localmente` nunca vem da nuvem (o valor da linha é ignorado) e a
    versão da nuvem que substitui a linha grava `0` (MD 4.2: a linha criada no caixa passa a ser a da nuvem); o
    `RepositorioEspelhos` (carga de demonstração e testes) segue a mesma regra. **Purga de pessoa** (MD 3.5.4):
    relevância excluída sem outra ativa e sem venda em andamento/evento pendente da pessoa → a pessoa e as filhas saem
    do espelho; se só sobrou `funcionario`, saem telefones e endereços (D19).
38. **Carga inicial** (SYNC 6.9; PDV 5.3 passo 5; `Pull/CargaInicial.cs`, `CargaInicialViewModel`). Fluxos na ordem
    da 6.1, `limite = 2000` e `teto` = `cursor_teto` da 1ª página; fluxo concluído quando `tem_mais = false` e
    `novo_cursor ≥ cursor_teto` (o `operacao` vazio termina na 1ª página), com `carga_inicial_concluida = 1` no commit
    da última página. `cursor_teto` menor que o cursor salvo (a nuvem voltou de um backup, SYNC 6.3 e 22.5; a API
    responde página vazia com `novo_cursor = desde`, que pareceria fim de carga) para a carga: nada é aplicado, o fluxo
    não conclui, fica com `ressincronizar = 1` e o erro "Chame o suporte" em `ultimo_erro`. `synchronous=NORMAL` só nas conexões da carga (as do EF voltam a `FULL` ao abrir). Login liberado
    quando `configuracao`, `acesso`, `referencia`, `catalogo` e `estoque` concluíram: a tela mostra uma barra por fluxo
    e Enter entra no caixa enquanto `pessoas`/`operacao` terminam em segundo plano. Interrompida, a abertura do app
    volta para a carga (identidade real sem os bloqueantes concluídos) e retoma do cursor de cada fluxo; com o login já
    liberado, o que falta continua em segundo plano. O snapshot NDJSON fica para depois (a API não o oferece).
39. **Login offline pelo PIN** (PDV 7.2; SYNC 4; `Acesso/AutenticadorOffline.cs`, `Acesso/VerificadorArgon2.cs`,
    `Servicos/Operadores.cs`). Regras na ordem 1 (login ou código), 7 (bloqueio antes de verificar), 2 (argon2id), 3
    (`ativo`, que já desce calculado com a demissão, D19), 4 (loja do terminal ou Master), 5 (`pdv.acesso.entrar`;
    negar do usuário vence o conceder do usuário ou do perfil) e 6 (totem). PIN nulo (sem a loja, modo perdido) ou
    hash fora dos limites → "Usuário ou senha inválidos" sem contar tentativa (o fora dos limites vai para `log_local`
    e para a auditoria `hash_fora_dos_limites`). Os motivos (`MotivoRecusa`, inclusive `sem_acesso_pdv`, `totem` e
    `hash_fora_dos_limites`) e as ações gravadas estão no catálogo da nuvem (`ACOES_AUDITORIA`, `MOTIVOS_FALHA_LOGIN`):
    a fixture `auditoria.registros.payload.json` é conferida pelo zod e pelo `ContratosTests`. Bloqueio: 5 erros seguidos dentro de 5 min → 5 min, persistido em
    `bloqueios_senha_local` (sobrevive a reinício), zerado no acerto. O libsodium recebe a string remontada na ordem
    canônica `m,t,p` (o node-argon2 escreve `m,p,t`); limites da SYNC 4.2 conferidos antes; uma verificação por vez.
    Compatibilidade provada pelos vetores que a API gerou (`packages/shared/testes/sync/argon2.vetores.json`), os mesmos
    do Vitest dela. O terminal de demonstração continua com os operadores simulados (só no build de demonstração); o
    real usa sempre o espelho. A tela diz "PIN (senha do PDV)" e o `login_negado` grava o motivo. Nome e código da loja
    no cabeçalho vêm do espelho `lojas` assim que ele desce. Ficam para depois: senha do ERP online, desbloqueio pelo
    supervisor (`pdv.usuario.desbloquear`) e o bloqueio do PIN do cliente (30 min).

40. **Ciclo online** (SYNC 5, 6.5, 7.5, 18, 21.1; PDV 30; `Cliente/ServicoSincronizacaoHttp.cs`). Um laço só em
    segundo plano, uma chamada por vez, sem transação do SQLite aberta durante a rede (18.4). Pull a cada `pull_s`
    (30 s) na ordem da 6.1, página seguinte na hora com `tem_mais`, página e cursor no mesmo commit (o
    `AplicadorPull` da carga) e o fluxo marcado com teto menor que o cursor esperando o suporte; heartbeat no intervalo
    que a nuvem manda (30 s; com comandos ou resoluções, o próximo sai em 1 s com os acks); push 500 ms depois de cada
    gravação no outbox e a cada `push_pendente_s` enquanto houver pendentes. Backoff de heartbeat/pull de 5 s a 5 min
    com jitter, nunca menos que o `Retry-After` (429/503), zerado no primeiro sucesso; o handshake refeito pelo laço
    tem o mesmo backoff, próprio (`_proximoHandshake`, também na espera do laço): um 503 `MANUTENCAO` ou um 403 no
    `/sync/estado` não gera mais um `GET` a cada volta do laço (15 s com o outbox vazio). A volta de offline e o
    Ctrl+Alt+S zeram esse backoff. Toda falha reagenda, também as
    que mudam o estado (401, 409): push parado e pull sem token ficam fora da espera do laço, que nunca gira sem pausa.
    401 `TOKEN_INVALIDO` com o laço rodando para push e pull e deixa só o heartbeat, com backoff; o primeiro 200 dele
    (401 passageiro de proxy ou da rotação) libera tudo de novo. Offline = 2 falhas de transporte seguidas ou 1 timeout
    de heartbeat; offline por mais de 1 h refaz o handshake no reencontro. Os intervalos de `OpcoesSincronizacao` são o padrão até o
    primeiro heartbeat (os testes os trocam). O laço liga no login do terminal real (e na tela de desativação) e
    substitui a "carga em segundo plano" de `pessoas`/`operacao` do B4 (o pull periódico conclui esses fluxos). Sem
    identidade real (demonstração), nada sobe nem desce. Tempo limite por rota (SYNC 2.1, `TemposLimiteSync`):
    heartbeat 10 s (é o "timeout de heartbeat" da 18.3), `/sync/estado` 10 s (o handshake antes do login desiste em
    segundos numa rede que aceita a conexão e não responde), pull 30 s, push 60 s, ativação 30 s; o `HttpClient` fica
    sem `Timeout` próprio e a conexão tem 5 s no handler.
41. **Handshake antes do login** (SYNC 5; `ShellViewModel`). Terminal real: `GET /sync/estado` depois do banco e
    antes da carga/login. `sequencias_locais.evento` abaixo de `ultima_recebida` → **regressão**: tela de bloqueio e
    push parado (a recuperação 22.1 é da 1C); abaixo do `ultima_sequencia_gerada` informado → **perda provável** só
    vai para o log e o heartbeat (o salto obrigatório da 22.1 é da 1C); `id_hardware_confere = false` → tela "Hardware
    alterado — aguardando aprovação no ERP" (Enter tenta de novo; o laço continua com heartbeat e pull, o push espera);
    `desativando` → grava e vai para a tela de desativação; 401 `TERMINAL_REVOGADO` (ou `revogado` já gravado, sem
    rede) → tela de terminal desativado; 401 `TOKEN_INVALIDO` e protocolo abaixo do mínimo → bloqueio "chame o
    suporte". 403 da empresa ou da loja (`EMPRESA_SUSPENSA`, `EMPRESA_CANCELADA`, `PDV_DESABILITADO`,
    `LOJA_INATIVA`; SYNC 2.5, MD 2.3) no handshake, no pull ou no heartbeat → estado `Suspenso` com o texto do código
    (`MensagensBloqueioNuvem`) na tela de bloqueio (abertura; Enter tenta de novo) ou na barra (no expediente), nunca
    "Sem conexão": a venda aberta termina e a próxima é recusada (`MensagemTerminalBloqueado`); o push continua (a
    nuvem só o recusa com a empresa cancelada), heartbeat, pull e handshake seguem com backoff e a primeira resposta
    200 de um deles libera. Efeito prático pequeno na 1B: pela D18 o terminal real já não finaliza venda, então o
    bloqueio só impede abrir uma venda nova para montar. **Sem conexão: o caixa abre com os dados locais** (regra de bloqueio definida no B5: só bloqueia o que a
    nuvem afirmou) e o handshake é refeito pelo laço no primeiro contato. Cada handshake reavalia os bloqueios do
    zero (nada fica herdado da publicação anterior): o Enter da tela de bloqueio libera de verdade quando a regressão
    foi recuperada, o token voltou a ser aceito ou o hardware foi aprovado. `versao_minima` fica em
    `estado_conexao.versao_minima_app` (a regra de prazo da 17.3 vem com a atualização do app).
42. **Push mínimo** (SYNC 7.2–7.5, 9.22; `Push/OutboxSync.cs`, `Push/EnvioPush.cs`). Na 1B só sobe
    `auditoria.registros`: lote de até 200 registros do `log_auditoria_local` a cada 5 min (ou já, na desativação),
    com o `evento_id` gravado nos registros no mesmo commit do evento. Sobem só as ações do catálogo da nuvem
    (`CatalogosNuvem`, conferido contra `packages/shared/src/enums.ts` pelo `CicloOnlineTests`); login e login negado
    viram também `logins` (`historico_logins`), com o `login_informado` gravado no `depois` pelo login e o motivo só
    quando é do catálogo. As ações do caixa fora do catálogo (desconto, item cancelado, venda recuperada) ficam locais:
    são detalhes da venda e sobem com os eventos dela na 1C. Envelope completo da 7.3 a partir de `eventos_saida`, que
    ganhou `usuario_id`, `contexto` (JSON: loja, caixa, número, `estoque_id` vigente do espelho, versões),
    `ocorrido_em_local`, `desvio_relogio_ms` e `relogio_confiavel` (migração `EnvelopeEventos`; evento antigo sem
    contexto usa o da identidade). Lote de até 50 eventos, sempre prefixo contínuo da frente (evento em backoff segura
    a fila); o reenvio repete **o mesmo lote**: mesmos eventos, mesmo `lote_id` e `X-Requisicao-Id`, mesmo corpo
    (`enviado_em` gravado, `eventos_pendentes_total` omitido). Máquina de status da 7.2: `aplicado`/`duplicado` →
    `confirmado`; `rejeitado`/`retido`/`descartado` → `rejeitado` (não reenvia); `nao_processado` → `pendente` fora do
    lote; `erro_temporario`, `fora_de_ordem` (como no diagrama da 7.2; a tabela diz `pendente`, mas o `fora_de_ordem`
    repetido de uma lacuna local ou da nuvem restaurada, 22.5, viraria reenvio sem fim), status desconhecido e falha de
    rede → `erro_temporario` com backoff de 5 s a 10 min (`Retry-After` nunca encurtado); 409 de hardware e 401
    devolvem o lote intacto; 409 `REGRESSAO_DETECTADA` grava os resultados parciais e para o push. Lote em que nenhum
    evento saiu da fila não é repetido na hora. Na abertura, `enviando` volta a `pendente` mantendo o lote. Cada
    caminho tem teste no `CicloOnlineTests` contra a `ApiFalsa`, que segue o `push.ts` (sequência maior = `fora_de_ordem`
    e para o lote; menor com evento novo = 409 `REGRESSAO_DETECTADA` com `detalhes.resultados`).
43. **Comandos** (SYNC 21.1; `Ciclo/ProcessadorComandos.cs`). Dedupe por `comando_id` em `comandos_recebidos`
    (gravado antes de executar; a repetição devolve o resultado gravado) e ack no heartbeat seguinte, em fatias do
    máximo do `heartbeatSchema` (100 `comandos_resultado`, 500 `eventos_resolvidos_ack`): o resto vai no heartbeat
    seguinte, 1 s depois, e o comando entregue de novo com o ack ainda na fila não duplica. Heartbeat recusado como
    inválido (400/422) descarta os acks pendentes em vez de repeti-los para sempre: a nuvem entrega de novo o que ficou
    sem ack e o dedupe refaz o mesmo ack, sem executar de novo. `revogar` grava
    `desativando`; `ressincronizar`/`ressincronizar_fluxo` zeram o cursor (de todos ou do fluxo) e o pull periódico
    baixa de novo com o caixa funcionando — a ressincronização em sombra da 6.11 (apagar o que não voltou) fica para
    depois; `mensagem` aparece no topo da janela até o operador fechar; `enviar_logs`, `atualizar_app` e
    `reservar_faixa` respondem `falhou` "não suportado". `eventos_resolvidos` do heartbeat passam `aplicado` a
    `confirmado` e guardam o resultado do descarte, com ack.
44. **Desativação e revogação no PDV** (SYNC 3.8). `desativando` (heartbeat, handshake ou `revogar`) é gravado em
    `identidade_terminal.status` (só avança: `RepositorioTerminal.AvancarStatusAsync`) e, a partir desse commit,
    `ReservarNumeroVendaAsync` recusa na mesma transação da reserva. Com o caixa livre (no login ou sem venda aberta) a
    tela vira "Terminal em desativação — enviando pendências (N)"; com venda aberta, a barra avisa e a troca vem quando
    ela fechar, e o heartbeat só leva `desativando_confirmado` sem venda aberta (o cancelamento dela ainda grava a
    auditoria `cancelar`, que precisa subir antes). O lote de auditoria é forçado, o push esvazia o outbox e o
    heartbeat leva `desativando_confirmado` com os números finais (eventos `rejeitado` não seguram: a nuvem já os tem,
    D20). A lacuna aceita da 1B (o que fosse gravado entre montar esse heartbeat e receber o `revogado` ficava só no
    banco local) foi fechada na 1C pela D22 (decisão 51). `revogado` (resposta do heartbeat ou
    401 `TERMINAL_REVOGADO` em qualquer chamada, também num pull da carga inicial, antes do login) é gravado, o laço para e a tela mostra "Terminal desativado pelo ERP"
    com o diagnóstico (terminal, pendências, pasta de dados); o banco local nunca é apagado e a reabertura vai direto
    para essa tela, sem rede. Na carga inicial o 401 não oferece "Enter tenta de novo": `TERMINAL_REVOGADO` vai para
    a tela de desativado e `TOKEN_INVALIDO` para o bloqueio "chame o suporte" do handshake (sem gravar nada; Enter
    refaz o handshake e, aceito o token, volta para a carga). Hardware alterado no meio do expediente para o push e recusa nova venda
    (`MensagemTerminalBloqueado`) até o heartbeat voltar `ativo` ou `desativando` (a API só manda os dois com o
    hardware conferido): aprovado durante a desativação, o push volta e a tela de bloqueio vira a de desativação.
45. **Relógio mínimo** (SYNC 12.2–12.3; `Relogio/RelogioSync.cs`). Toda resposta com `X-Agora-Servidor` vira amostra
    (`servidor − (envio + ida_e_volta/2)`, ida e volta medida no relógio monotônico, descartada acima de 3 s); o desvio
    é a mediana das 5 últimas e fica em `estado_conexao` com o par da amostra (UTC local e boot), regravado quando muda
    100 ms ou a cada minuto. Na abertura vale o desvio persistido; de outro boot ele é usado com `relogio_confiavel =
    false` até a primeira amostra (NTP do SO, SEFAZ e NTP direto ficam para o fiscal). O `ocorrido_em` do envelope é
    `agora_local + desvio` com a monotonicidade limitada a 2 min (12.3; acima disso, hora corrigida pura e aviso no
    log), `ocorrido_em_local` é a hora do SO; o heartbeat leva `hora_local`, o desvio e `relogio_confiavel`. O
    `IRelogio` do app continua sendo o do SO (os registros locais e o `ocorrido_em` de cada registro de auditoria levam
    a hora do SO). Na 1C (decisão 51) os fatos do caixa passaram à hora corrigida (`RelogioCorrigido`) e todo evento
    entra pelo `GravadorOutbox`.
46. **Indicador da barra** (PDV 30.2; `IndicadorSync`). Login e venda mostram, nesta ordem de prioridade: terminal
    desativado, hardware alterado, em desativação (N), erro de sync (regressão/token), bloqueio da nuvem (empresa
    suspensa ou cancelada, PDV desabilitado, loja inativa: o motivo, com o texto completo na dica), demonstração (sem nuvem),
    "Offline há N min", "Erro de sync" (eventos em quarentena), "Sincronizando", "Cadastros de N dias atrás" (pull com
    sucesso há mais de 24 h) e "Online"; verde/âmbar/vermelho sempre com ícone e texto, recalculado a cada segundo. O
    último erro do sync fica na dica. Ctrl+Alt+S "Sincronizar agora" na venda e na desativação. O status detalhado
    (F11 › S) fica para depois.
47. **E2E PDV ↔ API** (`tests/GenesisPDV.E2E.Tests`, job `e2e-sync`). O roteiro do B5 com o PDV de verdade sem tela
    e a API local: código gerado pela rota do ERP e ativação pelo assistente, carga dos 7 fluxos, login pelo PIN
    definido na rota do ERP, preço alterado por `PUT /api/produtos/:id` (a API não tem `PATCH`; a tela manda o detalhe
    com o preço novo) chegando ao caixa em até 60 s pelo pull de 30 s, heartbeat com o `cursor_pull` do catálogo igual
    ao teto, revogação aceitando pendências até a confirmação (com a auditoria do login na nuvem) e um segundo terminal
    no mesmo caixa — sem o salto de +1000, porque a desativação foi confirmada — revogado imediatamente até a tela de
    desativado. Na revogação aceitando pendências a venda fica aberta: a tela continua na venda até ela ser cancelada,
    passa pela de desativação e só então a nuvem confirma (com a auditoria do `cancelar`). Só polling com tempo limite;
    intervalos de produção. O projeto tem um teste que roda sempre (`EstadoE2ETests`): ele lê o exemplo versionado
    `apps/api/test/e2e-pdv/estado.exemplo.json`, contra o qual o `servidor.ts` confere o estado que grava, e evita que o
    `dotnet test` da solução saia com o código 8 (nenhum teste executado). No `rodar.sh` o roteiro é exigido (ver
    "Compilar e testar"). Os passos pelo teclado comuns aos roteiros ficam em `RoteiroE2E` (C13, decisão 57).

### Fase 1C – vendas e caixa (PDV)

48. **Venda local alinhada às tabelas da nuvem** (bloco C3 da 1C; MD 3.11.2–3.11.4, 4.1; crítica da 1C, item 8). A
    migração `0012_vendas_caixa` da API criou `vendas`, `itens_venda`, `pagamentos_venda`, `parcelas_venda` e as de
    caixa no Drizzle, e o `Esquema.g.cs` passou a descrever as 12 tabelas de movimento (`TABELAS_MOVIMENTO_PDV`). O
    modelo EF já tinha as colunas do MD; faltava `vendas.relogio_confiavel` (decisão técnica T5: `false` quando a
    venda foi finalizada sem hora confiável; preenchida pelo `GravadorOutbox` do C9 com o `relogio_confiavel` do
    envelope, decisão 51). A migração EF `VendasAlinhadasNuvem` acrescenta a coluna (as linhas da 1B ficam `true`) e os
    CHECKs da nuvem que faltavam: `ck_vendas_canal`, `ck_vendas_status_fiscal`, `ck_vendas_cancelamento_origem`,
    `ck_vendas_cpf_cnpj_nota` (a regra `~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'` reescrita com `GLOB`, que o SQLite
    não tem expressão regular), `ck_pagamentos_venda_tipo_integracao` e `ck_pagamentos_venda_uf_pagamento`. Como
    CHECK novo no SQLite só entra recriando a tabela, o EF recria `vendas` e `pagamentos_venda` (com o backup
    automático antes da migração; o `MigracaoVendasTests` confere que a venda gravada antes, com item e pagamento,
    sobrevive e que o que a nuvem recusa passa a ser recusado aqui). Novo teste no `EsquemaNuvemTests`: toda tabela
    de movimento mapeada no PDV tem todos os CHECKs da nuvem, com o mesmo nome **e a mesma expressão** (espaços
    normalizados), para que o que viraria `PAYLOAD_INVALIDO` na nuvem seja recusado antes de virar evento: uma
    enumeração estreitada na nuvem (`CANAIS_VENDA`, `STATUS_FISCAL_VENDA`) regenera o `Esquema.g.cs` e quebra o teste
    até o PDV acompanhar. Só os CHECKs reescritos para o SQLite (`ChecksReescritosParaSqlite`, hoje apenas
    `ck_vendas_cpf_cnpj_nota`) são conferidos só pelo nome. O `Esquema.g.cs` marca as colunas geradas da nuvem
    (`ColunaEsquema.Gerada`, a `diferenca` dos fechamentos), e o teste `Colunas_geradas_da_nuvem_sao_calculadas_no_pdv`
    exige que, quando a tabela entrar no modelo (C9), a coluna seja `HasComputedColumnSql` aqui também. As tabelas de caixa (`sessoes_caixa`, `movimentos_caixa`, `fechamentos_caixa`,
    `fechamentos_caixa_formas`) e `movimentos_vasilhame` entraram no modelo do PDV no C9 (decisão 51), com a
    `diferenca` calculada.

49. **Payload de venda no contrato** (bloco C4 da 1C; sincronizacao.md 9.1, 9.7, 9.9; decisões técnicas T17 e T18;
    dono, O6). A `FabricaEventos` gera cada linha com **todas** as chaves do contrato zod
    (`packages/shared/src/sync/eventos.ts`): entraram as chaves de topo `itens_venda_complementos`, `transacoes_tef`,
    `cobrancas_pix` (vazias até o PIX estático do C11a), `liberacoes`, `nfe_solicitada` e `nfe_pendente_erp`
    (`false` até a 1D); nos itens, lote, comanda, orçamento, vendedor e o bloco fiscal (`cfop`, `ncm`,
    `fiscal_snapshot`, `v_ibs`, `v_cbs`, `v_is`, `v_fcp`, `v_icms_st_ret`, `v_fcp_st_ret`), nulos até cada um ter dado;
    nos pagamentos, cliente da forma, grupo card/detPag, TEF, PIX, vale e `autorizado_por_id`, nulos até as formas do
    C11a. O `ContratosEventosTests` reconstitui a venda da fixture (ids e horários da sincronizacao.md 9.1) e exige o
    payload **igual** a `venda.finalizada.payload.json` e `venda.cancelada.em_andamento.payload.json`, com o mesmo
    `payload_sha256`; o Vitest passa as mesmas fixtures pelo zod. Uma venda montada pelas operações do caixa (atacado,
    combo, casco, desconto liberado) tem de gerar as mesmas chaves em cada linha. As fixtures de caixa e vasilhame
    passaram a ser geradas pelo PDV no C9 (decisão 51); as do alerta e da forma A do cancelamento, no C11a e no C11b;
    até lá o lado C# confere delas só o `payload_sha256` do JCS contra `eventos.conferencias.json`, o mesmo que o Vitest calcula com o
    `jcs` do TS (uma diferença de serialização entre as linguagens quebra um dos lados). O mesmo arquivo traz as bordas
    do motivo (14/15 e 255/256 caracteres, com e sem espaços nas pontas), que `Venda.Cancelar` e o zod rodam igual, e
    as ações de liberação, comparadas com as constantes de `AcaoLiberacao`.
    - **Liberações**: `Liberacao` (Core) ganhou `ConcedidaEm` (o instante do PIN, obrigatório). Desconto de item, de
      combo ou no total que **passou pelo limite do supervisor** (`ResultadoDesconto.PorLiberacao`) registra uma
      `LiberacaoVenda` (`desconto_item`/`desconto_total`, item, % pedido, supervisor, motivo sem os espaços das pontas,
      de 1 a 255 caracteres) e preenche o `autorizado_por_id` do item; dentro do limite do próprio operador a
      `Liberacao` informada é ignorada, sem exigir o motivo (o diálogo do C10a pode montá-la antes de saber se precisa,
      e um `motivo: ""` no payload seria `PAYLOAD_INVALIDO`). A linha é o último passo da operação atômica (depois do
      `Recalcular`; o `Reverter` também a desfaz, decisão 17) e fica se o desconto for removido depois. A tabela só local `liberacoes_venda`
      (migração EF `LiberacoesVenda`) guarda as linhas no mesmo commit da venda, para a venda em andamento voltar com
      elas depois de uma queda; não é apagada no encerramento (o fechamento do C10a conta o `qtd_liberacoes` por ela).
      As outras ações com supervisor (preço manual, limite de valor, PIX manual) entram com o diálogo de cada uma.
    - **Motivo do cancelamento**: `Venda.Cancelar` exige de 15 a 255 caracteres (`Venda.MotivoCancelamentoMinimo`;
      O6, roadmap D23), contados sem os espaços das pontas, como o zod da nuvem; fora disso o `venda.cancelada` seria
      `PAYLOAD_INVALIDO`. O motivo fixo da tela de hoje ("Cancelada pelo operador no caixa") já cabe; o diálogo com
      texto livre entra no C11b.
50. **Formas de pagamento da loja** (bloco C8b da 1C; dono, O9a/D25 e O23; MD 3.10.1; README da API › decisão 136). O
    espelho `formas_pagamento` perdeu `loja_id` e ganhou `exige_supervisor`; entrou o espelho
    `formas_pagamento_lojas` (`FormaPagamentoLojaRegistro`, fluxo `configuracao`), em que a linha de `loja_id` nulo
    vale para todas as lojas (migração EF `FormasPagamentoLojas`). Descem só os vínculos de "todas" e da loja do
    terminal, vivos ou excluídos, e só as formas que já valeram nesta loja. A forma que o caixa oferece é a de
    `CatalogoLocal.FormasPagamentoAsync`: não excluída, ativa, de uso no PDV e com vínculo vivo, na ordem dos botões. A
    exclusão do vínculo que desce (loja tirada da forma no ERP, ou "todas" trocada por lojas escolhidas) tira a forma
    daqui sem apagar a linha, que as vendas antigas citam (não há purga, ao contrário das pessoas). O aplicador do pull
    grava a tabela nova pelo `Esquema.g.cs`, sem código próprio. A tela de pagamento continua com a forma Dinheiro fixa
    da demonstração (`ServicoVenda.Dinheiro`, que ganhou o vínculo de "todas" no catálogo de demonstração): ler daqui,
    com "dá troco" (`permite_troco`, só sem integração e fora de cartão/PIX, O23) e "exige supervisor" (somado à
    `pdv.pix_manual_exige_supervisor`), é do C11a; o fechamento por forma, do C10a.
    **Espelho novo num fluxo existente (SYNC 17.4.2)**: o PDV anterior, puxando de uma API já com a 0014, descarta
    `formas_pagamento_lojas` e `exige_supervisor` (tabela e coluna desconhecidas não travam o cursor) e avança o cursor
    de `configuracao` além delas. Por isso a migração EF volta esse cursor a 0 e a `versao` local das formas também
    (sem a segunda, a mesma versão da nuvem, agora com o `exige_supervisor` real, seria ignorada pelo `excluded.versao
    > versao`): o ciclo baixa o fluxo de novo, por upsert, com o caixa funcionando, como o comando
    `ressincronizar_fluxo`. Não usa `ressincronizar = 1`, que aqui quer dizer "esperar o suporte" (teto menor que o
    cursor) e faria o pull pular o fluxo. Regra para as próximas migrações: espelho novo num fluxo que já existe, ou
    coluna nova cujo valor o caixa precisa, volta o cursor do fluxo (e, na coluna, a versão das linhas da tabela).
    Implantação: API primeiro (o app novo se acerta no primeiro pull); na ordem contrária, o caixa fica sem forma até
    a 0014 rodar na API (os vínculos nascem então com versão acima do cursor e descem). Testes:
    `MigracaoFormasPagamentoLojasTests` (cursor e versão voltam a 0; os outros fluxos e a carga inicial ficam) e
    `AplicadorPullTests` (o PDV anterior descarta vínculo e coluna e avança o cursor; depois da migração a mesma
    página grava os dois e a forma aparece com supervisor).

51. **Caixa no banco local, gravador único do outbox e o que a nuvem aceita** (bloco C9 da 1C; MD 3.12, 4.3, 4.4.4,
    4.4.5; sincronizacao.md 3.8, 7.1, 7.3, 8.5, 9.3–9.6, 9.26, 12.3, 17.5; decisões técnicas T13 e T5; dono, D7 e D22).
    - **Tabelas de caixa** (`Entidades/TabelasCaixa.cs`, migração EF `TabelasCaixa`): `sessoes_caixa`,
      `movimentos_caixa`, `fechamentos_caixa`, `fechamentos_caixa_formas` e `movimentos_vasilhame` com todas as colunas
      e os CHECKs da nuvem (o `EsquemaNuvemTests` passou a compará-las), a `diferenca` calculada pelo SQLite
      (`HasComputedColumnSql(..., stored: true)`, como a coluna gerada da nuvem), uma sessão aberta por terminal
      (`uq_sessoes_caixa_aberta`, o índice parcial da nuvem) e FKs só entre elas. O CHECK de booleano da convenção ganha
      o sufixo `_bool` quando o nome curto já é de um CHECK da nuvem (`ck_movimentos_caixa_cancelado`).
      `RepositorioCaixa` grava cada fato (abrir, reforço/sangria, cancelar movimento, fechar, devolução avulsa) com o
      evento num commit; recusa abrir em desativação (fechar continua, SYNC 3.8), com outra sessão aberta ou fora da
      sessão aberta. As regras de tela (fundo, fechamento cego, supervisor) são do C10a.
    - **Fábricas** (`Eventos/FabricaEventosCaixa.cs`): os cinco `caixa.*` e o `vasilhame.movimentado` a partir das linhas
      locais, com as chaves do contrato zod; o `ContratosEventosTests` exige o payload **igual** a cada
      `caixa.*.payload.json` e `vasilhame.movimentado.payload.json` (o mesmo `payload_sha256`). Cada evento declara o
      operador (`usuario_id`), a sessão e as dependências da 8.5: o movimento, a sangria, o fechamento, a devolução e a
      venda dependem da sessão; o `caixa.aberto` da troca de turno, da sessão anterior; o cancelamento, do movimento.
      O que a nuvem recusaria (sangria sem quem retira, cancelamento sem motivo, troca de turno com sangria, abertura
      diferente do fundo de troco, cancelamento de movimento que não é sangria nem reforço) nem vira evento.
    - **`GravadorOutbox`** (`Data/Outbox`): único caminho para `eventos_saida` — venda (`RepositorioVendas`), caixa e o
      lote de auditoria (`OutboxSync`). Na transação do fato: sequência `evento`; hora do envelope = a do payload (os
      fatos do caixa usam o `RelogioCorrigido`, `agora_local + desvio`) com a monotonicidade de 2 min e
      `relogio_regrediu` quando não aplicada (colunas novas `eventos_saida.relogio_regrediu` e `dependencias`);
      `ocorrido_em_local`, desvio e `relogio_confiavel` (que a venda repete em `vendas.relogio_confiavel`, T5);
      `usuario_id`; `contexto` com a sessão e o `estoque_id` do espelho `lojas`. O envelope (`OutboxSync.Envelope`)
      lê as dependências gravadas. A hora do SO continua nos registros locais (logs, bloqueio de senha, backoff).
    - **T13** (o que a nuvem aceita): o handshake grava o `versoes_schema` em `estado_conexao.versoes_schema_nuvem`
      (vale offline) e o gravador recusa o tipo e a versão não anunciados com `RegraNegocioException` (nada do fato fica
      gravado): uma API sem o handler do `caixa.aberto` não recebe caixa, em vez de `SCHEMA_DESCONHECIDO` parar o lote
      (o motivo da D18). `auditoria.registros` e `terminal.configuracao_alterada` (da 1B) não dependem do anúncio; o
      terminal de demonstração, também não. A tela pergunta antes (`RepositorioCaixa.TipoAceitoAsync`). **Sem nenhum
      handshake desde a migração `TabelasCaixa`** (coluna nula: o terminal da 1B atualizado que reabre sem internet),
      todo tipo vale como aceito — **padrão até a confirmação do dono**: a implantação é sempre API primeiro (quando o
      PDV da 1C chega, a API já aplica `caixa.*` e `venda.*`) e o caixa nunca trava por falta de internet (O18). Se a
      API ainda não tiver o tipo, o evento fica pendente com `SCHEMA_DESCONHECIDO` (transitório) até ela ser
      atualizada; depois do primeiro handshake vale o anúncio. A alternativa recusada seria bloquear o caixa até o
      primeiro handshake (passo de implantação "abrir o PDV online uma vez depois de atualizar"). Testes:
      `GravadorOutboxTests` (envelope da fixture pelo push, dependência da sessão, abertura recusada sem anúncio e aceita
      depois do handshake com a API nova, abertura offline sem handshake nenhum, monotonicidade e regressão,
      `relogio_confiavel` da venda).
    - **`RepositorioCaixa`** repete as regras da nuvem que, recusadas lá, seriam permanentes: a abertura leva o
      movimento `abertura` no valor do `fundo_troco` (fundo 0,00 sem movimento; refinamento do
      `payloadCaixaAbertoSchema`, senão `PAYLOAD_INVALIDO` e a sessão inteira retida) e só sangria e reforço se cancelam
      (`TipoMovimentoCaixa.Cancelaveis`, a mesma lista do `MOVIMENTOS_CAIXA_CANCELAVEIS` do contrato, que o handler da
      nuvem usa e o `ContratosEventosTests` confere pela `eventos.conferencias.json`; senão `TRANSICAO_INVALIDA` e a
      gaveta estimada sem o fundo). A `FabricaEventosCaixa` recusa o mesmo. Testes: `RepositorioCaixaTests` (abertura
      fora do fundo, cancelamento de abertura/estorno/devolução e depois do fechamento recusados sem gravar nada,
      devolução avulsa de cascos gravando linha, evento e sequência num commit só na sessão aberta, CHECKs e FK de
      `movimentos_vasilhame` numa gravação real).
    - **`SessaoTerminal.Contexto()`**: sessão aberta (`CarregarSessaoCaixaAsync`, relida ao entrar na venda), fuso da
      loja (espelho `lojas`, depois `empresa`, depois Brasília) e a hora de corte do dia operacional
      (`geral.dia_operacional_hora_corte`, loja sobre empresa). **D7 (dono)**: corte às 05:00 na empresa, ajustável
      por loja; o padrão do catálogo (`packages/shared/src/configuracoes.ts`) passou de `00:00` para `05:00` e o PDV
      repete o mesmo padrão sem a chave no espelho (conferido pelo `CicloOnlineTests`). Teste: `SessaoTerminalTests`.
    - **D22 (dono)**: entre montar o heartbeat com `desativando_confirmado` e receber o `revogado`, nada que suba é
      gravado. A contagem do heartbeat roda numa transação `IMMEDIATE` (a gravação em voo comita antes e entra nos
      números finais) que marca `estado_conexao.confirmando_desativacao_em`; os gatilhos `BEFORE INSERT` de
      `eventos_saida` e `log_auditoria_local` (migração EF `TravaDesativacao`, separada da `TabelasCaixa` porque o EF
      recria as tabelas no fim da migração e o gatilho se perderia) recusam com `RAISE(ABORT)`, que o `PdvDbContext`
      traduz em `RegraNegocioException` com `TravaDesativacao.Mensagem`. Sem resposta, ou com status diferente de
      `revogado`, o ciclo limpa a marca e o heartbeat seguinte reconta; com `revogado`, ela fica. A marca que sobrou de
      um processo que caiu no meio é limpa no handshake e no início do laço (um semáforo impede que a limpeza cruze com
      a marcação). O ciclo publica `SituacaoSincronizacao.ConfirmandoDesativacao`: o logout e o Ctrl+Alt+C, que chegam
      com as telas do C10a, usam o sinal para avisar antes (o banco já os recusa). **Regra para as próximas
      migrações**: recriar `eventos_saida` ou `log_auditoria_local` (CHECK novo no SQLite) apaga o gatilho; recrie-o
      numa migração seguinte (o `MigracaoTabelasCaixaTests` confere no banco com todas as migrações). O caso inverso
      quebra a migração: recriar `estado_conexao` (a tabela do `WHEN` dos gatilhos) aborta no `RENAME` do EF ("no such
      table: main.estado_conexao", o SQLite revalida os gatilhos com `legacy_alter_table` desligado); essa migração
      começa com o `DROP TRIGGER` dos dois gatilhos (operação `Sql`) e a seguinte os recria. Testes: `CicloOnlineTests`
      (trava em voo recusa o logout, pelo gatilho de `log_auditoria_local`, e o fechamento do caixa aberto antes da
      desativação, que é permitido em desativação e por isso só o gatilho de `eventos_saida` recusa, pelo caminho
      repositório → `GravadorOutbox`, com `TravaDesativacao.Mensagem` e a sessão ainda aberta; sem resposta destrava e
      o logout entra na confirmação seguinte; revogado mantém; sobra limpa no handshake) e `MigracaoTabelasCaixaTests`
      (o SQL cru também é recusado; a recriação de `estado_conexao` como o EF faz quebra com os gatilhos e passa com o
      `DROP TRIGGER` antes).
    - Ficou para os próximos blocos: o fim da D18 com a venda real (C11a). As telas de abertura, fechamento cego e
      troca de turno, as permissões e a liberação por supervisor chegaram no C10a (decisão 52); F11, sangria, reforço,
      limite de gaveta e o heartbeat com sessão e gaveta, no C10b (decisão 53). O `vendas.sessao_caixa_id` não ganhou FK local (recriaria `vendas`) e o
      `RepositorioVendas` não confere a sessão: ela vem do `SessaoTerminal` (`CarregarSessaoCaixaAsync`) e é conferida
      pela nuvem; a conferência local (sessão aberta deste terminal no `EncerrarAsync`) entra com o C11a, junto com a
      abertura da venda exigindo a sessão (o C10a já atualiza o `SessaoTerminal` na abertura e no fechamento).

52. **Abertura, fechamento cego, troca de turno, permissões e liberação por supervisor** (bloco C10a da 1C; PDV 7.2,
    8.1–8.3, 21.2–21.4, 21.7, 31; dono, O3/D12; padrões O4 e O1b, roadmap D31).
    - **Fluxo do login** (`ShellViewModel.AposLoginAsync`, `ServicoCaixa.AposLoginAsync`): sessão do mesmo operador →
      venda; de outro operador → "O caixa está aberto por FULANO desde 08:02 — [1] troca de turno [2] operar no caixa
      dele [Esc] sair"; sem sessão → **abertura** (`AberturaCaixaViewModel`). Com `pdv.solicita_abertura_caixa`
      desligada o login abre a sessão sozinho (`abertura_automatica`, fundo herdado ou 0,00, sem pedir a permissão nem
      abrir a gaveta). A abertura automática recusada (desativação, tipo não anunciado) volta ao login com a mensagem.
      **Sessão nova bloqueada** (8.1): com `geral.ativa = false` (modo implantação, "Empresa em implantação") ou com
      `lojas.usa_pdv = false` no espelho da loja (sem a linha, não bloqueia), o login sem sessão fica no login com a
      mensagem e a tela de abertura relê as regras no Enter (`ServicoCaixa.GarantirAberturaPermitida`); a sessão já
      aberta segue até o fechamento.
    - **Abertura** (8.2; **O4, padrão até a confirmação do dono**: abertura obrigatória com o fundo contado): o campo
      começa vazio (Enter sem valor é recusado), salvo o valor deixado pela troca de turno (`RepositorioCaixa
      .TurnoHerdadoAsync`: o último fechamento deste terminal, se não zerou e nenhuma sessão nasceu dele). Contar outro
      valor pede um segundo Enter ("o valor contado difere do deixado pelo turno anterior") e grava
      `diferenca_recebimento`; a sessão nova leva `sessao_anterior_id` e `valor_recebido_anterior` e o `caixa.aberto`
      depende da anterior. **F2 Contar cédulas** (`ContagemCedulas`, 200 a 0,05) soma e preenche o fundo; o
      detalhamento vai no `contagem_cedulas` do evento (a nuvem guarda na auditoria `caixa_contagem_cedulas`). A
      observação vai no movimento `abertura` (com fundo 0,00 não há movimento, e ela não fica). Depois do commit:
      comprovante (com `pdv.imprime_sangria_automaticamente`) e gaveta. Esc sai (volta ao login).
    - **Sessão antiga** (8.1; **O1b, padrão até a confirmação do dono**: continua vendendo): faixa amarela "Caixa aberto
      desde 28/10 08:02 — faça o fechamento" depois de `pdv.horas_alerta_sessao` (24 h) ou de dia operacional anterior;
      com `pdv.bloqueia_sessao_dia_anterior` a de dia anterior recusa a venda nova (`ServicoVenda`, a em andamento
      termina) até fechar e abrir de novo (`RegrasSessaoCaixa.Avaliar`).
    - **Fechamento** (F11 › 3; 21.2; `FechamentoCaixaViewModel`): só com o caixa livre. A venda em andamento, em
      pagamento ou suspensa da sessão é conferida **no banco antes da contagem** (`PrepararFechamentoAsync` →
      `RepositorioCaixa.VendaPendenteAsync`, de qualquer operador: a que ficou de uma queda de energia também conta), com
      a D22; o commit repete a guarda. Se a gravação ainda recusar (a venda que apareceu depois, a D22 que começou
      durante a contagem, o tipo não anunciado), a máquina **não** fica confirmada: `FechamentoCego.Confirmar` só monta o
      fechamento e a tela chama `MarcarConfirmado` depois do commit, então o Enter seguinte tenta de novo sem recontar; na
      conferência, o Esc passa a sair depois de uma recusa (antes dela continua preso, o operador já viu o calculado), e o
      F4 só reconta com a máquina na conferência. Fora da contagem os valores ficam **só leitura** (o Enter da
      conferência grava o que foi contado). A forma **Dinheiro** sai das oferecidas na loja, dos pagamentos da sessão ou,
      sem elas, de qualquer forma do tipo dinheiro do espelho, mesmo inativa, excluída ou desvinculada no meio do turno (a
      nuvem tem a linha); sem nenhuma, a mensagem aponta o cadastro. A apuração (`ApuracaoCaixa`, Core) segue a 20.4/21.2
      só com os fatos da sessão: Dinheiro = gaveta (fundo + dinheiro − troco de outra forma + reforço − sangria −
      `sangria_fechamento` − `estorno_venda` em dinheiro − `devolucao_troca`); as outras formas = pagamentos aprovados
      das vendas **finalizadas na sessão** (mesmo canceladas depois) − o `estorno_venda` da forma (D24). Linhas:
      **Dinheiro sempre primeiro** (todas as formas do tipo dinheiro são a mesma gaveta), as formas oferecidas na loja
      (contagem por forma da O3, pega o pagamento lançado na forma errada) e as que tiveram movimento; vazio = 0,00.
      **D12/O3 (dono)**: `FechamentoCego` com `RegrasFechamento.PadraoDono` — ninguém vê o esperado no PDV (nem com
      `pdv.caixa.ver_calculado_fechamento`), sem conferência nem recontagem, o relatório só com o contado; a
      justificativa é **opcional e sempre oferecida** (pedi-la só com diferença revelaria que a contagem não bateu) e a
      diferença não bloqueia. **Chave nova `pdv.fechamento_mostra_conferencia`** (catálogo do shared, padrão `false`;
      `pdv.permite_recontagem` passou a `false`, como pediu o dono): ligada, volta o fluxo da especificação
      (conferência, justificativa acima de `pdv.tolerancia_diferenca_caixa`, F4 reconta uma vez com
      `valor_primeira_contagem`). F5 alterna o zera caixa; F3 conta as cédulas do dinheiro. A confirmação grava num
      commit fechamento, formas, `sangria_fechamento` (só ao zerar e com dinheiro contado, quem retira = o operador),
      sessão `fechada`, `caixa.fechado` (resumo com as chaves da SYNC 9.6 e `ultima_sequencia_evento` = a sequência do
      último evento gravado antes dele) e o `logout`; depois o relatório (21.4) e a gaveta; Enter volta ao login (o
      próximo operador entra por ele). O dia operacional do fechamento é o do `ocorrido_em` (MD 3.12.3).
    - **Troca de turno pelo próximo operador** (opção 1 do diálogo): ele fecha a sessão do anterior às cegas com o zera
      fixo em "não" (`usuario_anterior_id` = quem abriu; o próximo vira o `usuario_subsequente_id` quando a nuvem aplica
      o `caixa.aberto` dele), sem o `logout`, e segue para a própria abertura com o valor herdado. O `usuario_id` do
      envelope do `caixa.fechado` é **quem contou e confirmou** (SYNC 7.3, "quem executou"), e a auditoria da nuvem do
      fechamento fica com ele (`depois.usuario_anterior_id` = o dono da sessão). Venda pendente da sessão do anterior
      recusa antes da contagem com a mensagem própria ("escolha [2] Operar no caixa de FULANO para finalizá-la…"). A
      abertura automática recusada depois da troca (chave desligada) volta ao login com a mensagem, como no login.
      **Operar no caixa de
      outro** (opção 2) exige `pdv.caixa.operar_de_outro` ou a liberação; fica na auditoria local
      `caixa_operar_de_outro` (e na `liberacao`, que sobe).
    - **Permissões** (31.1): o login carrega as `pdv.*` efetivas (`AutenticadorOffline.PermissoesPdvAsync`: perfil ∪
      concedidas do usuário − negadas do usuário; Master tem todas) em `Operador.Permissoes`; os operadores de
      demonstração usam o perfil padrão "Operador de caixa" (`PermissoesPdv.PerfilOperador`, conferido contra
      `PDV_OPERADOR` do shared pelo `CicloOnlineTests`) e o CARLOS é Master. O caixa confere `pdv.caixa.abrir`,
      `pdv.caixa.fechar`, `pdv.caixa.operar_de_outro`, `pdv.caixa.ver_calculado_fechamento` (sem liberação) e o desconto.
    - **Liberação por supervisor** (31.3; `PedidoLiberacaoViewModel`, `AutenticadorOffline.LiberarAsync`): login ou
      código, PIN e motivo (1 a 255) de quem tem `pdv.supervisor` e a permissão da ação, ativo e da loja, nunca o próprio
      operador; só pelo PIN, offline, e o PIN errado conta no mesmo bloqueio local do login. Três recusas fecham o
      pedido. A liberação vale só para aquela ação: abertura e fechamento a gravam na auditoria `liberacao` do mesmo
      commit (com `autorizado_por_id` e o motivo); no desconto acima do limite (12.3), também o limite do supervisor
      precisa cobrir o pedido, a linha entra em `liberacoes` da venda (decisão 49) e o mesmo commit grava a auditoria
      `liberacao` no formato da fixture da SYNC 9.22 (`itens_venda`/`vendas`, `PDV › Desconto`, o valor no `depois`),
      que sobe no lote mesmo com a D18 segurando a venda. O **motivo sobe em `depois.motivo`** (`OutboxSync`, junto do
      que o `depois` já tiver): a auditoria da nuvem não tem coluna de motivo. As permissões efetivas são calculadas uma
      vez no login (`PermissoesPdvAsync`; a regra 5 confere `pdv.acesso.entrar` no mesmo conjunto) e as constantes vêm
      de `PermissoesPdv`.
    - **D22**: abrir e fechar avisam antes ("O terminal está confirmando a desativação…") quando o ciclo publica
      `ConfirmandoDesativacao`; o banco recusa de qualquer modo. O fechamento continua permitido em desativação.
    - Testes: `CaixaTests` (Core: gaveta e calculado, turno A × turno B da 21.7, O3, conferência e recontagem, sessão
      antiga, cédulas), `RepositorioCaixaTests` (apuração, venda aberta bloqueia, turno herdado), `LoginOfflineTests`
      (permissões efetivas e liberação), `CicloOnlineTests` (padrões das chaves e as permissões do shared) e
      `CaixaTelasTests` (abrir com o contador, vender e fechar às cegas; troca de turno com o herdado; sessão de outro
      operador; conferência ligada com justificativa e recontagem; abertura automática e bloqueio do dia anterior;
      liberação do desconto, com a auditoria `liberacao`; fechamento recusado no commit e o Enter seguinte; Esc e campos
      só leitura na conferência; troca de turno com venda pendente e a abertura recusada; empresa em implantação e loja
      sem PDV; Dinheiro desativado; liberação no caixa de outro, no fechamento e na abertura; chaves do resumo contra a
      fixture; o segundo Enter da diferença de recebimento). `LoginOfflineTests` confere o bloqueio local pelo diálogo
      de liberação e `CicloOnlineTests` o motivo em `depois.motivo`. `AmbienteUi.LogarAsync` passou a abrir o caixa com
      fundo 0 quando o login cai na abertura.
    - Fora deste bloco: F11 › 1/2/6/S/V, F12 Movimentos e o limite de gaveta (chegaram no C10b, decisão 53); a
      abertura da venda exigir a sessão e a venda real (C11a); o bloqueio de tela e a troca de operador por F11 › 0 (7.4).
53. **F11, sangria, reforço, movimentos, limite de gaveta, cascos, resumo diário e status do sync** (bloco C10b da 1C;
    PDV 10.12, 20.1–20.5, 21.6, 28.2, 30.2; SYNC 9.4, 9.5, 9.26, 10.1; dono, O5/D32, O14/D3 e O3/D12).
    - **Menu F11** (`DialogoFuncoesViewModel`): 1 Sangria, 2 Reforço, 3 Fechamento, 6 Resumo diário, S Status da
      sincronização e V Vasilhames; as demais teclas da 28.2 (4, 5, 7, 8, 9, 0) chegam com as telas delas. Sangria,
      reforço e cascos exigem o **caixa livre** (venda em andamento: "Finalize ou cancele a venda atual antes"); resumo e
      status abrem a qualquer hora. Toda função que grava confere antes a D22, a sessão aberta e o tipo anunciado pela
      nuvem (T13: `caixa.sangria`, `caixa.reforco`, `caixa.movimento_cancelado`, `vasilhame.movimentado`), e a função
      nem abre sem eles.
    - **Sangria e reforço** (`DialogoMovimentoCaixaViewModel`, `ServicoCaixa.RegistrarMovimentoAsync`; **O5 do dono**):
      o operador faz sozinho (`pdv.caixa.sangria`/`reforco` estão no perfil; sem elas, a liberação vira o
      `autorizado_por_id` e a auditoria `liberacao` do mesmo commit). Valor > 0, em centavos, até 99.999,99; na
      sangria, **quem retira é obrigatório** — o usuário do F2 (`BuscarUsuariosAsync`: ativos do espelho com vínculo
      na loja ou Master, sem totem; na demonstração, os operadores simulados), que grava `quem_retira_usuario_id` e o
      nome, cortado nos 60 do `quem_retira_nome` quando o do cadastro é maior (até 100 em `usuarios`; o id identifica,
      e o mesmo corte vale para a `sangria_fechamento`), ou o nome digitado (até 60) — e o valor **não passa do
      dinheiro estimado** (`pdv.sangria_limitada_ao_saldo`, ligada; desligada, passa com aviso). **Cada recusa acima do
      saldo grava a auditoria `sangria_recusada`** (`depois` com `valor_tentado` e `dinheiro_estimado`; ação nova em
      `ACOES_AUDITORIA` e no `CatalogosNuvem`, sobe no lote): com o estimado oculto (O3), a própria recusa diz ao
      operador que o valor passou do esperado, e as tentativas para localizá-lo ficam à vista do gerente no ERP; no
      reforço, quem entrega é opcional (as mesmas colunas, MD 3.12.2).
      Observação e inf. adicionais até 255. F3 conta as cédulas (o contador da abertura; o detalhamento vai no
      `contagem_cedulas`). O evento leva `dinheiro_estimado_antes`. Depois do commit: comprovante (com
      `pdv.imprime_sangria_automaticamente`) em **2 vias na sangria** ("1ª VIA - CAIXA", "2ª VIA - QUEM RETIRA", cada
      uma cortada, com as assinaturas do operador e de quem retira; `fila_impressao.vias = 2`) e 1 no reforço, a gaveta e
      a faixa. `pdv.sangria_exige_senha_quem_retira` não é lida (O5: quem retira só é informado). Sem limite de sangria
      no piloto (O5: `pdv.valor_limite_sangria` nulo) e sem sangria pelo ERP.
    - **F12 Movimentos** (20.3; `DialogoMovimentosViewModel`, a partir da sangria ou do reforço): os movimentos da
      sessão (abertura, sangria, reforço e os que chegarem), com o cancelado e o motivo; ↑/↓ escolhem, **Ctrl+Del**
      cancela só sangria e reforço, com motivo obrigatório (até 255). **Cancelar pede o supervisor** (O5):
      `pdv.caixa.cancelar_movimento` não está no perfil do operador, e o supervisor que libera vira o
      `autorizado_cancelamento_por_id`, com a auditoria `liberacao`; quem tem a permissão cancela sem autorizador. O
      cancelado sai do estimado na hora.
    - **Limite de gaveta** (20.4; `LimiteGaveta` no Core): `dinheiro_gaveta` é a linha Dinheiro do fechamento
      (`ApuracaoCaixa.DinheiroGaveta`, uma fórmula só; `RepositorioCaixa.DinheiroGavetaAsync` lê só pagamentos e
      movimentos). Com `pdv.valor_limite_sangria` > 0, faixa âmbar a partir de 80% e vermelha no limite; no vermelho,
      **nenhuma venda nova começa** (`ServicoVenda` confere ao abrir a venda; a em andamento termina) e a tela oferece a
      liberação do supervisor (`pdv.caixa.ignorar_limite_sangria`), que vale **uma venda** e fica na auditoria
      `liberacao` (entidade `sessoes_caixa`); quem tem a permissão não é bloqueado. A liberação guardada é da sessão
      **e do operador** que a pediu, e só enquanto a gaveta continua no vermelho: a apuração fora do bloqueio (a sangria
      que tira a faixa, um limite que sobe), o login seguinte e outro operador na sessão a descartam — a liberação das
      10h nunca cobre a venda das 16h. A sangria que leva abaixo do limite tira a faixa. A faixa é reapurada depois de
      abrir, de cada venda paga, de cada movimento e antes de cada venda nova, relendo as chaves (o pull pode mudar o
      limite no meio do turno). **O bloqueio é calculado, não gravado**: `sessoes_caixa.status` fica `aberta`
      (`bloqueada_sangria`, como o `em_fechamento` do C10a, é estado conceitual da PDV 34.2 e da MD 3.12.1, que agora o
      dizem; o CHECK mantém os valores). Padrão do dono (O5): sem limite.
    - **O estimado não aparece no PDV no fechamento cego** (decisão técnica derivada da **O3** do dono, que proíbe ver o
      esperado no PDV): o dinheiro estimado da sangria (o mock da 20.1 o mostra), o valor da faixa da gaveta e a
      mensagem da sangria acima do saldo só trazem o valor quando a regra do fechamento deixaria o operador ver o
      calculado (`ServicoCaixa.EstimadoVisivel` = `RegrasFechamento.VeCalculadoNaContagem`); no padrão do dono, nunca.
      Pela mesma razão, o **resumo diário sai sem os valores que compõem o esperado** (`ResumoDiario.ValoresOcultos`:
      total e ticket das vendas, valor por forma, totais de sangria e reforço zerados; ficam as quantidades, os
      cancelamentos, os itens cancelados e os descontos, com a linha "Fechamento cego: valores de vendas, sangrias e
      reforços só no ERP (gerente)") **em todas as sessões do período, a aberta e as fechadas**: depois do fechamento
      o operador tem o fundo e a própria contagem impressa, e as vendas por forma da sessão fechada dariam o esperado e
      a diferença que a O3 reserva ao gerente. A versão anterior deste bloco só tirava a sessão aberta ("entra depois de
      fechada"), o que reabria o esperado logo depois do fechamento. Isso estende a O3 à 21.6 (que mostrava os valores)
      e foi **confirmado pelo dono em 01/11/2026** (O26, opção (a): só quantidades; roadmap D33). Sem o fechamento cego
      (ou com a conferência e a permissão), tudo aparece.
    - **Resumo diário** (F11 › 6, 21.6; `ResumoDiario` e `PeriodoResumo` no Core): `pdv.relatorio.resumo_diario` (perfil)
      ou a liberação. `pdv.resumo_diario_modo` define o filtro: `intervalo_dias` (padrão; de/até em dias operacionais,
      cada um começando na hora de corte, D7; até 31 dias) ou `horario` (das/às dentro de um dia operacional; antes do
      corte é a madrugada seguinte). Só deste terminal: vendas finalizadas no período que continuam finalizadas, por
      forma (Dinheiro primeiro, o valor aplicado), canceladas no período (em andamento ou finalizadas antes), itens
      cancelados e descontos das vendas, sangrias e reforços não cancelados (os cancelados só contados). Enter mostra,
      Ctrl+P imprime (`fila_impressao` `resumo_diario`). Sem a permissão, a liberação do supervisor vale para o diálogo
      aberto (consultas e impressões até o Esc) e grava a auditoria `liberacao` (31.3) **uma vez**, na primeira
      consulta (`ServicoCaixa` guarda a última auditada, por referência: cada pedido ao supervisor é outra).
    - **Status da sincronização** (F11 › S, 30.2; `StatusDetalhadoSync`, GenesisPDV.Sync): o indicador da barra, o
      último pull com sucesso, o último push confirmado (a última confirmação de evento: o ciclo não grava
      `ultimo_push_sucesso_em`), o último heartbeat, o desvio do relógio, o cursor de cada fluxo, os pendentes por tipo,
      os eventos em quarentena (os 20 primeiros, com o erro), a fila de impressão e o último erro; Enter sincroniza agora
      e relê. A fila de NFC-e em contingência chega com a NFC-e (1D).
    - **Vasilhames** (F11 › V, 10.12; **O14 do dono**: na 1C só a entrada dos vazios): escolhe o casco (produtos do tipo
      `vasilhame` ativos, por nome — o casco genérico por tamanho serve para todas as marcas) e a quantidade inteira
      (1 a 9.999); grava `movimentos_vasilhame` destino `entrada` e o `vasilhame.movimentado` num commit (a nuvem gera o
      `VASILHAME_DEVOLVIDO`, C7). Não abre a gaveta nem imprime. O desconto na venda atual pelo valor do casco chegou no
      C11c (decisão 56).
    - **Heartbeat** (SYNC 10.1, 21.1): passa a levar `sessao_caixa_id` (a sessão aberta do banco local) e
      `dinheiro_estimado_gaveta` (o mesmo cálculo do limite, com sinal) — a nuvem já guardava os dois em `terminais` e
      o T12 cuida da disputa com o `caixa.fechado`.
    - Testes: `MovimentosCaixaTests` (Core: faixas e o valor oculto, valor, sangria acima do saldo, quem retira,
      motivo, o nome do usuário cortado, a gaveta igual à linha Dinheiro, períodos por dias e por horário, o resumo com os
      valores ocultos),
      `RepositorioCaixaTests` (estimado = apuração, auditoria no commit da sangria, só sangria/reforço avulsos, movimentos
      da sessão, resumo filtrado no SQLite), `CicloOnlineTests` (heartbeat com a sessão e a gaveta, status detalhado com
      pendentes, push confirmado e quarentena; padrões das chaves novas e as permissões contra o shared) e
      `MovimentosCaixaTelasTests` (sangria com quem retira pelo F2, recusa acima do saldo sem o valor, 2 vias e o
      evento; reforço; F12 Movimentos com Ctrl+Del, motivo e a liberação do supervisor como autorizador; caixa livre;
      limite de gaveta âmbar e vermelho, venda nova recusada, liberação de uma venda e a sangria que desbloqueia; a venda
      em andamento que termina com o limite atingido no meio dela, a liberação que cai fora do vermelho, no login e com
      outro operador, e o supervisor com `ignorar_limite_sangria` sem bloqueio; a sangria recusada na auditoria e, com a
      chave desligada, a que passa com aviso e o nome longo do F2 cortado; resumo sem os valores no fechamento cego,
      também depois de fechar, e com eles sem o cego, por horário e impresso, no dia operacional da venda — não no do
      relógio, que cruzaria as 05:00 —, e a liberação do resumo auditada uma vez; status do sync; devolução de cascos).
    - Fora deste bloco: a venda real (C11a) e o desconto pelo valor do casco (C11c, decisão 56); o cancelamento da venda finalizada com o
      `estorno_venda` e a gestão de vendas (F12 da tela de venda, C11b); a senha de quem retira e o comprovante do
      cancelamento de sangria (sem pedido do dono); a abertura avulsa da gaveta (F11 › 9) e as demais teclas do F11.

54. **Venda real: fim da D18, formas da loja, maquininha, PIX estático, CPF/cliente, saldo e tempo offline** (bloco C11a
    da 1C; PDV 8.1, 10.9.2, 10.11, 14.1–14.2, 16.1–16.7, 19.2, 29.1, 30.6; SYNC 9.7, 15.2; dono, D17, D18, D25–D30, O7,
    O9b/O9c, O18, O20, O21; decisões técnicas T13 e T18).
    - **Fim da D18** (`ServicoVenda`): sai a guarda `GarantirVendaCompleta`; o terminal ativado paga e finaliza, e o
      cancelamento em andamento (Shift+F4) gera o `venda.cancelada` forma B. Se a nuvem ainda não anunciar o
      `venda.cancelada` (API entre o C6b e o C7, só em homologação), cancela como na 1B — sem evento, com a auditoria
      `cancelar` — para o caixa não ficar preso na venda. O `TelasTests` passou a esperar a venda concluída no terminal
      real, com o cupom da loja e os eventos `venda.finalizada`/`venda.cancelada` dependentes da sessão.
    - **Abertura da venda** (8.1, 8.3): nenhum item entra sem o caixa aberto (`MensagemCaixaFechado`) nem com o
      `venda.finalizada` não anunciado pela nuvem (T13), e as duas recusas vêm **antes** de reservar o número, como a
      regra do item. O `RepositorioVendas.EncerrarAsync` confere, quando há evento, que a sessão da venda continua aberta
      neste terminal (`MensagemSessaoDaVendaFechada`; a venda de uma sessão fechada subiria fora do fechamento contado).
    - **Venda da 1B sem sessão** (revisão do C11a): o terminal real da 1B montava venda sem caixa (D18) e ela volta na
      recuperação com `sessao_caixa_id` nulo — a nuvem recusaria o `venda.finalizada` e o `venda.cancelada` B sem a
      sessão (`PAYLOAD_INVALIDO`). Com o caixa aberto e sem pagamento (a D18 não deixava pagar), a recuperação a inclui
      na sessão aberta (`Venda.VincularSessaoCaixa`, gravado antes de seguir; a auditoria `venda_recuperada` o diz); sem
      isso, F10 e a finalização recusam (`MensagemVendaSemSessao`) e o cancelamento sai **sem evento**, com a auditoria
      `cancelar`, como o de uma venda cuja sessão não é mais a aberta — o caixa nunca fica preso numa venda órfã.
    - **Formas de pagamento** (16.1; C8b): `ServicoVenda.FormasPagamentoAsync` lê o espelho da loja
      (`CatalogoLocal.FormasPagamentoAsync`) e mapeia para `FormaPagamentoInfo` (integração, "exige supervisor" ou
      senha de liberação, QR do PIX, parcelas, exige pessoa). `RegrasFormaPagamento.Fluxo` decide como lançar: direto
      (dinheiro, VA/VR, "outros"), **maquininha** (cartão sem integração ou `pos_externo`) ou **PIX manual** (tipo PIX
      ou integração PIX; o PIX dinâmico da Fase 6 cai na confirmação manual, o fallback da 16.7); TEF, crediário,
      crédito funcionário, vale, boleto, cheque e consumo interno ficam fora da lista (PDV-2 e Fase 6). Várias formas na
      mesma venda, até 10. A tela: ↑/↓ ou Alt+1..9 escolhem a forma, o valor vem com o saldo (0,00 na "sempre
      zerado"), Enter lança, Del remove o último, F5 identifica o cliente.
    - **Troco** (16.4; O23/D30): `FormaPagamentoInfo.DaTroco` — só a forma com "dá troco", sem integração e fora de
      cartão e PIX (a marca num cartão de cadastro antigo não faz o cartão passar do total). A gaveta abre na
      finalização com troco ou com algum pagamento de forma "Abrir gaveta" (só PIX e cartão: não abre, 16.12).
    - **Maquininha** (16.5; **O9c, padrão aplicado até a confirmação do dono**): "Passe o cartão na maquininha.
      Aprovado?" — Enter com a **bandeira obrigatória** (o código `tBand` da lista), NSU/CV (até 12 dígitos) e
      autorização (até 6) opcionais, parcelas informativas no crédito com "Permite parcelar"; grava `tipo_integracao =
      2`, `bandeira`, `bandeira_nome`, `nsu`, `autorizacao` e `parcelas`; Esc volta ao pagamento sem lançar. O
      cupom mostra a bandeira ao lado da forma.
    - **PIX estático/manual** (16.7; **O9b, padrão aplicado até a confirmação do dono**: a confirmação sempre pede o
      supervisor, `pdv.pix_manual_exige_supervisor` ligada): `PixEstatico` (Core) monta o BR Code (EMV, CRC16/CCITT) com
      a chave, o recebedor e a cidade da loja (`lojas.chave_pix`, `pix_nome_recebedor`, `pix_cidade_recebedor`), o
      valor e o `txid` = número da venda sem hífens, offline; a tela mostra o QR (`QrPix`, pacote QRCoder) e o "copia e
      cola" — na forma com "Gera QR Code Pix" (ou integração PIX estático) e com a chave na loja; sem isso, confirmação
      manual sem QR. O operador confere no app/extrato do banco da loja e informa o nome de quem pagou e o horário
      (`RegrasFormaPagamento.HorarioDoBanco`: o horário à frente do relógio é da véspera só perto da meia-noite — a
      véspera fica até 2 h antes do relógio, como o PIX das 23:58 confirmado às 00:03 —; fora disso, mais de 5 min à
      frente é recusado, e o horário mais de 30 min anterior ao início da venda também: o `paga_em` errado não casaria
      com o extrato na conciliação). A cobrança vira uma linha de `cobrancas_pix` (`estatico`, `paga`, `pagador_nome`, `paga_em`) ligada ao
      pagamento (`pix_cobranca_id`), gravada no mesmo commit da venda (tabela local nova, migração EF `CobrancasPix`,
      conferida pelo `EsquemaNuvemTests`), e sobe no `venda.finalizada`; o pagamento removido ou a venda cancelada
      deixa a cobrança `cancelada`. Auditoria `pix_confirmado_manual` (ação nova em `ACOES_AUDITORIA` e no
      `CatalogosNuvem`, com nome, horário, valor e `txid` no `depois`), para a conciliação do ERP (Fase 4).
    - **Liberação da forma** (16.2, 31.3): a confirmação do PIX (com a chave ligada, ou quando o operador não tem
      `pdv.pagamento.confirmar_pix_manual`) e a forma com "exige supervisor" ou senha de liberação (C8b; o supervisor
      precisa de `pdv.pagamento.forma_com_senha`; a senha própria da forma fica para quando houver pedido) pedem o
      supervisor; uma liberação cobre as duas, mas as regras se somam: quem libera o PIX de uma forma com "exige
      supervisor" precisa das duas permissões (`ServicoVenda.PermissoesParaLancar`; o diálogo pede a da forma e o
      lançamento confere todas, sem confiar só na tela). Ela vira o `autorizado_por_id` do pagamento, uma linha de `liberacoes`
      (ações novas `pix_manual` e `forma_pagamento`, em `ACOES_LIBERACAO_VENDA`, `AcaoLiberacao` e
      `eventos.conferencias.json`) e a auditoria `liberacao` (`pagamentos_venda`, `PDV › Pagamento`) do mesmo commit.
    - **CPF na nota e cliente** (14.1–14.2; O8/D26): **F5**, opcional e só quando o cliente pede — o fluxo padrão não
      pergunta nada, e `pdv.pergunta_cpf_na_finalizacao` passou a `false` no catálogo do shared. CPF/CNPJ com ou sem
      máscara, com os dígitos verificadores conferidos (`CpfValidador`/`CnpjValidador`); se for de uma pessoa ativa do
      espelho, a venda leva também o `cliente_id` (a nuvem cria a relevância `compra`); a busca acha o cliente por nome,
      apelido, CPF/CNPJ ou código (inativo aparece e não é escolhido). Ctrl+Del tira a identificação. O cupom mostra o
      documento e o nome na nota; o cadastro no caixa é da 1D. Com um pagamento ativo de forma que **exige pessoa**
      (16.2), o cliente não sai nem é trocado (remova o pagamento antes), e a finalização confere de novo — o devedor
      não se perde no `venda.finalizada`.
    - **VA/VR e a idade mínima** (MD 3.10.1; ERP 10.2; revisão do C11a): a forma com `restringe_idade_minima` só paga
      até o `valor_liquido` dos itens ativos sem `idade_minima` (`ProdutoVenda.IdadeMinima`, no snapshot), menos o que
      outras formas restritas já pagaram — "Vale Alimentação não pode pagar bebida alcoólica: máximo R$ 20,00" — e a
      finalização confere de novo. A restrição e o "exige pessoa" ficam no `PagamentoVenda` e, sem coluna própria em
      `pagamentos_venda`, voltam do espelho da forma na venda recuperada. No piloto o VA/VR está desligado (O9a).
    - **Comprovante** (19.2): cabeçalho do espelho `lojas` (nome fantasia, razão social, CNPJ com máscara, IE,
      endereço com o município, telefone e a frase do rodapé), com a `empresa` nos vazios (`ConsultasVendaLocal
      .DadosLojaAsync`); a demonstração, sem a linha da loja, segue com os dados de exemplo.
    - **Ficha técnica** (10.9.2; D17): o produto `produzido` traz a ficha do espelho `produtos_componentes`
      (`ProdutoVenda.FichaTecnica`, no snapshot da primeira inclusão) e o item leva `componentes_estoque` com os insumos
      × quantidade × (1 + perda), em 3 casas, `origem = ficha_tecnica` (`Venda.ComponentesEstoque`); o `simples` com ficha
      não baixa insumo. Nova fixture `venda.finalizada.formas.payload.json` (maquininha, PIX com a cobrança e a
      liberação, CPF/cliente e o produzido), gerada pela `FabricaEventos` e passada pelo zod.
    - **Saldo estimado** (SYNC 15.2; PDV 29.1; **O15/D27**): `ConsultasVendaLocal.SaldosEstimadosAsync` = saldo do
      espelho `saldos_estoque` (estoque da loja; sem a linha cujo tipo está não vendável no espelho `tipos_estoque`, que
      saiu do filtro do pull mas não sai do espelho sem a sombra da 6.11 — Fase 2, F2-B7; README da API › decisão 152)
      − as baixas dos `venda.finalizada` deste caixa ainda não refletidos
      (refletido = confirmado e cursor `estoque` ≥ `versao_nuvem_fim`, ou a linha com versão acima de `versao_nuvem`;
      rejeitado conta, descartado no ERP não; a baixa vem do payload, com os insumos do produzido); a venda em andamento
      entra por `Venda.BaixasEstimadas`. Saldo negativo na inclusão: **aviso âmbar** (faixa própria, a venda segue) — o
      padrão do dono. Com `pdv.bloqueia_venda_sem_estoque` ou `vendas.valida_estoque` ligada e online (offline só com
      `pdv.bloqueio_estoque_offline`), a inclusão é recusada **antes de reservar o número** e a tela pede o supervisor com
      `pdv.venda.vender_sem_estoque`, que libera o produto naquela venda (auditoria `liberacao`, gravada **antes** de
      liberar: se ela falha, nada fica liberado). A liberação é amarrada ao login do operador e à venda — a da tela, ou,
      quando o bloqueio foi no primeiro item, a próxima que esse login abrir com o produto; a venda que abre sem ele,
      outro login e o fim da venda a descartam, e ela nunca passa para outra venda sem o supervisor. Combo e produzido não
      têm saldo próprio; produto sem `controla_estoque` nunca avisa. A demonstração não tem estoque e não confere.
    - **Tempo máximo offline** (30.6; **O18 do dono: sem limite**): `pdv.dias_max_offline` passou a nula no catálogo; o
      PDV a lê (`ObterInteiroOuNuloAsync`) e, preenchida, recusa a venda nova além do prazo, com `TempoOffline`:
      `max(maior_hora_vista − último pull de acesso/configuração, segundos offline acumulados)`, sem confiar no relógio do
      Windows. Os segundos acumulados ainda não são somados pelo ciclo (ficam 0) e a extensão por 24 h
      (`pdv.offline.estender`) não existe: com a chave nula do dono nada disso atua.
    - **Preço** (11.3; **O7 do dono, confirmado**): a faixa por quantidade da loja prevalece sobre a da empresa quando
      existe, mesmo mais cara (o `MotorPreco.Faixa` de sempre); "menor preço vence" só entre mix e atacado.
    - **Maioridade e horário restrito** (10.11; **O20 e O21 do dono**): não entram na 1C nem como padrão —
      `pdv.confirmacao_idade` passou a `desligado` no catálogo, `vendas.idade_confirmada_por_id` fica nulo, e o espelho
      `restricoes_horario_venda` desce mas não é lido (nenhuma loja tem horário proibido).
    - **Vendedor** (O24/D28): `vendedor_id` nulo, sem comissão.
    - Testes: `VendaRealTests` (Core: troco O23, fluxos, maquininha, PIX e a cobrança, liberação da forma, CPF/cliente,
      ficha técnica, BR Code e CRC16, horário do banco, saldo e tempo offline), `VendaRealDadosTests` (POS e PIX voltam
      depois de uma queda, encerramento só na sessão aberta, saldo estimado, dados da loja, busca de cliente e ficha do
      espelho), `ContratosEventosTests` (a fixture nova), `GravadorOutboxTests` (a venda da sessão aberta),
      `VendaRealTelasTests` (débito + PIX com o QR e o supervisor sem abrir a gaveta, cartão acima do total recusado, F5
      com CPF inválido, cliente vinculado e a busca, venda recusada sem caixa sem gastar número) e `TelasTests`
      (venda real concluída e cancelada com evento; bloqueio de estoque ligado pedindo o supervisor sem gastar número,
      liberado pelo supervisor do perfil padrão e descartado no fim da venda e em outro login; o PIX liberado pelo
      supervisor não Master e as duas permissões somadas; o PIX sem liberação com a chave desligada e o operador com a
      permissão; os dois ramos do T13; a venda da 1B sem sessão). Na revisão do C11a: VA/VR × idade mínima, exige
      pessoa, horário do PIX à frente e anterior à venda (Core) e a ficha, a idade e as regras da forma depois de uma
      queda (Data).
    - Fora deste bloco: o **desconto na venda atual pelo valor do casco** (O14; chegou no C11c, decisão 56) e o cancelamento da venda finalizada com o estorno por forma e a gestão de
      vendas (F12) vão para o C11b; a impressão do QR do PIX (`pdv.imprime_qr_pix`), o troco máximo
      (`pdv.troco_maximo`), a pergunta do CPF na finalização (chave desligada pelo dono) e a "exibe estoque na busca"
      ficam sem pedido; o cadastro rápido de cliente é da 1D.

55. **Cancelamento da venda paga, gestão de vendas (F12) e reimpressão** (bloco C11b da 1C; PDV 13.2, 13.3, 20.4,
    21.2, 22.1, 22.2; SYNC 8.5, 9.9 A, 15.2; dono, D23/O6, D24/O22, D29/O25; decisão técnica T13).
    - **`Venda.CancelarFinalizada`** (Core): só a venda `finalizada` **da sessão de caixa aberta** (O6;
      `Venda.MensagemCancelamentoForaDaSessao` — a de sessão fechada só o ERP cancela, Fase 3), motivo livre de 15 a
      255 (`Venda.ValidarMotivoCancelamento`, o mesmo do Shift+F4). Cada pagamento aprovado volta como o operador
      escolheu (`RegrasEstorno.Opcoes`, a primeira é o padrão; as combinações são as que o `estornosInvalidos` da nuvem
      aceita): dinheiro → `dinheiro_devolvido` ou `dinheiro_nao_devolvido`; cartão e VA/VR → `pos_cancelado_na_maquininha`
      ou `devolvido_em_dinheiro`; PIX → `pix_devolucao_manual` (a cobrança fica `devolvida`) ou `devolvido_em_dinheiro`;
      "outros"/personalizadas → `credito_cancelado` (a prazo) ou `devolvido_em_dinheiro`. Fica `estornado` e os
      efetivados viram **uma linha `estorno_venda` por forma** na ordem dos pagamentos, a devolução em dinheiro de cartão
      ou PIX na forma Dinheiro da loja (O22, D24). Totais, itens, `finalizada_em` e o dia operacional não mudam (o
      documento é imutável; o estoque é da nuvem, SYNC 10.4). TEF e PIX pela API (Fase 6/PDV-2) e o vale (Fase 3) ficam
      de fora; o `pix_devolucao_pendente` não é oferecido (o gerente está no caixa para liberar; sem devolver agora,
      escolhe o dinheiro).
    - **Banco e evento**: `RepositorioCaixa.CancelarVendaFinalizadaAsync` grava só as colunas de cancelamento, o
      `estornado` dos pagamentos, a cobrança PIX (`devolvida`, com `valor_devolvido` = o valor e `devolvida_em` = a hora
      do cancelamento, como a nuvem grava no `cancelamento.ts`) e os `estorno_venda` (`RepositorioCaixa.LinhasEstorno`: operador = quem
      cancelou, `autorizado_por_id` = o gerente, "Estorno da venda L01-C02-…") com o `venda.cancelada` forma A
      (`FabricaEventos.VendaCanceladaFinalizada`) e a auditoria num commit, conferindo de novo dentro da transação a
      sessão aberta, a venda ainda finalizada e da sessão. O evento: agregado `venda`, quem cancelou no `usuario_id`, a
      sessão do cancelamento no contexto, **dependências da venda e da sessão** (o `venda.finalizada` retido retém o
      cancelamento, SYNC 8.5), `transacoes_tef` vazio. A reconferência recusa também a venda cujo `venda.finalizada`
      foi **descartado no ERP** (`resultado.descartado`, `ConsultasVendaLocal.FinalizadaDescartadaAsync`;
      `Venda.MensagemCancelamentoDescartada`): a nuvem não tem a venda e o cancelamento viraria `TRANSICAO_INVALIDA`
      (ou `DEPENDENCIA_DESCARTADA`), mais um item na fila de decisão, com a saída de gaveta que nunca chega à nuvem; a fábrica recusa o que o zod recusaria (`estorno_venda` sem
      estorno efetivado, de outra sessão ou sem a forma) e a forma B passou a recusar a venda paga. O
      `ContratosEventosTests` gera exatamente `venda.cancelada.finalizada.payload.json` (a fixture do C4 não mudou).
    - **Gaveta e fechamento** (20.4, 21.2): o pagamento `estornado` **continua somando** na sessão em que foi pago
      (`DinheiroGavetaAsync` e `ApurarAsync` passaram a ler `aprovado` e `estornado`) e o estorno subtrai pela linha
      `estorno_venda` — só a da forma Dinheiro sai da gaveta; o cartão cancelado na maquininha zera na linha dele e o
      cartão devolvido em dinheiro fica no calculado da forma (a credenciadora ainda paga, O22). Sem isso o estorno saía
      duas vezes. A exceção é o **lançamento a prazo cancelado** (`credito_cancelado` em forma com `lanca_quitada =
      false`: crediário, fiado e "outros"/personalizadas a prazo; `EstornoPagamento.SaiDoCalculado`): não gera linha e
      nada dele fica no caixa (a conta a receber é cancelada), então o `ApurarAsync` o **tira do calculado da forma** —
      sem isso o fechamento cego (O3) mostraria ao gerente uma falta igual ao valor. O banco local guarda só o
      `estornado`; o estorno escolhido vem do payload do `venda.cancelada` forma A no outbox
      (`pagamentos_venda[].estorno`; o outbox não é expurgado). Continuam somando o `dinheiro_nao_devolvido` e o
      `credito_cancelado` da forma quitada (o valor ou o documento fica na gaveta) e o a prazo devolvido em dinheiro (a
      linha sai da forma Dinheiro). No `DinheiroGavetaAsync` nada muda: o lançamento a prazo não é dinheiro e o troco
      dele saiu da gaveta de qualquer jeito. A gaveta abre depois do commit quando sai dinheiro, e a faixa do limite
      acompanha.
    - **Cascos** (D29, confirmada pelo dono): com `pdv.cancelamento_devolve_vazios` (padrão ligado,
      `ChavesConfiguracao.CancelamentoDevolveVazios`) a tela mostra "Devolva ao cliente N casco(s) de <casco>" com os
      vazios do bloco `vasilhames` (`Venda.VaziosTrazidos`; o casco do produto cheio vem do espelho, porque o snapshot
      da venda é apagado no encerramento); desligada, nada é dito (a nuvem também não estorna a entrada).
    - **Saldo estimado** (SYNC 15.2): o `venda.cancelada` ainda não refletido devolve ao estimado o que o
      `venda.finalizada` da mesma venda baixou (o payload da forma A não traz itens); a forma B não baixou nada.
    - **Telas**: F12 (fora da sangria) abre a **Gestão de vendas** da sessão aberta (`pdv.venda.consultar`, no perfil do
      operador; sem ela, a liberação): a mais nova primeiro, filtro pelo número ou CPF/CNPJ, as canceladas com o motivo e
      o número novo quando a nuvem renumerou a venda ("Aplicar com novo número", T27, lido do `resultado` do
      `venda.finalizada`). O filtro casa o **número inteiro**: o `numero_exibicao` completo (sem diferenciar maiúsculas),
      ou o texto só de dígitos igual ao número com ou sem os zeros ("13", "000013") — nunca os dígitos da loja e do caixa
      do prefixo "L01-C02" nem um pedaço do número —, o do caixa ou o novo da nuvem (o que o ERP imprime); o CPF/CNPJ
      casa com ou sem a máscara. Enter mostra os detalhes; **Ctrl+R reimprime** (22.2: o conteúdo original da
      `fila_impressao`, ou gerado de novo se o comprovante não saiu, precedido de "2ª VIA - REIMPRESSÃO dd/mm hh:mm" —
      hífen, a página 860 não tem o travessão —, na fila como `cupom_reimpressao`, auditoria **`reimpressao`**, ação nova
      em `ACOES_AUDITORIA` e no `CatalogosNuvem`; a cancelada não se reimprime); **Ctrl+Del cancela** a venda paga: o
      diálogo lista os pagamentos com a devolução (F2 passa ao próximo, F3 alterna), "Sai da gaveta: R$ …", os cascos e
      o motivo; Enter grava — quem não tem `pdv.venda.cancelar_venda_finalizada` (no seed, o gerente e o encarregado:
      O6 e decisão 78) pede a liberação de quem a tem, que vira o `cancelamento_autorizado_por_id`, o
      `autorizado_por_id` dos estornos e a
      auditoria `liberacao` do mesmo commit. A lista volta com as instruções ("Devolva ao cliente R$ …", "cancelado na
      maquininha", os cascos). F11 › 4 reimprime e F11 › 5 cancela a última venda paga da sessão. O cancelamento pede
      o caixa livre (a gaveta abre), fora da confirmação da desativação (D22), com o `venda.cancelada` anunciado (T13:
      o estorno nunca fica sem evento) e com o `venda.finalizada` não descartado no ERP; a reimpressão vale também com
      uma venda em andamento.
    - **Shift+F4** (13.2; O6): o motivo fixo saiu — o diálogo pede o texto livre (15 a 255) e, sem
      `pdv.venda.cancelar_venda_aberta` (fora do perfil do operador), a liberação do supervisor **antes** do motivo; quem
      liberou vai no `cancelamento_autorizado_por_id` da forma B e na auditoria `liberacao`. O
      `ServicoVenda.CancelarVendaAsync` confere a permissão também (sem ela e sem a liberação,
      `ServicoCaixa.MensagemSemPermissao`), como o cancelamento da venda paga e a reimpressão, sem confiar só na tela; os
      testes que cancelam direto pelo serviço logam um operador com a permissão, e o e2e PDV ↔ API cria o operador com o
      perfil `supervisor_caixa`.
    - Testes: `CancelamentoFinalizadaTests` (Core: padrões por forma, linhas por forma, devolução em dinheiro somando na
      linha Dinheiro, apuração com o estorno uma vez, valor não devolvido e fiado sem movimento, recusas de sessão,
      motivo, estorno e status, vazios), `CancelamentoFinalizadaDadosTests` (commit só das colunas de cancelamento, gaveta
      e resumo, segunda tentativa recusada, venda de outra sessão — pela sessão não aberta e pela linha do banco gravada
      noutra sessão —, venda descartada no ERP, PIX devolvido com a hora e o valor, fiado cancelado fora do calculado
      com o cheque quitado e o fiado devolvido em dinheiro somando, filtro pelo número inteiro com 1, 2 e 13 e o número
      novo da nuvem, saldo estimado com o cancelamento pendente, refletido pela linha e refletido pelo cursor),
      `ContratosEventosTests` (a fixture da forma A) e `GestaoVendasTelasTests` (venda paga no débito e em dinheiro
      cancelada com o débito devolvido em dinheiro e a liberação, evento e dependências, gaveta e fechamento; cascos
      devolvidos pelo F11 › 5 com o gerente logado; reimpressão pelo F11 › 4 e o filtro; Shift+F4 com o supervisor e o
      motivo livre; as recusas do serviço: caixa ocupado, cancelamento em andamento sem a permissão, D22 e venda
      descartada, sem gravar nada) e `TelasTests` (terminal real sem o `venda.cancelada` anunciado não cancela a venda
      paga).
    - Fora deste bloco: o **desconto na venda atual pelo valor do casco** (O14; o C11a o mandou para cá, mas o plano do
      C11b não o traz: chegou no bloco próprio C11c, decisão 56); o comprovante impresso do cancelamento (sem pedido do dono); a lista "hoje/data/
      cliente/status" da 22.1 além do filtro por número ou documento, o "Todas as lojas/caixas" online, o comprovante TEF
      e o cupom de troca (Fase 6 e Fase 3); o cancelamento fiscal (110111, Fase 3F).

56. **Desconto na venda atual pelo valor do casco** (bloco C11c da 1C; PDV 10.12, 12.3, 13.3, 19.2; SYNC 9.7, 9.26; MD
    3.11.2; dono, D3/O14 e D29/O25; decisão técnica T29).
    - **Regra** (`Venda.DescontarCascos`, Core): o cliente trouxe cascos vazios **além** dos devidos pelos itens (o casco
      excedente) e quer o valor deles nesta compra. Cada casco genérico (O14: por tamanho, para todas as marcas) entra
      como um `CascoDescontado` — quantidade inteira × o preço do casco (`MotorPreco.PrecoSemQuantidade`, o mesmo do
      casco cobrado, sem atacado; fixado na primeira vez, como o snapshot da 11.3). A quantidade **substitui** a anterior
      do mesmo casco e 0 tira o desconto dele. Recusa: venda sem item, em pagamento ou com pagamento lançado (como os
      demais descontos), produto que não é `vasilhame`, casco sem preço, o mesmo casco ainda **cobrado** num item cheio
      (os trazidos vêm antes: o desconto é só para o que passa dos devidos) e o crédito que, **somado ao desconto no
      total do operador**, passaria do total da venda (cada item fica com ao menos R$ 0,01): a recusa diz quanto ainda
      cabe em cascos e manda reduzir ou tirar o desconto no total (F6 › 4) ou registrar o resto só como entrada dos
      vazios — a mesma recusa da ordem inversa (desconto no total depois dos cascos), sem o recálculo tirar em silêncio
      o desconto do operador, liberado ou não. O inverso também: com o casco descontado, os "Cascos trazidos" de um item
      cheio do mesmo casco não aceitam faltantes (cobrar e descontar o mesmo casco na venda).
    - **Cheio depois do desconto** (`Venda.AbaterDescontadosPelosDevidos`): incluir (ou aumentar) um item cheio do
      mesmo casco já descontado usa primeiro os vazios descontados — eles estão no balcão: os novos devidos passam a
      trazidos e o desconto diminui (5 descontados + 2 cervejas = 2 trazidos + 3 descontados, R$ 7,50), com aviso
      ("N casco(s) … passaram a trazidos do item S"). Sem isso o "Cascos trazidos", que com o casco descontado só aceita
      todos os devidos, contaria os mesmos vazios duas vezes (estoque `vasilhame_vazio` e crédito a mais). O diálogo
      mostra os que sobraram no desconto ("N casco(s) … descontado(s) nesta venda, além destes"); se o cliente trouxe
      outros vazios, o operador desconta de novo no F11 › V.
    - **Permissão e teto** (`ServicoVenda.DescontarCascosAsync`; roadmap D38, **decidida pelo dono em 03/11/2026: R$ 50,00 serve**):
      aumentar o crédito exige `pdv.venda.desconto_total` (no perfil do operador; sem ela, o supervisor libera) e, acima
      de `pdv.desconto_cascos_max_sem_supervisor` (**R$ 50,00 por venda** no padrão, por loja; 0 = sem teto), a
      liberação do supervisor — com ela o operador não zera a venda com vazios que não existem. O serviço confere, sem
      confiar só na tela; reduzir ou tirar não pede nada. A liberação vira a linha `desconto_cascos` de `liberacoes`
      (item e % nulos; `ACOES_LIBERACAO_VENDA` e `AcaoLiberacao`) e a auditoria `liberacao`, que sobem; o operador e o
      crédito já sobem na própria venda (`operador_id`, `desconto_total` de origem `cliente`, `devolvidos`). O crédito
      continua fora do limite de % do operador (é do cliente).
    - **Contrato sem mudança (T29)**: nenhuma chave nova. O crédito vai no `desconto_total` (rateado nos itens como o
      desconto no total, 12.4; a NFC-e da 1D o leva no `vDesc` dos itens) e os vazios nos `devolvidos` do bloco
      `vasilhames` (a nuvem já dava a entrada `VASILHAME_DEVOLVIDO` no tipo `vasilhame_vazio`, C6b; a SYNC 9.26 já dizia
      que o desconto não usa o `vasilhame.movimentado`). `desconto_total_origem` = `cliente` quando o desconto é só o dos
      cascos (o valor do MD que não conta no limite do operador, 12.3); com o desconto no total do operador por cima, os
      dois **somam** no `desconto_total` e a origem é `operador`. `desconto_total_pct` vai nulo sempre que há crédito de
      cascos (`Venda.DescontoTotalPctDocumento`: o total deixou de ser aquele % da venda); o banco local guarda o % do
      operador para a venda recuperada refazer a parte dele. Um PDV com o C11c fala com a API anterior sem nada novo:
      nenhum tipo, versão ou campo novo, então a T13 não muda. A nuvem confere as somas como sempre (sem
      `VENDA_INCONSISTENTE`); a fixture `venda.finalizada.cascos.payload.json` sai exatamente da `FabricaEventos`
      (`ContratosEventosTests`) e passa pelo zod e pelo push real (`cancelamento-vasilhame-eventos.test.ts`).
    - **Desconto do operador separado** (Core): `_descontoTotalOperador` guarda a parte dele; `DescontoTotal` = a parte
      do operador + `DescontoCascos`, refeito em cada recálculo. O limite do operador (12.3), o teto da decisão 27 e o %
      recalculado valem só sobre a parte dele; o máximo do desconto no total do operador é o da 12.4 menos o crédito.
      Quando a venda encolhe (item cancelado, quantidade menor) e o crédito passa do total, ele sai **com aviso**
      ("Desconto dos cascos de R$ … removido … Registre os vazios de novo pelo F11 › Vasilhames") antes do desconto do
      operador, como o desconto no total já fazia. "Remover desconto no total" (F6 › 4) tira só o do operador; com só o
      crédito dos cascos, recusa e manda para o F11 › V.
    - **Banco local**: tabela só local `cascos_descontados_venda` (PK venda + casco; quantidade de 1 a 9.999, preço > 0;
      migração EF `CascosDescontados`), gravada no mesmo commit da venda como as `liberacoes_venda` e **não** apagada no
      encerramento: a venda finalizada volta com ela no cancelamento (D29) e na reimpressão (22.2). Não espelha a nuvem
      (o `EsquemaNuvemTests` só olha as tabelas do `Esquema.g.cs`). A venda recuperada separa as partes: operador =
      `desconto_total` gravado − crédito dos cascos.
    - **Tela**: F11 › V com a venda em andamento abre "Vasilhames · cascos devolvidos na venda" com o destino **descontar
      na venda** (padrão) e F3 alterna para **só a entrada dos vazios** (o `vasilhame.movimentado` do C10b, que não mexe
      na venda); o casco já descontado aparece com a quantidade e "Já descontados nesta venda: N (R$ …)". Em pagamento
      (F10), pede voltar aos itens. A tela de venda mostra "Cascos descontados: 2 GARRAFA 600ML … -5,00" abaixo dos
      totais (o valor já está em Descontos). Auditoria local `cascos_descontados` (fora do catálogo da nuvem, como
      `cascos_trazidos` e `desconto_total`; com o supervisor, também a `liberacao`, que sobe).
    - **Comprovante** (19.2): "Desconto casco: <casco>" e "N x preço  -valor" por casco, depois de "Cascos devolvidos: N"
      (que soma os trazidos e os descontados); o rodapé "Descontos" inclui o crédito.
    - **Cancelamento** (D29, confirmada): os descontados estão nos `devolvidos`, então a venda paga cancelada orienta
      "Devolva ao cliente N casco(s)" com eles e a nuvem estorna a entrada de todos (`ESTORNO_VASILHAME_DEVOLVIDO`); o
      estorno do pagamento é o que o cliente pagou, já com o crédito — coerente: ele recebe de volta o dinheiro e os
      cascos. Com `pdv.cancelamento_devolve_vazios` desligada, os vazios ficam na loja e o cliente perde o crédito (a
      consequência que a D29 já registrava). A forma B (venda em andamento cancelada) leva o bloco como veio, sem
      estoque.
    - Testes: `CascosDescontadosTests` (Core: desconto de origem `cliente` e os devolvidos; soma com os trazidos e a
      substituição com o preço fixado; o desconto do operador por cima, fora do limite e removido sem tirar os cascos; o
      máximo que sobra para o operador; as recusas sem mudar a venda; o item cancelado que tira o crédito com aviso; a
      venda recuperada com as duas partes; o cancelamento da venda paga com os 4 vazios e o valor pago; os cascos depois
      do desconto do operador liberado, recusados com o que cabe; o cheio incluído e aumentado depois do desconto; a linha
      `desconto_cascos` e o crédito previsto com o preço fixado),
      `CascosDescontadosDadosTests` (gravação, preço escalado, recuperação, quantidade alterada e o desconto tirado, a
      venda encerrada com as linhas), `ContratosEventosTests` (a fixture nova) e `ComboCascoTelasTests` (venda com 2
      garrafas descontadas pelo F11 › V, a entrada avulsa no meio dela pelo F3, o cupom e o `venda.finalizada` com
      `desconto_total` 5,00 de origem `cliente` e 3 devolvidos; 21 garrafas acima do teto liberadas pelo supervisor, a
      redução sem pedido e o F11 › V recusado na venda retomada em pagamento).
    - Fora deste bloco: comodato e vale pelo valor do casco (Fase 3, O14); o desconto padrão do cliente
      (`pessoas.desconto_pct`, a outra metade da origem `cliente`), que quando chegar soma no mesmo crédito fora do limite.

57. **E2E do caixa, PDV 30.7 e o backoff zerado na reconexão** (bloco C13 da 1C; PDV 30.7; SYNC 18.3; roadmap, Fase 1
    › Definição de pronto; crítica da 1C, itens 6 e 24). Três peças, todas contra a API de verdade
    (`apps/api/test/e2e-pdv/servidor.ts`) e o PDV sem tela pelo teclado:
    - **Rede simulada** (`RedeSimulada`, no e2e): um `DelegatingHandler` no cliente HTTP `sync` (pelo `ajustar` do
      `AmbienteUi`) que, desligado, falha toda chamada como o cabo puxado (`HttpRequestException`) e, sob pedido, deixa
      o push chegar à API e perde a resposta no caminho de volta. Conta os `/sync/push` por `X-Requisicao-Id` (o
      `lote_id`): o teste vê o mesmo lote indo duas vezes. Nada no app muda para o teste; o handler entra só no e2e.
    - **`CaixaPontaAPontaTests`** (o "e2e curto" do plano): ativação, abertura com o fundo, uma venda com o fardo de
      12 pelo DUN, a retornável sem o vazio (casco cobrado) e o combo de whisky; sangria pelo F11; uma venda paga
      cancelada pelo F12 com o gerente (forma A); cabo puxado, venda com o casco trazido e o fechamento cego offline;
      cabo de volta e o outbox vazio sem ninguém pedir. O ERP confere pelas consultas da tela (C12): as vendas da
      sessão só aparecem com o filtro da loja de treino (O10/D39 — o servidor do e2e marca a loja como a "Treino" do
      piloto), a soma bate com o caixa, a sangria e a `sangria_fechamento`, a sessão fechada com o contado, nenhum
      evento com erro (`/terminais/:id/eventos-erro`) e o estoque por tipo (fardo −12, lata da venda cancelada
      devolvida, gelos do combo, casco cobrado no disponível e o trazido nos vazios).
    - **`Aceite307Tests`** (o critério do PDV 30.7 e da definição de pronto da Fase 1): 200 vendas offline (lata,
      fardo, retornável com o casco e um combo a cada 20), uma sangria e o fechamento contando a gaveta estimada; na
      reconexão a resposta do primeiro lote se perde e o PDV reenvia o mesmo lote; tudo chega sem duplicar, o contador
      de pendentes cai a 0 e o ERP confere 200 vendas com o total do caixa, a sessão fechada sem diferença e a lata
      baixada exatamente. **As 4 h**: o único comportamento do PDV que depende do tempo offline é o handshake na volta
      depois de 1 h (`OpcoesSincronizacao.HandshakeAposOffline`, SYNC 18.3: "handshake (se > 1 h) → push até
      esvaziar"); não há limite de dias (O18) e o token do PDV não vence. Então no CI as vendas saem em seguida e o
      roteiro comprimido põe esse limite em 1 s (`RoteiroE2E.IniciarAsync(handshakeAposOffline:)`), passando pelo
      handshake antes do push com o outbox cheio como o de 4 h; o teste confere que houve handshake na volta
      (`RedeSimulada.Handshakes`, `handshakesNaVolta` no relatório). `GENESIS_E2E_30_7_MINUTOS` espalha as vendas pelo
      tempo pedido com os tetos de backoff e o limite do handshake de produção, no workflow manual
      `.github/workflows/aceite-pdv.yml` (240 min, junto da carga de 4 terminais da API, README da API › decisão 138),
      disparado à mão ou pela etiqueta `aceite-pdv` no PR (antes do merge, o disparo à mão não existe: o arquivo ainda não
      está no branch padrão).
      O token do **ERP** vence (15 min, e a sessão cai com 60 min ociosa): o gerente do teste entra no ERP de novo
      depois da reconexão para as conferências, senão a rodada longa caía num 401 antes de gravar o relatório. O
      resultado vai em `pdv-30-7.json` (`GENESIS_E2E_RELATORIOS`), anexado como artefato: é condição de merge do PR
      1C-1 (crítica da 1C, item 24); a PDV 30.7 e o roadmap só marcam o critério das 4 h com ele anexado.
    - **Defeito achado pelo 30.7 — backoff que não zerava na reconexão** (SYNC 18.3: "zera no primeiro sucesso"; "ao
      voltar de um período offline: … push até esvaziar"): o backoff do evento da frente cresce durante a queda (jitter
      completo até 10 min) e, na volta, o `AgendarPush(0)` do `MarcarOnlineAsync` só achava o evento ainda em espera;
      a primeira falha depois da volta (a resposta perdida) sorteava de novo até 10 min, porque o expoente vinha das
      tentativas acumuladas offline. Agora a transição offline → online chama `EnvioPush.ZerarBackoffAsync`: os
      `erro_temporario` **por falha de transporte** perdem o `proxima_tentativa_em` e a contagem de `tentativas` (que
      só serve ao expoente) recomeça; o lote continua o mesmo (`lote_envio_id`, corpo). Só a passagem por offline (2
      falhas de transporte) zera: uma falha isolada com a rede no ar espera o backoff normal. A origem da espera fica
      no `ultimo_erro` do evento: a falha sem resposta da nuvem (rede, DNS, TLS, prazo, corpo ilegível) grava com o
      prefixo `EnvioPush.PrefixoTransporte` (`transporte: `), e só essa é zerada. A espera que a nuvem pediu fica:
      o `Retry-After` do 429/503 gravado pelo push vale até o fim (SYNC 18.3, "nunca menos que o informado") mesmo
      quando a volta para online vem de outro 503, do heartbeat; e o `erro_temporario`/`fora_de_ordem` por evento que
      a resposta do push acabou de gravar não volta no Debounce, nem a escala dele recomeça a cada oscilação da rede.
      Quando o próprio push é a primeira resposta depois da queda (`EnviarAsync(voltaDeOffline: true)`), as tentativas
      que só falharam no transporte saem do expoente do backoff que a nuvem devolver (fica a 1ª, 5 s), como o zerar
      faria. Lacuna aceita: um `fora_de_ordem` que já vinha escalando e no meio leva uma falha de transporte recomeça a
      escala na volta (um POST a mais por queda, nunca um reenvio sem fim). Na rodada local, o outbox de 200 vendas
      esvaziou em ~10 s depois da volta (zerando só a espera, sem recomeçar as tentativas, foram 86 s; sem nada, a
      espera sorteada podia passar de 10 min).
      Testes (`CicloOnlineTests`): `Ao_voltar_online_o_backoff_do_outbox_zera_e_o_mesmo_lote_sobe_na_hora` (duas
      falhas offline de verdade, 5 s → 10 s, e na volta a confirmação com `tentativas = 1`; relógio falso: sem o zerar,
      o lote esperaria), `Retry_after_gravado_pelo_push_vale_mesmo_quando_a_volta_vem_de_um_503_do_heartbeat` (um só
      push, a espera de 300 s intacta) e
      `Erro_temporario_devolvido_pela_nuvem_na_volta_espera_o_backoff_sem_as_tentativas_da_queda` (sem reenvio no
      Debounce, espera de 5 s).
    - **Tempo do teste curto**: os roteiros da 1C põem o teto do backoff do heartbeat em 5 s (`OpcoesSincronizacao`,
      só no e2e) para perceber a volta da rede sem os 5 min de produção; o 30.7 longo usa os tetos de produção. Os
      roteiros do e2e rodam um de cada vez (`DisableTestParallelization`): o PontaAPonta troca o preço e revoga
      terminais, e cada roteiro usa o seu caixa e os seus produtos.
    - Fora deste bloco: a recuperação 22.1 e o backup de 2 h (C17), o "evento rejeitado em quarentena no status
      detalhado" do 30.7 (C17, junto do e2e do backup: decisão 58), o relógio atrasado de 5 dias do 30.7 (C16), o
      `409 HARDWARE_ALTERADO` com o terminal real (já
      coberto nos `TelasTests` e `CicloOnlineTests` contra a API falsa) e o critério de 50 mil produtos (1D).

58. **Rede de segurança dos `rejeitado`: consulta horária do `GET /sync/eventos-status`** (bloco C14 da 1C; SYNC 7.2,
    18.2, 21.1; README da API › decisão 139). O `eventos_resolvidos` do heartbeat continua sendo o caminho normal da
    decisão do ERP; a consulta cobre a entrega que se perdeu.
    - **Quando** (`ServicoSincronizacaoHttp.ConsultarEventosStatusAsync`): a cada
      `OpcoesSincronizacao.ConsultaEventosStatus` (1 h), só com a nuvem respondendo e o token aceito, também em
      `desativando` e com o hardware divergente (a API aceita, T6); a primeira sai na primeira volta online do laço e o
      "Sincronizar agora" (F11 › S) a antecipa. Fica fora da espera do laço (o heartbeat acorda o laço): uma rede de
      segurança de 1 h não precisa de horário exato.
    - **O quê**: os `rejeitado` na ordem da sequência, em fatias de 200 (`ClienteSyncHttp.MaximoIdsEventosStatus`,
      ids por vírgula numa query), **fora os já descartados** (`resultado.descartado`, `ConsultasVendaLocal.Descartado`:
      decisão final na nuvem, nada mais muda) e **fora os rejeitados por `EVENTO_DIVERGENTE`** (`ultimo_erro` com o
      código, `Divergente`): a linha da nuvem com aquele `evento_id` é a do envio original, de outro conteúdo, e a
      consulta devolveria a situação dela (quase sempre `aplicado`, com as versões do original), tirando da quarentena
      um evento cujo efeito local difere do da nuvem. A SYNC 11.2 o trata como permanente, de suporte; o ERP tem o
      alerta crítico com o "Ciente" no detalhe do terminal (README da API › decisão 139). Pelo mesmo motivo o
      `AplicarResolvidosAsync` não o confirma quando o `eventos_resolvidos` do heartbeat traz a resolução do original
      (o ack sai igual, para a nuvem parar de mandar). Sem `rejeitado` a consultar, nenhuma chamada.
    - **Resposta**: `aplicado`/`descartado` passam pelo mesmo `AplicarResolvidosAsync` do heartbeat
      (`StatusEventoNuvem.ComoResolvido`: `aplicado` → `confirmado` com as versões; `descartado` guarda o resultado);
      `erro`/`retido` e o id que a nuvem não devolve não mudam a situação; desde o bloco G7 da Central (decisão 72) o
      `erro`/`retido` atualiza o `ultimo_erro` local com o motivo atual da nuvem (o vermelho da aba 4). **Nenhum ack**: a
      consulta é só leitura na nuvem, e a resolução repetida no heartbeat seguinte não tem efeito (o ack sai de lá).
    - **Falha**: o erro passa pelo `TratarErroAsync` de sempre (401 `TERMINAL_REVOGADO` grava o revogado, 403 suspende,
      rede conta para o offline) e a próxima consulta espera o backoff de 18.3 (5 s a 5 min, nunca menos que o
      `Retry-After`), sem tocar no push, no heartbeat e no pull.
    - Testes: `CicloOnlineTests.Eventos_status_resolve_os_rejeitados_sem_ack_ignora_erro_e_retido_e_repete_no_intervalo`
      (aplicado confirma com as versões, descartado guarda o resultado, retido intacto, o já descartado e o confirmado
      fora da consulta, a segunda consulta só com o que sobrou, nenhum ack no heartbeat) e
      `Eventos_status_so_sai_com_rejeitados_e_falha_espera_o_backoff_sem_parar_o_ciclo` e
      `Rejeitado_por_evento_divergente_fica_em_quarentena_fora_da_consulta_e_do_heartbeat` (fora da consulta, o
      `aplicado` do original no heartbeat com ack e sem confirmar, o outro rejeitado resolvido); `ContratosTests` (a fixture
      `eventos-status.resposta.json` ida e volta, a query com os ids e os limites de 1 a 200). A `ApiFalsa` responde a
      rota como a API (`SituacaoNaNuvem`, 400 fora de 1–200).
    - Fora deste bloco: o critério do PDV 30.7 "evento rejeitado em quarentena no status detalhado … quando o ERP
      reprocessa, o heartbeat o marca como confirmado" contra a API de verdade fica para o **C17**, junto do e2e do
      backup de 2 h: o servidor do e2e força a falha na nuvem (a referência excluída antes do push offline, que gera
      `REFERENCIA_INEXISTENTE`, ou a linha alterada por SQL), o roteiro confere a quarentena no status detalhado,
      reprocessa pela API do ERP e confere o `confirmado` no caixa. Até lá os dois lados estão cobertos isolados (o PDV
      na `ApiFalsa`, a API em `fila-decisao.test.ts`). Também fora: o relógio atrasado do 30.7 (o C16 não o cobre:
      decisão 60), lacunas (C15, decisão 59) e a recuperação e o backup (C17).
59. **Lacunas de sequência: procurar, declarar e liberar o reenvio** (bloco C15 da 1C; SYNC 7.4, 7.5, 8.6; PDV 30.2,
    31.3; README da API › decisão 140). Antes o `fora_de_ordem` só ficava em backoff para sempre.
    - **Procura** (`EnvioPush.ProcurarFaltantesAsync`, na mesma transação que grava os resultados do lote): no
      `fora_de_ordem`, as sequências de `proxima_sequencia_esperada` até a anterior à da frente são procuradas em
      `eventos_saida` como `confirmado` ou `rejeitado` com payload — a nuvem restaurada de backup as esqueceu (22.5) — e
      voltam a `pendente` (lote limpo, `ultimo_erro` = `EnvioPush.ReenvioLacuna`). Achada a esperada, o lote do
      `fora_de_ordem` também volta, sem espera, e tudo sai de novo em ordem já (contam em `Enviados`: o laço repete na
      hora). O que não existe mais é a **lacuna**: de a esperada até a anterior à primeira que o caixa tem
      (`LacunaEventos`, com a faixa no log crítico). O PDV não compacta payload (a regra dos 90 dias da 8.6 não se
      aplica ainda): confirmado sem payload não acontece.
    - **Lacuna a declarar** (`EstadoTerminalSync.Lacuna`, T39): a venda **nova** é recusada com a faixa
      (`ServicoVenda.MensagemLacuna`; a em andamento termina, como no 403 da empresa), a barra mostra "■ Lacuna de
      eventos X–Y — chame o supervisor (F11 › S)" e o push segue em backoff (o `fora_de_ordem` repetido não gira).
      Em **F11 › S** a linha da lacuna e o **F4** "Declarar a lacuna": com `pdv.config.fiscal` (sem liberação no
      catálogo: no perfil padrão, só do Master) o próprio operador declara; sem ela, o PIN de um supervisor que a tem
      (31.3, `PedidoLiberacaoViewModel` com a permissão; o motivo da liberação vai como `observacao`). A declaração
      (`ServicoSincronizacaoHttp.DeclararLacunaAsync` → `EnvioPush.DeclararLacunaAsync`) é um lote sem eventos com
      `declarar_lacuna` (motivo `banco_local_perdido`), sob o mesmo semáforo do push do laço (uma chamada de push por
      vez); aceita, a espera dos eventos em `erro_temporario` cai (`LiberarEsperaAsync`) e eles sobem já. A liberação
      vai para o `log_auditoria_local` (`liberacao`, com o supervisor e o motivo; sobe no `auditoria.registros`).
      Recusa da nuvem (`LACUNA_INVALIDA`: outro envio andou; `LIBERACAO_INVALIDA`: o supervisor não tem mais a
      permissão ou a loja do caixa na nuvem) ou sem conexão → mensagem na tela, nada muda. No `LACUNA_INVALIDA` a
      faixa é esquecida, a espera do `fora_de_ordem` cai (`EnvioPush.LiberarEsperaDaLacunaAsync`) e o push sai na
      hora, revelando a faixa certa — sem isso a lacuna só voltaria quando o backoff do evento da frente vencesse
      (até 10 min), com as vendas novas liberadas nesse tempo. Só online: declarar sem a nuvem não faz sentido.
    - **Lacuna recuperável** (eventos de uma lacuna já declarada, `lacuna_recuperavel` com a faixa em
      `resultado.lacuna`): o evento fica em backoff, como o `fora_de_ordem` (a 7.4 diz "volta a pendente"; sem espera o
      laço reenviaria a cada 500 ms), e a barra avisa "▲ Eventos da lacuna X–Y — liberação do supervisor" **sem**
      bloquear vendas (nada se perdeu: os eventos estão no caixa). O F4 de F11 › S libera o reenvio
      (`AutorizarRecuperacaoLacunaAsync`, sob o semáforo do push como a declaração: o resultado de um push em voo não
      grava o backoff por cima da espera liberada): `EnvioPush.RecuperacaoAutorizada` vai como `recuperar_lacuna` em
      todo lote enquanto o outbox tiver evento a enviar dentro da faixa (`EnvioPush.TemAEnviarNaFaixaAsync`) — a faixa
      pode ter até 5.000 sequências e o lote leva 50, e o supervisor libera uma vez só. Cai quando sai o último evento
      da faixa, com o outbox vazio ou com outra faixa (só vale para os placeholders que o supervisor viu). Na nuvem,
      cada lote gera o seu `LACUNA_RECUPERADA` e a sua tarefa de reprocessamento (README da API › decisão 140).
    - O aviso some no primeiro push que avança sem lacuna (ou com o outbox vazio). A lacuna fica só em memória; na
      abertura do app a espera dos eventos em `erro_temporario` por `fora_de_ordem`/`lacuna_recuperavel` (prefixos
      `EnvioPush.PrefixoForaDeOrdem` e `PrefixoLacunaRecuperavel` no `ultimo_erro`) cai e o primeiro push a revela já,
      e não só quando o backoff vencer (reabrir o app não escapa do bloqueio; o `Retry-After` e o backoff dos outros
      erros ficam como estão). A re-hidratação pelo `GET /sync/recuperar` antes de declarar (8.6, "tentar a
      reidratação") é do **C17**.
    - Testes: `LacunasTests` (a nuvem que recebeu e esqueceu — `ApiFalsa.EsquecerDesde` — reenvia os confirmados sem
      lacuna; sequências perdidas viram lacuna, a declaração libera a fila e a repetição não grava de novo; a lacuna vai
      até a primeira sequência que o caixa tem; o evento da lacuna declarada espera e reenvia com `recuperar_lacuna`; o
      ciclo bloqueia na lacuna, recusa declarar sem lacuna, declara com o supervisor e grava a liberação; o ciclo avisa
      a recuperável sem bloquear e a liberação reenvia; 120 eventos da faixa em vários lotes, todos com a liberação e
      uma liberação só; reabrir o app revela a lacuna sem esperar o backoff; o `LACUNA_INVALIDA` revela a faixa certa
      na hora), `LacunaTelasTests` (a venda nova recusada com a faixa, F11 › S com a linha e o F4, a liberação de
      CARLOS, a venda liberada; a recuperável não bloqueia a venda e é liberada pelo F4; CARLOS, que tem a permissão,
      declara pelo F4 sem PIN, com a recusa no diálogo) e `ContratosTests` (as três fixtures novas). A `ApiFalsa` imita
      a API: placeholders, `declarar_lacuna` só a partir da esperada e `lacuna_recuperavel`.
60. **Auditoria local `relogio_regrediu`** (bloco C16 da 1C; SYNC 12.3, 12.4; PDV 30.5; T9; README da API › decisão
    141). O C9 já gravava e enviava o `relogio_regrediu` do envelope (decisão 51); faltava a auditoria local que a 12.3
    pede. O `GravadorOutbox`, quando a monotonicidade não é aplicada (o evento anterior mais de 2 min à frente da hora
    corrigida), grava no mesmo commit do fato um `log_auditoria_local` `relogio_regrediu` (`GravadorOutbox.AcaoRelogioRegrediu`):
    `entidade = 'eventos_saida'`, `registro_id` = o evento, o operador e a sessão do fato, `localizacao = 'pdv.relogio'`,
    a hora corrigida do fato, a descrição com o recuo e, em `depois`, `evento_id`, `sequencia`, `tipo`, `ocorrido_em`,
    `ultimo_ocorrido_em`, `ocorrido_em_local`, `desvio_relogio_ms` e `recuo_ms` (as horas pelo `DataHoraUtcTexto.Formatar`,
    o formato canônico do PDV; o recuo na descrição pelo `GravadorOutbox.DuracaoLegivel`, com as faixas do
    `duracaoLegivel` do `@genesis/shared`, o mesmo texto dos alertas de relógio no ERP). **Uma por regressão** sem estado
    novo: só o evento que deixou de seguir o anterior é marcado — o seguinte já compara com ele e volta à monotonicidade
    normal. A ação entrou no catálogo da nuvem (`ACOES_AUDITORIA` e `CatalogosNuvem.AcoesAuditoria`, na mesma posição:
    o `Catalogos_do_pdv_sao_os_da_nuvem` confere a ordem), então sobe no próximo lote `auditoria.registros`; também a
    regressão detectada ao gravar o próprio lote de auditoria (o registro novo fica para o lote seguinte). Na nuvem, o
    evento marcado abre o `RELOGIO_SUSPEITO` informativo (12.4). Testes:
    `GravadorOutboxTests.Hora_do_envelope_e_monotonica_e_marca_relogio_regrediu_quando_nao_aplica` (uma auditoria com
    as horas e o recuo, nenhuma no evento seguinte, o registro no lote que chega à `ApiFalsa`),
    `GravadorOutboxTests.DuracaoLegivel_mesmas_faixas_do_shared` e
    `CicloOnlineTests.Catalogos_do_pdv_sao_os_da_nuvem`.
    - Fora deste bloco: o critério do PDV 30.7 "atrasar a hora do Windows em 5 dias com o terminal offline … gera a
      auditoria `relogio_retrocedido`" é do relógio de alta-água (`maior_hora_vista`, PDV 30.6) e do prazo de
      `pdv.dias_max_offline`, que o dono desligou (O18, D35): não é o `relogio_regrediu` e não entrou no C16.

61. **Backup local, "Restaurar backup" e a recuperação 22.1** (bloco C17 da 1C; PDV 32.2, 32.5; SYNC 5, 22.1, 22.2;
    O12 do dono, roadmap D41; T6, T7, T41–T45; README da API › decisão 142).
    - **Backup** (`Data/Backup/BackupLocal`): cópia pela API de backup online do SQLite para um temporário, com o
      `identidade_terminal.ultimo_backup_em` gravado **na própria cópia** (a prova de que nada se perdeu compara a hora
      do arquivo restaurado), num arquivo só (`journal_mode=DELETE`), gzip, nome temporário e renomeado no fim:
      `backup/pdv-AAAAMMDD-HHMMSS-fff-<motivo>.db.gz`; o sha256 sai do arquivo pronto. Depois, o banco em uso ganha o
      `ultimo_backup_em`, a cópia vai para a pasta secundária (`configuracao_terminal['backup.pasta_secundaria']`;
      falha só no `log_local`), numa subpasta com o `terminal_id` (a pasta de rede comum a vários caixas: cada um lista e
      retém só os seus), e a retenção roda nas duas pastas: tudo dos últimos 7 dias e o mais novo de cada semana até 4
      semanas (`OpcoesBackup`), só os arquivos com o nome do PDV e nunca o `antes-restauracao` (pode ser a única cópia
      do que o banco substituído não enviou; sai à mão, pelo suporte). Um backup por vez no processo. **Sem cifra até
      a 1D** (O12; a chave em custódia, SYNC 22.3, chega com o SQLCipher; decisão técnica T44).
    - **Quando** (`App/Servicos/ServicoBackup`): a cada 2 h com o caixa aberto (o laço confere de tempos em tempos a
      sessão aberta e o `ultimo_backup_em`, que sobrevive ao app fechado), logo depois do fechamento de caixa (em
      segundo plano, `ServicoCaixa.FecharAsync`) e ao fechar o aplicativo (`desktop.Exit`, fora da thread da tela e com
      prazo de 60 s, e a falha só no log): o **backup de saída** e o `encerramento.json` (`MarcadorEncerramento`, com o
      sha256 dele, na pasta de dados), só com o banco que passou pelo `InicializadorBanco` neste processo
      (`ServicoBackup.BancoConferido`): fechado na restauração automática ou no erro fatal, o banco corrompido não vira
      backup de saída nem troca o marcador do último encerramento bom. A inicialização apaga o marcador logo depois do `integrity_check` bem-sucedido (`InicializadorBanco`);
      com a integridade falha ele fica. Antes de migração continua o backup do `InicializadorBanco` (`.db` sem compactar,
      motivo `antes-migracao`). Falha de backup nunca para o caixa.
    - **Restaurar** (`Data/Backup/RestauracaoBackup`, tela `RestaurarBackupViewModel`): Ctrl+Alt+C no login (a
      configuração do terminal da Fase 1 começa por aqui) → a lista das duas pastas, do mais novo para o mais antigo; o
      Enter já confere o arquivo (`RestauracaoBackup.ConferirAsync`: extração, `integrity_check`, terminal), com o caixa
      funcionando, e o recusado fica na lista sem parar nada → a liberação de quem tem `pdv.config.terminal` (usuário e
      PIN, `PermissoesPdv.ConfigTerminal`) → digitar `RESTAURAR` (com eventos ainda não enviados no banco em uso, a tela
      mostra quantos — eles não estão no backup e ficam só no `antes-restauracao` — e exige `RESTAURAR <quantidade>`) →
      o ciclo de sincronização para, o backup periódico e o de saída ficam suspensos (o de saída gravaria o
      `ultimo_backup_em` no arquivo restaurado) → Enter fecha e reabre o app (`ShellViewModel.AoReiniciar`: um processo
      novo e este sai). A falha depois de parar (o arquivo que sumiu, o disco) também termina no reinício: sem
      sincronismo nem backup, o caixa não volta ao login. Com o banco que falhou no `integrity_check`, a mesma tela abre sozinha, sem a liberação (não há
      banco para conferir o PIN) e sem voltar ao login; sem backup, a tela de erro com a pasta. A restauração extrai para
      um temporário e confere (`integrity_check`, identidade presente, o mesmo terminal do banco em uso — com ele
      corrompido, o da leitura direta da linha de `identidade_terminal`, sem o `integrity_check`, quando ela sai); guarda o banco em uso (`antes-restauracao` em `backup/`; ilegível, `pdv.db.corrompido-…` ao lado);
      grava no arquivo restaurado, por SQL direto (o backup pode ser de um schema anterior, migrado na abertura),
      `restaurado_em`, **o token do banco em uso** no lugar do antigo (T44: o do backup pode já ter sido rotacionado;
      com o banco corrompido, o da leitura direta; se nem ela sai, fica o do backup — rotacionado depois dele, a nuvem
      o aceita como anterior por 7 dias, com o alerta `TOKEN_ANTERIOR_REUTILIZADO`, e depois o terminal pede nova
      ativação), a
      `configuracao_terminal['restauracao.pendente']` (`RestauracaoPendente`: quando, o arquivo, a sequência dele, o
      `ultimo_backup_em` e se o `encerramento.json` conferia) e a auditoria local `restaurar`; e troca o `pdv.db`
      (o `-wal`/`-shm` do antigo saem antes). Nada é apagado.
    - **Reidratação** (`Sync/Recuperacao/ReidratacaoLocal`): no handshake, com a regressão, com o `409
      REGRESSAO_DETECTADA` do push (o laço refaz o handshake na hora, desde a anterior à sequência recusada) ou com a
      restauração pendente (desde a sequência do arquivo). Primeiro, numa transação, a pendência
      (`configuracao_terminal['reidratacao.pendente']`: o `desde`, a regressão, o início), os eventos ainda a enviar acima
      de `desde` — os do modo restaurado — numa sequência negativa provisória, e `sequencias_locais.evento` até a
      `ultima_recebida` do estado. Enquanto a pendência (ou um evento com sequência ≤ 0) existir, o push não manda nada
      (`DesfechoPush.ReidratacaoPendente`, também com o app reaberto: o evento novo subiria na frente dos deslocados e a
      nuvem veria uma lacuna falsa), e o handshake, refeito com backoff, retoma desde o `desde` gravado, com a regressão
      dela; o evento do caixa gravado no meio (a venda que termina, a sangria, o fechamento, a auditoria) cai acima do
      que a nuvem tem, nunca numa sequência que uma página vai gravar. Depois uma transação por página de 50 do `GET /sync/recuperar`: o evento que o banco tem fica com
      a sequência e a situação da nuvem, o que não tem é gravado com o mesmo id, a mesma sequência e o payload
      (`aplicado` → `confirmado`; `erro`/`retido`/`descartado` → `rejeitado`, como no push) e os fatos voltam às
      tabelas de movimento pelos nomes de coluna do payload (`ReidratacaoLocal.Tabelas`: sessão, movimentos e
      fechamento do caixa, venda com itens, pagamentos, parcelas, PIX e liberações, devolução de cascos); a linha
      parcial (fechamento, cancelamento) só atualiza a que existe; o documento de venda troca as linhas filhas da venda
      em andamento do backup, e a venda que a nuvem já tem encerrada não volta para a tela; o placeholder de lacuna (T7)
      e o evento sem payload só ocupam a sequência; a sequência local acompanha a `ultima_recebida` de cada página. No
      fim, numa transação, os provisórios e os gravados no meio vão, na ordem em que foram gerados, para depois da
      última sequência da nuvem (T42), `sequencias_locais.evento` fica no último deles e a pendência é apagada. Repetir
      não muda nada; interrompida, a seguinte recomeça do mesmo ponto e pula o que já gravou. Com regressão, as vendas
      ficam bloqueadas até terminar; interrompida na abertura, a tela "Recuperando os dados do caixa…" liga o ciclo
      online e vai sozinha para o login quando o handshake seguinte termina. Restaurado sem regressão, a falha só adia
      (o caixa segue no modo restaurado, com o envio parado). Com o `/sync/estado` recusado pela empresa suspensa (403),
      a regressão do push ou a pendência reidratam assim mesmo (o `recuperar` responde na suspensão, T41; a
      `ultima_recebida` vem das páginas) e o push volta; o salto fica para o handshake depois da reativação, com as
      vendas bloqueadas pela regressão até lá. Ficam de fora a auditoria (já na nuvem), os cascos descontados na venda (tabela só
      local, sem payload: a reimpressão da venda recuperada sai sem a linha do desconto pelos cascos) e o snapshot.
    - **Salto** (`RegraRestauracao`, T43): depois da reidratação, regressão, perda provável (sequência ou numeração
      local abaixo do que a nuvem sabe) ou restauração sem a prova → venda e vale em `max(local, numeracoes) + 1000`
      (`SaltoNumeracao`); a prova (backup de saída com o marcador conferido, nenhum heartbeat depois do
      `ultimo_backup_em` do arquivo, números locais ≥ os da nuvem) dispensa. Na perda provável de eventos, a sequência
      local vai até a `ultima_sequencia_gerada` informada: os perdidos viram a lacuna que o supervisor declara (C15). O
      **modo restaurado** offline salta +1000 sobre o local na primeira reserva de venda (`RepositorioVendas`, na mesma
      transação; uma vez, `salto_aplicado_em`); o handshake depois só salta de novo se a nuvem conhecer número acima do
      local. A restauração pendente é apagada e o desfecho vai para o `log_local`. NFC-e é da 1D.
    - **Lacuna** (T45): a re-hidratação antes de declarar (SYNC 8.6/22.2) não entra: a nuvem espera a sequência `de`,
      então não tem nada da faixa.
    Testes: `BackupLocalTests` (o arquivo compactado, íntegro e com o próprio `ultimo_backup_em`, a cópia secundária na
    subpasta do terminal e a secundária fora do ar, a pasta de rede de dois caixas sem misturar lista nem retenção, a
    retenção, o `antes-restauracao` fora dela, o marcador apagado só com o banco íntegro, a restauração com o banco em
    uso guardado, o token atual e a pendência, o token do banco corrompido pela leitura direta, a conferência sem tocar
    em nada e com os não enviados contados, as recusas do arquivo inválido e do outro terminal, o backup de saída
    conferido e o salto offline de uma vez), `RecuperacaoTests` (a regressão que recria caixa e venda, com os eventos na
    situação da nuvem e o placeholder, salta e repete sem duplicar; páginas de 50 com a terceira caindo e a repetição;
    o restaurado com eventos offline renumerados depois dos da nuvem e enviados; a reidratação interrompida com o push
    parado, também com o app reaberto, e o evento novo enviado só depois dos deslocados; o evento do caixa no meio da
    regressão interrompida acima da nuvem; a empresa suspensa que reidrata depois do 409 do push; a prova, o heartbeat
    depois do backup e o salto offline suficiente; a perda provável), `CicloOnlineTests` (a regressão bloqueada sem o `recuperar` e
    liberada com ele; o 409 do push que reidrata e manda o evento do caixa na sequência nova), `ContratosTests`
    (`recuperar.resposta.json`), `RestaurarBackupTelasTests` (o periódico com o caixa aberto e o de saída com o
    marcador; o periódico só com o caixa aberto e depois de vencer o intervalo (`DevidoAsync`); Ctrl+Alt+C com a
    liberação recusada para MARIA e aceita para CARLOS, a confirmação exata, o app reaberto que salta a primeira venda;
    o backup de outro terminal recusado sem parar o sync nem o backup; a falha depois de parar que termina no
    reinício; os não enviados que exigem `RESTAURAR <quantidade>`; a reidratação interrompida na abertura que liga o
    ciclo e vai sozinha ao login; o banco corrompido que abre a restauração sozinho e não vira backup de saída),
    `CaixaTelasTests` (o backup do fechamento) e o e2e `RecuperacaoBackupTests` contra a API de verdade (o critério do
    roadmap: o backup de 2 h restaurado, a regressão detectada — o motivo `regressao` no `log_local`, e não só a
    restauração pendente —, a reidratação das duas vendas e da sangria, a sessão que continua, a venda nova com o
    número saltado e o ERP com as quatro, sem repetir, no quarto caixa da loja Treino).
    - Fora deste bloco: a cifra do backup e a chave em custódia, a "Recuperar dados de terminal antigo" (22.3), o
      `PERDA_PROVAVEL` (22.4), a NFC-e (série nova ou +500), as demais telas do Ctrl+Alt+C e a pasta secundária
      editável pela tela (por ora só a chave).

### Implantação do piloto (PDV)

62. **Instalador do Windows, pacote `.deb` e versão única** (implantação I3; PDV 5.1, 32.6, 32.7; SYNC 17.3 e 23,
    cenário 13; D21; passo a passo do dono em "Instalar na loja").
    - **Build de produção sem demonstração:** já era assim para os operadores (`ModoDemonstracao=false` em todo
      `dotnet publish`), mas o **F8** do assistente ainda ativava um terminal de demonstração sem catálogo nem
      operadores — no caixa da loja, um beco sem saída. Agora o F8, o botão e a dica do rodapé só existem com
      `MODO_DEMONSTRACAO` (`ConfiguracaoBuild.ModoDemonstracao`, `AtivacaoViewModel.PermiteDemonstracao`). O CI confere o
      executável publicado pelo `GenesisPDV --info-build` (`modo_demonstracao: false`) antes de empacotar e de novo
      depois de instalar.
    - **URL padrão da API no build:** propriedade MSBuild `GenesisUrlApiPadrao` (padrão `https://api.genesispdv.com.br`,
      só `https://`, conferida antes de compilar) gravada como `AssemblyMetadata` e lida por `ConfiguracaoBuild`; os
      instaladores do CI e do release saem com a do piloto, `https://api.grupoicebeer.com.br` (o domínio da implantação
      I1, DNS criado em 03/11/2026), trocável pela variável do repositório `PDV_URL_API_PADRAO`. `GENESISPDV_API`
      continua sobrepondo e o campo continua editável no assistente.
    - **Versão única:** a `<Version>` do `Directory.Build.props` passou de `0.1.0` a **`0.9.0`**: SemVer pré-1.0 durante o
      piloto, sem sufixo de pré-lançamento — o `VersionInfo` do Windows
      só aceita números e o `versao_app` é comparado pela nuvem (`VersaoApp.Comparar`, a mesma regra do
      `compararVersoes` da API). A tag `pdv-vX.Y.Z` sobrepõe no release (`-p:Version`, só `X.Y.Z`, com aviso quando
      difere da do arquivo). Nome do instalador, rodapé do login e do assistente e `versao_app` mostram a mesma.
    - **Instalador (Inno Setup 6.3+, `instalador/windows/GenesisPDV.iss`):** por máquina (administrador), só x64,
      Windows 10 22H2 (`MinVersion=10.0.19045`) ou mais novo; o executável único em `{autopf}\GenesisPDV`;
      `%ProgramData%\GenesisPDV\{dados,backup,logs,impressao}` (as pastas do `CaminhosPdv`) com **MODIFICAR para
      Usuários** (`users-modify`, o PDV roda com a conta comum); atalhos no menu Iniciar e na área de trabalho;
      "Iniciar com o Windows" **marcada por padrão** (PDV 5.1) em `HKLM\...\Run` para quem entrar, e desmarcada numa
      reinstalação a entrada sai; o "Abrir agora" do fim roda com a conta de quem chamou o instalador
      (`runasoriginaluser`: a DPAPI da ativação é da conta, D21); ícone, `VersionInfo*` e mensagens em português. O
      `AppId` é fixo: a versão nova instala por cima e mantém banco, backups e ativação. Desinstalar não apaga
      `%ProgramData%\GenesisPDV` e diz onde os dados ficaram. Sem regra de firewall (o PDV só faz saída HTTPS).
      Versão **mais antiga** por cima da instalada (a `DisplayVersion` do registro de desinstalação): o
      `InitializeSetup` do `.iss` pergunta com "Não" como padrão e, em silêncio, desiste sem mudar nada.
    - **Outra conta do Windows abre o caixa:** o banco é da máquina e o `Run` em HKLM abre o PDV para quem entrar, mas o
      token está na DPAPI CurrentUser da conta que ativou (no Linux, na chave de `~/.config` dela). Antes, a
      `CryptographicException` do `CofreToken` escapava do handshake e do `ShellViewModel.IniciarAsync` (que o `App` não
      aguarda) e a janela ficava vazia. Agora o cofre a troca por `TokenIlegivelException`, o handshake devolve
      `DesfechoHandshake.ContaDiferente` (o ciclo não liga, nada sobe nem desce, o banco fica como está) e a tela
      **"Caixa ativado com outra conta"** diz com qual conta entrar — gravada na ativação em
      `configuracao_terminal['ativacao.conta']` (`DOMÍNIO\usuário`; num banco ativado antes disto, a tela diz "outra
      conta"). Não há reativação por cima (a nova ativação começa com um banco novo e as pendências só sobem pela conta
      certa: suporte). Qualquer outra falha na abertura vira a tela de erro "O caixa não conseguiu abrir" com a pasta
      dos logs (nunca mais a janela vazia), e o `App` registra a Task da abertura. **Padrão até a confirmação do dono:
      o `Run` continua em HKLM** (abre para qualquer conta, e a outra conta vê a explicação) em vez de HKCU só da conta
      que ativa, que o instalador elevado nem sempre consegue gravar na conta certa (o administrador que digita a senha
      pode ser outro).
    - **PDV aberto na atualização:** o app prende o mutex `Global\GenesisPDV.Instancia` (`InstanciaUnica`) com
      permissão de sincronizar para Todos (o instalador elevado pode ser de outra conta de administrador) e o `.iss`
      procura o mesmo nome (`AppMutex`): achando o PDV aberto, pede para fechá-lo **pelo próprio programa** — a saída
      normal faz o backup de saída e o `encerramento.json` (decisão 61); `CloseApplications=no`, então o instalador
      nunca fecha o processo. Em modo silencioso ele desiste (código ≠ 0) sem trocar o exe. O mesmo mutex é a "segunda
      instância não abre" da SYNC 23 (cenário 13): o segundo PDV avisa "já está aberto" (caixa de mensagem no Windows)
      e sai com o código 2; o processo do reinício depois de restaurar um backup (`--reinicio`, C17) espera até 90 s o
      anterior soltar. No Linux, falha ao criar o mutex (arquivo de outro usuário) só vai para o log: a trava nunca
      impede o caixa de abrir.
    - **Assinatura:** opcional, só no workflow `pdv-release` (`signtool` no exe e o `SignTool` do Inno no instalador e
      no desinstalador, SHA-256 com carimbo de tempo); o CI de PR e da `main` gera sem assinar. Os segredos
      `PDV_CERT_PFX_BASE64` e `PDV_CERT_SENHA` ficam no **ambiente `release-pdv`** (regra de implantação: `main` e tags
      `pdv-v*`, revisor obrigatório recomendado, tags `pdv-v*` protegidas por ruleset — "Gerar o instalador e publicar
      uma versão"); segredo do repositório chegaria a qualquer workflow de qualquer branch de quem tem escrita. Só o job
      do Windows de uma publicação usa o ambiente. No script, os dois saem do ambiente do processo antes do
      `dotnet publish` (nenhum filho os herda), o Inno Setup vem num passo anterior sem segredos e numa versão fixa do
      Chocolatey (`6.4.3`, nunca "a mais nova"), e a senha nunca vai para linha de comando nem para a saída do ISCC: o
      `.pfx` entra em `Cert:\CurrentUser\My` só durante a geração e o `signtool` assina por `/sha1 <impressão
      digital>`; o certificado e a chave saem no fim. **Padrão até a confirmação do dono: sem certificado** (é uma
      compra do dono) — o SmartScreen mostra "O Windows protegeu o computador" e o README ensina "Mais informações ›
      Executar assim mesmo". Num **Windows 11 novo com o Controle Inteligente de Aplicativos ligado**, porém, o
      executável sem assinatura é bloqueado sem essa opção (o README ensina a desligar o recurso, o que em algumas
      versões não se desfaz sem reinstalar o Windows): para esses PCs o certificado é **pré-requisito prático**
      (padrão até a confirmação do dono: sem certificado, com o passo a passo do README).
    - **Publicação:** só de commit da `main` (à mão, só rodando na `main`); a tag `pdv-vX.Y.Z` que já existe tem de
      apontar para o commit da execução (senão recusa: os binários de uma tag nunca mudam, suba a versão); um release que
      já tem arquivos só é refeito com "substituir" marcado e a tag no mesmo commit (upload interrompido), nunca com
      `--clobber` por padrão.
    - **`.deb` (`instalador/linux`):** `/opt/genesispdv/GenesisPDV`, `/usr/bin/genesispdv`, `.desktop` e ícone;
      `postinst` cria o grupo de sistema `genesispdv` e `/var/lib/genesispdv` (+ `backup`, `impressao`) e
      `/var/log/genesispdv` com `root:genesispdv 2770` (o setgid mantém o grupo); quem opera entra no grupo, e quem não
      está nele cai em `~/.local/share/genesispdv` como antes. O setgid passa o grupo, mas não a escrita: o PDV aplica
      `umask 007` no início (`PermissoesGrupo.AplicarUmask`, no Linux) e dá `g+rw` ao `pdv.db`, ao `-wal`/`-shm` e aos
      backups numa pasta com escrita do grupo (o SQLite cria com `0644` qualquer que seja a umask), então outra conta do
      grupo abre o mesmo banco e escreve no mesmo log do dia em vez de cair em "attempt to write a readonly database".
      A chave do token continua **por usuário** (`~/.config/genesispdv`, D21, o par da DPAPI CurrentUser): o pacote não
      gera `/etc/genesispdv/chave_terminal`, que o `ProtetorArquivo` exige `0600` e o caixa (outra conta) não leria; por
      isso o caixa usa **sempre a mesma conta do Linux**, e outra conta vê a tela "Caixa ativado com outra conta".
      `remove` e `purge` mantêm os dados.
      `Depends` com as alternativas de ICU/OpenSSL de Debian 12 e Ubuntu 22.04/24.04. O `Maintainer` é
      `Genesis <suporte@genesispdv.com.br>` (**padrão até a confirmação do dono**; `GENESISPDV_DEB_MANTENEDOR` troca).
      AppImage fica como próximo passo (as lojas são Windows).
    - **Versão mínima (PDV-1):** o PDV já gravava o `versao_minima` do handshake e do heartbeat em
      `estado_conexao.versao_minima_app` sem mostrar nada. Agora o login avisa em âmbar ("A nuvem pede o GenesisPDV X
      (este é o Y). Instale o GenesisPDV X ou mais novo pelo instalador (GenesisPDV-Setup-X.exe), por cima deste: …"),
      e a recusa `426`/`PROTOCOLO_NAO_SUPORTADO` da ativação e o bloqueio de protocolo do handshake dizem o mesmo
      (`MensagensAtivacao.ComoAtualizar`; na recusa da ativação, sem "a ativação continua", que ainda não existe, e com
      "Depois, abra o GenesisPDV e faça a ativação"). Só avisa: a carência de 3 dias e a atualização obrigatória no login da
      PDV 32.6 vêm com a atualização automática (PDV-2), sem bloquear a subida dos eventos.
    - **CI** (`.github/workflows/ci.yml`, job do PDV): no Windows, `gerar-instalador.ps1` (publica com a versão e a
      URL, confere o `--info-build`, exige que a publicação seja só o `GenesisPDV.exe`, instala/atualiza o Inno Setup
      pelo Chocolatey, compila o `.iss`, grava o `.sha256`) e o `testar-instalador.ps1` de verdade no runner: instala em
      silêncio e confere exe, as cinco pastas com MODIFICAR para Usuários (SID `S-1-5-32-545`), atalhos, a entrada do
      `Run`, o registro de desinstalação com a versão e o `--info-build` do exe instalado; abre o PDV instalado **com os
      caminhos da loja** (sem `GENESISPDV_DADOS`) até "Banco local pronto" no log de `ProgramData\GenesisPDV\logs` e
      confere o `pdv.db` em `ProgramData\GenesisPDV\dados`; com ele aberto, o instalador por cima desiste com o aviso
      do `AppMutex` no log e o exe não muda; fechado, reinstala por cima (o `pdv.db` com o mesmo sha256, um marcador e
      "Iniciar com o Windows" ficam) e o PDV reabre com o mesmo banco; com a `DisplayVersion` trocada para `99.0.0`, o
      instalador (mais antigo) desiste sem mexer no exe nem no banco; desinstala em silêncio e confere que o app, os
      atalhos, o `Run` e o registro saíram e o `pdv.db` e o marcador ficaram. Artefato `GenesisPDV-Setup` (exe + `.sha256`). No Linux,
      `gerar-pacote.sh` + `testar-deb.sh`: `sha256sum -c`, `dpkg-deb --field/--contents`, `apt install`, grupo e
      pastas `2770`, `--info-build`, o PDV aberto por um usuário do grupo (`sg`) com o banco em `/var/lib/genesispdv`,
      o `pdv.db` e o log do dia `660`, uma **segunda conta do grupo** abrindo o mesmo banco e escrevendo no mesmo log sem
      "readonly database", `dpkg --remove`/`--purge` mantendo banco e logs; artefato `GenesisPDV-deb`. O artefato antigo `GenesisPDV-win-x64`
      (só o exe) saiu. **Release** (`.github/workflows/pdv-release.yml`): tag `pdv-v*` ou manual; gera e testa os dois
      como o CI e cria o GitHub Release com o `.exe`, o `.deb` e os `.sha256` (os artefatos baixados pelo
      `gh run download`, conferidos por `sha256sum -c`; as recusas do item "Publicação"); nenhum segredo novo
      obrigatório.
    - **Ícone:** `src/GenesisPDV.App/Assets/genesispdv.ico` (o "G" do favicon do ERP, 16–256 px) no exe
      (`ApplicationIcon`), na janela, no instalador e no desinstalador; o PNG de 256 px no `.deb`.
    Testes: `InstalacaoTests` (a URL do `AssemblyMetadata` do build e a de um assembly com a do piloto, a variável que
    sobrepõe; a versão igual à do `Directory.Build.props` e o `--info-build`; a comparação de versões com os casos da
    API; um PDV por computador, o segundo recusado e o reinício que espera o anterior; o F8 e o botão no build de
    desenvolvimento e, com `permiteDemonstracao: false` — o ramo do executável publicado —, nem F8, nem botão
    `BotaoDemonstracao`, nem dica no rodapé em nenhum passo; o aviso de versão mínima no login, que não impede a
    entrada; o caixa aberto por outra conta, com um protetor que recusa, na tela "Caixa ativado com outra conta" com a
    conta da ativação e sem nenhum `/sync/estado`; a falha inesperada na abertura na tela de erro; o banco migrado por
    uma versão mais nova recusado sem backup de saída), `AtivacaoTests` (a recusa 426 com o instalador da versão
    mínima, sem prometer que "a ativação continua"), `CicloOnlineTests` (o handshake com o token de outra conta —
    chave de outro usuário e `CryptographicException` da DPAPI — vira `ContaDiferente` com a conta gravada, ou sem ela
    num banco antigo, sem lançar), `InicializacaoTests` (o banco com uma migração desconhecida recusado sem tocar no
    histórico, no marcador nem na pasta de backup; no Linux, o `pdv.db`, o `-wal`/`-shm` e o backup com `g+rw` numa
    pasta `2770` e intocados na pasta do usuário). O que só o Windows prova (instalação, ACL, atalhos, `Run`, `AppMutex`,
    desinstalação) roda no CI Windows; o `.deb` também foi instalado, aberto e removido numa máquina Linux.
    - Fora deste bloco: impressora e gaveta reais (I4), a atualização automática com canais e pacote assinado
      (Velopack, PDV-2), o AppImage, a hospedagem do instalador em `download.grupoicebeer.com.br` (infra da VPS, outro
      branch), a regra de firewall (desnecessária) e a conta de serviço do Windows com a chave CNG/TPM (SYNC 3.6, depois
      do piloto).

63. **Impressora térmica e gaveta reais** (implantação I4; PDV 6, 6.2, 6.3, 19, 21.4, 22.2, 32.7; dono, 03/11/2026 —
    "I4 – impressora e gaveta"; passo a passo em "Configurar a impressora").
    - **Perfis** (`Hardware/Impressora/PerfilImpressora`): Epson TM-T20 (II/III/X) e TM-T88 (V/VI) com `ESC t 3` = PC860,
      `2` = PC850 e `16` = WPC1252 e o QR nativo (`GS ( k` modelo 2, correção M); **Bematech MP-4200 TH em modo ESC/POS**
      com `ESC t 3`/`2` (a numeração da Epson, conferida no manual de programação rev. 1.0, cap. 4; no modo ESC/Bema
      seria `4` = PC860), sem WPC1252 e **sem QR nativo** (o `GS ( k` dela só tem PDF417: o QR sai como imagem
      `GS v 0`, gerada pelo QRCoder); "Genérica ESC/POS" como a Bematech (o mais aceito). Página padrão **CP860** em
      todos (a 6.9 da spec pede acentos em CP860 na TM-T20); a página que o modelo não tem é recusada na tela. O perfil
      ESC/Bema nativo não entrou (a MP-4200 TH muda de modo pelo utilitário; um perfil a mais só dobraria os testes).
      Corte: `ESC d <linhas_avanco>` + `GS V 1` (parcial) / `GS V 0` (total) / nada (sem corte) — a função A do `GS V`,
      igual nas duas marcas (a Bematech não tem o `GS V 65`). Gaveta: `ESC p m t1 t2` (pino 2 → `m = 0`, 5 → `m = 1`;
      `t1` = pulso/2, `t2` = 250 = 500 ms).
    - **Documento canônico e adaptação na hora de imprimir:** os layouts (`ConstrutorEscPos`) continuam gerando o mesmo
      formato (PC860, `GS V 66`, QR nativo), que é o gravado na `fila_impressao`; o `AdaptadorEscPos` traduz para o
      perfil e a configuração no envio (recodifica o texto, troca o `ESC t`, o corte e o QR e **retira todo `ESC p`**).
      Assim a reimpressão (22.2) e a nova tentativa de um trabalho antigo saem certas depois de trocar a impressora, e a
      impressora simulada (`.bin`/`.txt`) segue mostrando o mesmo texto. As colunas (48 no 80 mm, 32 no 58 mm) são as do
      papel no momento do documento (o `EmissorNaoFiscal` as lê a cada venda); o texto maior que a bobina **quebra na
      palavra** e o valor encostado à direita nunca é partido; o relatório de fechamento divide as colunas de valores pela
      largura quando cada valor cabe com um espaço antes (80 mm) e, senão (58 mm com o calculado), põe Calculado, Contado e
      Diferença um por linha; o avanço fixo antes do corte saiu dos layouts (vale o `impressora.linhas_avanco`, padrão
      4). Todo caractere de controle do texto (descrição de produto ou nome de cliente vindo do ERP, observação) vira
      espaço no `ConstrutorEscPos`, e o adaptador descarta byte de controle solto (um trabalho antigo da fila): só o PDV
      emite comandos — um `DLE DC4` (pulso da gaveta em tempo real) numa descrição abriria a gaveta desligada, e um
      `GS ( k` engoliria o resto do cupom.
    - **Colunas por modelo** (`PerfilImpressora.Colunas80/Colunas58`, fonte A 12 × 24, a do `ESC @`): 48/32 na TM-T20,
      na MP-4200 TH e na Genérica (576 pontos no 80 mm; no 58 mm a TM-T20 tem 35 e as bobinas comuns, 384 pontos = 32) e
      **42/30 na TM-T88 V/VI** (180 dpi: 512 e 360 pontos; ficha da Epson "80 mm: 42/48/56, 58 mm: 30/36/40", os maiores
      em outras fontes, que o PDV não usa). `impressora.colunas` grava as do modelo e a leitura volta ao papel (até 35 =
      58 mm); a tela mostra as colunas abaixo do papel. O QR em imagem (360/300 pontos) cabe na menor largura de cada papel.
    - **Transportes** (`Transportes.cs`, todos com falha virando `FalhaImpressoraException`): `TransporteSpoolerWindows`
      (`OpenPrinter`/`StartDocPrinter` com `RAW`/`WritePrinter` do `winspool.drv`, e a lista de impressoras pelo
      `EnumPrinters` nível 4) — **o padrão da loja** (o driver do fabricante instalado, USB); `TransporteTcp` (9100,
      4 s para conectar e enviar, fora da thread da tela); `TransporteSerial` (`System.IO.Ports`, 8N1, DTR/RTS ligados, por
      uma `IPortaSerial` que os testes simulam; serve à COM virtual do USB); `TransporteDispositivo` (`/dev/usb/lp0` no
      Linux, grupo `lp`). A `ImpressoraArquivoSimulada` continua como a conexão "Simulada", padrão do build de
      desenvolvimento; no build da loja, sem configuração, a conexão é **nenhuma**. A situação (DLE EOT) não é lida.
      - **Spooler sem fila escondida:** o `WritePrinter` só grava no spool — com a impressora desligada, sem papel ou
        offline ele dá certo e o Windows imprimiria tudo sozinho quando ela voltasse (cupom de cliente que já foi embora,
        em dobro com a reimpressão). Antes do envio, `GetPrinter` nível 2 (`Status` sem papel/tampa/atolada/offline/não
        disponível/pausada/erro e o atributo `WORK_OFFLINE`) recusa o documento; depois do `EndDocPrinter`, o `JobId` do
        `StartDocPrinter` é acompanhado pelo `GetJob` (a cada 200 ms) até sair da fila; com erro, sem papel, offline,
        excluído ou parado mais de `Transportes.TempoFilaWindows` (10 s), `SetJob(JOB_CONTROL_DELETE)` e
        `FalhaImpressoraException` (`falhou` na fila do PDV). Falha no `StartPagePrinter`/`WritePrinter`/`EndPagePrinter`/
        `EndDocPrinter` (os retornos agora são conferidos) chama o `AbortPrinter`: o pedaço gravado nunca sai no papel.
        Limite que sobra: o driver sem comunicação bidirecional que aceita o documento num buffer próprio parece impresso.
        A tradução da situação para o operador (`SituacaoSpooler`) fica fora da classe com P/Invoke e tem teste em
        qualquer sistema.
      - **Tempo limite em todo envio** (`ImpressoraEscPos.EnviarBrutoAsync`, `WaitAsync` com
        `Transportes.TempoEnvio`): rede e dispositivo 8 s, spooler 18 s (inclui a espera da fila), serial pelo tamanho.
        O transporte preso numa chamada bloqueante (o `write()` do `usblp` sem papel ou com a tampa aberta, o spooler de
        um servidor de impressão que caiu, a impressão direta com a impressora desligada) vira `FalhaImpressoraException`
        e a venda segue — a gaveta, a faixa e o sync rodam, a tela não fica "ocupada" para sempre —, mesmo que a thread
        dele continue presa até o sistema a soltar.
      - **Serial pelo tamanho:** `WriteTimeout` = o tempo da linha (10 bits por byte) com 50% de folga + 4 s
        (`Transportes.TempoSerial`); o QR em imagem da Bematech (cerca de 15 KB) leva uns 15 s a 9600 baud e com os 4 s
        fixos saía sempre cortado.
      - **Dispositivo só de impressora:** o caminho é texto livre da tela, então só vale no Linux e só dentro de `/dev`
        (`usb/lpN`, `lpN`, `ttyUSBN`, `ttyACMN`; o link vale pelo destino), conferido ao salvar e de novo antes de abrir
        (`TransporteDispositivo.Validar`). Um arquivo comum — o `pdv.db` (o `FileShare.ReadWrite` não conflita com os locks
        do SQLite), um backup, o `encerramento.json` — nunca é aberto para escrita; só o root cria arquivo em `/dev`. No
        Windows a conexão é recusada na tela e no transporte.
    - **Fila e falha** (`ServicoImpressao`, o único caminho de impressão do caixa e da venda): o trabalho é gravado antes
      de ir à impressora; a falha fica `falhou` com o erro e o aviso de sempre ("… não impresso — ficou na fila"), sem
      travar nem desfazer nada; **sem impressora**, o trabalho fica `cancelado` ("sem impressora configurada") — o
      conteúdo serve à reimpressão, a fila e o `fila_impressao_pendentes` do heartbeat não crescem e não há aviso por
      venda, só o "🖶 Sem impressora" discreto na barra — salvo no que o operador pediu de propósito: o F4 do PIX e a
      reimpressão dizem "Sem impressora configurada neste caixa" (antes a tela dizia "enviado"/"reimpressa" sem nada ter
      saído; `ServicoImpressao.ImprimirAsync(semImpressora:)`). A **cobrança PIX** que falha fica `cancelado` com o erro
      (`novaTentativa: false`): fora do F7, do `fila_impressao_pendentes` e do "Descartar" — o QR de uma venda encerrada
      nunca sai horas depois. Nova tentativa **manual** (F7 na configuração: do mais antigo ao
      mais novo, para na primeira falha) e F8 para descartar: reimprimir sozinho minutos depois tiraria cupom de cliente
      que já foi embora.
    - **Gaveta** (`ServicoGaveta`; dono): **desligada por padrão** e, desligada, nenhum `ESC p` sai — nem pela
      simulada; ligada, abre **só** na finalização com algum pagamento de forma "Abrir gaveta" (o troco sozinho deixou de
      abrir: ele só existe em forma "dá troco", e a decisão do dono fala das formas) e pela abertura avulsa **F11 › 9**
      com `pdv.gaveta.abrir_avulsa` (nova em `PermissoesPdv`, já no catálogo do shared; fora do perfil do operador — o
      supervisor libera), motivo obrigatório e a auditoria `gaveta_aberta` (no catálogo da nuvem) com quem liberou e a
      sessão, gravada **antes** do pulso (se a auditoria falhar, a gaveta não abre; se o pulso falhar depois, o log local
      registra). O **F6 Abrir gaveta (teste)** da configuração também manda o pulso real — e a tela abre com o caixa
      aberto (F11 › 8) —, então grava a mesma `gaveta_aberta` antes do pulso (motivo "teste na configuração do terminal",
      quem está na tela, quem liberou, a sessão do caixa). Abertura de caixa, sangria, reforço, fechamento e a devolução em dinheiro do cancelamento, que a 19.4
      listava, **não abrem**: o dono decidiu "só nas formas com abre gaveta e por comando manual". Ficou a chave
      `gaveta.abre_nos_movimentos` para quem quiser a 19.4 inteira — **padrão até a confirmação do dono: não**. Sem
      impressora, a gaveta (que é pela impressora) também não abre. Gaveta em porta serial própria e sensor: depois.
    - **Configuração do terminal** (desde o G3 da Central, decisão 68: aba 3 "Impressora e gaveta", `AbaHardwareViewModel`;
      o que segue continua igual): **Ctrl+Alt+C** no login (usuário e PIN de quem tem
      `pdv.config.terminal`) e **F11 › 8** com o caixa livre (o operador com ela ou a liberação do supervisor). Modelo,
      conexão (lista das impressoras do Windows / IP e porta / COM e velocidade com as portas encontradas / dispositivo),
      papel, guilhotina e linhas de avanço, página de código e QR ("o do modelo" por padrão), gaveta (ligada, pino,
      pulso, nos movimentos); **F5 Imprimir teste** e **F6 Abrir gaveta (teste)** com o que está na tela (antes de
      salvar), **F2 Salvar** (valida, grava as chaves `impressora.*`/`gaveta.*` e a auditoria `editar` de
      `configuracao_terminal` com antes/depois **num commit**, `RepositorioTerminal.GravarConfiguracoesAsync`), F7/F8 a
      fila e, **só pelo login**, **F9 Restaurar backup** — o Ctrl+Alt+C do C17 agora passa por esta tela, e a restauração
      chega já liberada (sem a segunda liberação; decisão 61). Sem tabela nova: as chaves são as de `configuracao_terminal`
      (`ChavesHardware`; valor desconhecido ou ilegível cai no padrão e nunca impede o caixa de abrir). O evento
      `terminal.configuracao_alterada` da spec 6 fica para quando o ERP tiver a tela do suporte (a auditoria já sobe).
    - **Documentos:** o comprovante não fiscal (com "NÃO É DOCUMENTO FISCAL" no topo e no rodapé), abertura, sangria,
      reforço, fechamento/troca de turno, resumo diário e a reimpressão com "2ª VIA - REIMPRESSÃO" saem nas colunas do
      modelo (48/32; 42/30 na TM-T88); novo: a **cobrança PIX impressa** (**F4** na tela do PIX: valor, o QR do BR Code — nativo ou imagem — e o
      "copia e cola"; "NÃO É COMPROVANTE DE PAGAMENTO"; a confirmação continua manual).
    - **Padrões até a confirmação do dono:** `gaveta.abre_nos_movimentos` = não; nova tentativa da fila só manual; a
      Genérica sem QR nativo; CP860 como página de todos os modelos; fonte A (sem as 56 colunas da fonte B); o documento
      parado na fila do Windows é excluído depois de 10 s.
    Testes: `GoldensImpressoraTests` (o teste de impressão e um comprovante de venda fixo adaptados para cada modelo nos
    papéis de 80 e 58 mm, **byte a byte** contra `tests/GenesisPDV.App.Tests/goldens/impressora/*.hex`, com o `.txt` do
    papel ao lado; regravar com `GENESISPDV_REGRAVAR_GOLDENS=1` e conferir o diff), `ImpressoraTests` (golden de bytes por perfil — Epson CP860/WPC1252, Bematech CP860/CP850, Genérica —, corte
    parcial/total/sem e o avanço, QR nativo na Epson com o módulo do papel × imagem na Bematech, na Genérica e na Epson
    com "imagem", a imagem com a zona de silêncio, `ESC p` dos pinos 2 e 5 e nenhum `ESC p` no documento adaptado de
    nenhum modelo, a `GavetaImpressora` desligada sem envio, o teste de impressão e a cobrança PIX em 48 e 32 colunas sem
    linha maior que o papel, a quebra na palavra, o TCP contra um `TcpListener` local e a porta fechada, a serial por uma
    porta falsa e a ocupada, o dispositivo só dentro da `/dev` (o arquivo comum e o link para o banco recusados sem gravar
    nada; fora do Linux, recusado), as colunas de cada modelo e papel sem linha maior que a largura (a TM-T88 em 42/30) e
    as chaves de volta ao mesmo papel, o envio que nunca termina virando falha no tempo limite, o tempo da serial pelo
    tamanho, a situação do spooler e do trabalho na fila do Windows, o caractere de controle que nunca vira comando, o
    fechamento com o calculado sem valor colado em 48/42/32/30 colunas, a cobrança PIX com o número e o valor na mesma
    linha, e as chaves ida e volta com o padrão e os valores estragados),
    `ImpressoraTelasTests` (headless, com um transporte em memória: o cupom em 32 colunas adaptado e cortado, nenhum `ESC
    p` com a gaveta desligada e só o pulso do pino 5 ligada; a falha que não trava a venda, fica `falhou` e sai pelo F7
    do F11 › 8 liberado pelo supervisor; sem impressora a venda sem aviso, o trabalho `cancelado` e a barra; o Ctrl+Alt+C
    com o teste em 32 colunas, a gaveta de teste com a auditoria, a página recusada, as chaves e a auditoria; o F6 pelo
    F11 › 8 com o caixa aberto auditado com a sessão e quem liberou, e a auditoria que fica quando o pulso falha; a
    gaveta ligada sem "nos movimentos" sem nenhum `ESC p` na sangria, no reforço, no cancelamento com devolução em
    dinheiro, no fechamento e na venda com troco cuja forma não tem "Abrir gaveta"; o F4 do PIX sem impressora, enviado
    e com a impressora caída (a cobrança `cancelado`, fora dos pendentes e do F7); a reimpressão sem impressora com o
    aviso; o F11 › 9 desligado e ligado com a liberação e a auditoria `gaveta_aberta`) e `SpoolerWindowsTests` (só no CI
    Windows). Os testes que
    contavam aberturas da gaveta ligam a gaveta antes (`AmbienteUi.LigarGavetaAsync`) e a abertura de caixa não conta
    mais; os do "Restaurar backup" entram pela configuração do terminal.
    - **Só o CI Windows prova:** o spooler RAW. O passo "Impressora de teste do spooler" (`preparar-impressora-teste.ps1`)
      liga o serviço Spooler, instala o driver "Generic / Text Only", cria uma porta local que grava num arquivo e a
      impressora "GenesisPDV Teste RAW"; o `SpoolerWindowsTests` confere que ela aparece no `EnumPrinters`, manda o
      teste de impressão adaptado pelo `TransporteSpoolerWindows` e exige o arquivo **byte a byte** igual (o driver não
      tocou em nada; agora o envio também espera o trabalho sair da fila do Windows), e que a impressora inexistente vira
      falha. **No GitHub Actions a prova é obrigatória:** o preparo que falha (spooler, driver, porta, erro no próprio
      script) sai com `::error::` e código 1, e o teste, sem as variáveis no Windows do CI, falha em vez de pular — um aviso
      amarelo com o teste pulado deixaria o CI verde sem prova nenhuma. Para tolerar de propósito um runner sem spooler,
      a variável do repositório `PDV_SPOOLER_OPCIONAL=1` (vira `GENESISPDV_SPOOLER_OPCIONAL` no job). Fora do CI o preparo
      só avisa e o teste fica pulado. Com a impressora de verdade (acentos no papel, guilhotina, QR lido pelo app do banco, a gaveta) só o teste
      na loja prova — o roadmap mantém o item.
    - Fora deste bloco: logotipo da loja (`impressora.imprime_logotipo`), código de barras no teste, vias de TEF, 56
      colunas (fonte B), DLE EOT, perfil ESC/Bema, gaveta serial/sensor, impressoras de produção (FUT) e tudo fiscal (DANFE NFC-e).

64. **Ensaio do piloto com a carga real e o roteiro do dono** (implantação I5; PDV 5.1, 16.7, 32.4; README da API ›
    decisão 143; `docs/implantacao/roteiro-piloto.md`).
    - **`EnsaioPilotoTests`** (`tests/GenesisPDV.E2E.Tests`): o PDV de verdade (Avalonia headless) contra a API do
      `ensaio-piloto.ts`, que importou a planilha real do Nuvem3, criou a loja de ensaio (a "Treino" do O10, com uma
      chave PIX aleatória de mentira) e o caixa 01 pelas rotas do ERP e o operador (perfil padrão) e o gerente com PIN.
      Ativa pelo assistente e mede a ativação + carga inicial e o tamanho do `pdv.db`; mede o `ICatalogoProdutos` em
      300 códigos sorteados do banco local (`ResolverAsync`, o que o leitor chama) e em 50 palavras de nomes
      (`PesquisarAsync`, o F2); abre o caixa e faz 30 vendas de 1 a 4 itens sorteados (semente fixa) de uma amostra
      vendável do catálogo (produto ativo, com preço, sem balança nem "solicita preço", com um código só dele e, no
      combo, componentes ativos; quantidade 1 a 3, `0,5*` no fracionado, o diálogo do combo pelos padrões), pagando em
      rodízio dinheiro, PIX (QR da chave da loja, pagador e horário, liberação do gerente, O9b), débito e crédito
      (bandeira); sangria no meio, fechamento cego com a gaveta estimada, outbox vazio. Confere pelo ERP as vendas e o
      total (`treino=somente`), a sessão fechada, nenhum evento com erro, o saldo de cada produto vendido baixado pela
      quantidade e a Prontidão da loja sem nenhum `falta`. O relatório só tem tempos e contagens (nenhum nome nem
      código); o estado com os códigos da amostra fica na pasta temporária do script e some no fim.
    - **`Explicit = true`**: o teste só roda pedido (`--explicit only` no `ensaio-piloto.sh`). Assim o `rodar.sh` do CI
      (`--fail-skips on`, `--minimum-expected-tests 5`) não muda: o explícito aparece como "não executado" e o job
      segue verde (conferido localmente com o `rodar.sh`). `RoteiroE2E.AtivarECarregarAsync` e `ErpE2E.EntrarAsync`
      ganharam a sobrecarga com a API e a empresa à parte (o ensaio não tem o `EstadoE2E` do CI).
    - **Resultado do ensaio de 04/11/2026** (1.664 produtos, 1.658 códigos, Linux, API e PostgreSQL na mesma máquina):
      importação 0,4 s de prévia e 36,4 s de confirmação, nenhum erro; ativação + carga 3,8 s, `pdv.db` 10,6 MB com
      1.664 produtos; busca por código p50 4,6 ms / p95 7,1 ms, por texto p50 14 ms / p95 23 ms; 30 vendas (84 itens:
      8 dinheiro, 8 PIX, 7 débito, 7 crédito) com p50 0,59 s e p95 1,6 s do primeiro bipe ao caixa livre pelo teclado
      simulado; outbox vazio 0,5 s depois do fechamento; no ERP 30 vendas com o mesmo total, sessão fechada, 0 eventos
      com erro, 36 produtos com o estoque baixado certo; Prontidão pronta (25 ok, 6 avisos: produtos sem código, EAN com
      dígito errado, código repetido, NCM, estoque negativo e o backup "não verificável aqui"). O catálogo real não tem
      combos nem fracionados (a amostra saiu com 40 unidades e 2 fardos): esses seguem cobertos pelos e2e do C13.
    - **O que o ensaio confirmou do caixa:** o código de barras repetido entre dois produtos entra pelo primeiro
      encontrado (`CatalogoLocal.ResolverAsync`, sem diálogo de escolha) — a Prontidão avisa ("pode sair o produto
      errado") e o roteiro manda corrigir no cadastro. A chave PIX da loja, que o caixa já lia (`lojas.chave_pix`),
      agora tem onde ser cadastrada (ERP › Lojas › Dados, com o nome do recebedor obrigatório). **Padrão até a
      confirmação do dono:** trocar a chave, o nome ou a cidade pede `lojas.editar_pix`, só do Administrador no seed
      (o Gerente edita o resto da loja), com a auditoria `pix_recebedor_alterado` (README da API › decisão 144): é a
      conta que recebe todo QR do caixa. Se a planilha tiver produtos inativos, a descida os leva também: o
      `EnsaioPilotoTests` compara o total local com o total da nuvem e os ativos com os ativos, e soma à baixa esperada
      de um produto da amostra a dos combos vendidos que o têm como componente.
    - **Prontidão × caixa:** a Prontidão segue as regras do `AutenticadorOffline` (totem e quem não tem
      `pdv.acesso.entrar` não contam, nem como liberador; o liberador não pode ser o próprio operador nas liberações
      que o caixa sempre pede) e as do `ServicoVenda.PermissoesParaLancar` (com o PIX manual sem a chave, o operador sem
      `pdv.pagamento.confirmar_pix_manual` ainda pede o supervisor); a configuração do terminal conta só quem tem
      também `pdv.supervisor`, porque o Ctrl+Alt+C do login e o "Restaurar backup" chamam o `LiberarAsync` sem operador.
    - **Convivência com o Nuvem3 no piloto — decidida pelo dono** (roadmap D42, registrada em 05/11/2026): o Genesis é
      o caixa principal da loja do piloto e a NFC-e é emitida no Nuvem3 durante o piloto (o Genesis não emite nada
      fiscal até a Fase 3F). Isto substitui o padrão provisório que estava aqui (o Nuvem3 como sistema da loja e o
      Genesis só na loja "Treino"). O passo a passo da convivência está no roteiro
      (`docs/implantacao/roteiro-piloto.md`) e a decisão completa, na D42 do roadmap (§16).
    - Fora deste bloco: medir com 50 mil produtos (a meta da 32.4; o catálogo real tem 1,7 mil), o ensaio em Windows
      com a impressora de verdade (só na loja) e a conferência automática do `/api/saude/detalhada` (é do PR da
      infraestrutura: o roteiro manda olhar pelo Hermes).
65. **Barra de funções clicável, pesquisa só por números, janela do item e o F4 com permissão** (versão **0.9.1**;
    pedido do dono de 04/11/2026 depois da aprovação da implantação; PDV 6.8, 9.1, 10.3, 12.2, 12.3, 13.1, 31.3).
    - **Barra de funções** (`VendaViewModel.Atalhos`, `AtalhoBarraViewModel`): o rodapé da venda virou 15 botões
      (duas linhas de 8, `UniformGrid`), com a tecla e a função, cada um com o **mesmo comando** da `KeyBinding`
      (`AcionarAtalhoCommand` executa o `ICommand` da tecla: as permissões e liberações são as mesmas por construção);
      os das próximas fases (F7, F8, F9, Ctrl+N, Ctrl+T) esmaecidos e com o aviso de sempre; o F10 em destaque. Os
      botões (`Button.atalho`, `Button.acao`, `Button.opcao` no `Estilos.axaml`) **nunca recebem o foco**, e as linhas
      das listas da venda também não (`ListBoxItem` não focável no `VendaView`): o foco fica no campo de código, e
      sem diálogo aberto ele volta para lá depois da ação (o leitor de código de barras digita no campo focado; o
      teste bipa logo depois do clique). Os diálogos do dia a dia ganharam botões com a tecla no rótulo (pagamento,
      com as formas clicáveis; maquininha; PIX; o menu do F11 com cada item clicável; F12 e o detalhe; desconto,
      quantidade, remover, cliente, liberação do supervisor, cascos, motivo do cancelamento, sangria/reforço,
      movimentos, resumo, status, vasilhames, ajuda) e as listas aceitam clique (escolhe) e duplo clique
      (`Comportamentos/Comandos.DuploClique`: confirma, com o modelo da linha). Em 1366×768 os botões têm 44 px de
      altura; em 1920×1080 a barra continua em duas linhas.
    - **Preferências do terminal** (`PreferenciasCaixa`, `ChavesPreferencias`): `tela.barra_funcoes` (`botoes`, padrão,
      ou `texto`, a legenda antiga) e `pesquisa.somente_numeros` (padrão `false`) em `configuracao_terminal`, no bloco
      **Tela do caixa** da configuração do terminal (Ctrl+Alt+C / F11 › 8). **Sem tabela nem migração**: o
      `ServicoHardware` lê as chaves com as da impressora e grava tudo no mesmo commit, com a mesma auditoria `editar`
      (antes/depois com as chaves novas e a descrição "barra de funções em …; pesquisa …"). A tela de venda lê as
      preferências ao abrir (a configuração volta para uma venda nova).
    - **Pesquisa só por números** (`ICatalogoProdutos.PesquisarCodigoAsync`, `CatalogoLocal`; `ServicoVenda.PesquisarAsync`
      e `ProcessarEntradaAsync` com a opção): só dígitos (letras recusadas com `MensagemPesquisaSoNumeros`, no F2 e no
      texto do campo de código que não é código), no código interno, no código numérico e nos códigos de barras **de
      venda** (EAN principal e os adicionais das embalagens; os só de compra não), produto ativo; ordem exato → começa
      → contém, por nome em cada grupo, até 50 (o "contém" vai ao SQLite, a ordem em memória). **Uma linha por produto
      e embalagem** (`ProdutoPesquisado`): o código de uma embalagem (fator ≠ 1 ou preço próprio, a mesma regra do
      bipe) dá a linha dela, com o código que bateu e a embalagem ("FD 12", o preço do fardo), e o Enter/duplo clique
      inclui **a embalagem** já resolvida (`IncluirResolvidoAsync` com o `ProdutoResolvido` do código, como o bipe:
      o DUN do fardo entra como fardo, nunca como 1 lata); os códigos da unidade dão a linha da unidade. **No campo de
      código**, dígitos são sempre código (o leitor): com a opção ligada, os que não acham produto (parte do código,
      "7891149", ou "2*7891149" com o multiplicador) **abrem a pesquisa só por números com eles** em vez do "Produto
      não encontrado" — quem só tem o teclado numérico chega à pesquisa sem o F2; sem resultado, ela diz "Nenhum
      produto com os números …" e o Esc volta. Desligada, nada muda (inclusive o "Produto não encontrado").
    - **Janela do item** (`DialogoItemViewModel`): duplo clique num item lançado (o título do combo vale pelo combo);
      item cancelado não abre (mensagem). Quantidade pela regra do F3 (`VendaViewModel.AlterarQuantidadeAsync`, que o
      F3 passou a usar: o Core recusa decimal fora das unidades fracionáveis, combo e casco — a janela já diz antes e
      desabilita o campo nesses dois), desconto pela do F6 (`VendaViewModel.AplicarDescontoAsync`, que o
      `DialogoValorDescontoViewModel` passou a usar: limite do operador, liberação do supervisor com o limite dele e
      `liberacoes` da venda; com a liberação a janela volta), "Tirar desconto" (`RemoverDescontoItemAsync`) e "Remover
      item" (o fluxo do F4 abaixo). **R$ ou % pelo clique**: o teclado numérico não tem a tecla %, então a janela e o
      valor do F6 têm os botões **"Aplicar em R$"** e **"Aplicar em %"** (`Desconto.Ler(texto, tipo)`: o número
      digitado vale no tipo do botão; "10%" com o botão do R$ é recusado); o Enter no campo continua lendo "2,50" ou
      "10%". A janela fica aberta com os valores novos (o retornável pergunta os cascos, como
      o F3); Esc fecha. **Diminuir a quantidade é cancelar parte do item** (PDV 13.1): quem pode cancelar item sozinho
      diminui como sempre (F3, janela, "−"; sem auditoria própria, como antes); sem `pdv.venda.cancelar_item` (ou com
      `pdv.cancelar_item_exige_supervisor`) o `ServicoVenda.AlterarQuantidadeAsync` (e o "−") recusa com
      `ReducaoExigeLiberacaoException` e a tela pede o supervisor ("Cancelar 9,000 UN do item 1 — … (de 10,000, R$ …)");
      liberado, a redução vira o **cancelamento parcial** do F4 (`CancelarItemAsync(seq, qtd, liberacao)`: a linha
      original cancelada com o `autorizado_por_id` e o motivo, a nova com o restante, `item_cancelado` e `liberacao`).
      Aumentar não pede nada. Assim tirar a permissão do perfil não tem contorno pelo campo de quantidade. Não há regra nova de item pesado: a balança/etiqueta ainda não existem no caixa (PDV-2) e o
      item de KG segue a regra do F3 (até 3 casas). A lista não recebe o foco (o campo de código fica sempre com ele),
      então o "Enter na lista" não se aplica; pelo teclado continuam as setas + F3/F4/F6.
    - **F4 com `pdv.venda.cancelar_item`** (`PermissoesPdv.CancelarItem`): a permissão estava no perfil mas o caixa
      nunca a conferia, nem a chave `pdv.cancelar_item_exige_supervisor` (catálogo do shared, padrão `false`, já no
      ERP › Configurações › Avançado), que a PDV 13.1 manda respeitar. Agora `ServicoVenda.CancelarItemExigeLiberacaoAsync`
      (sem a permissão ou com a chave) faz o F4, o botão e o "Remover item" da janela pedirem a liberação
      (`PedirLiberacao` → `LiberarAsync`: PIN de outra pessoa com `pdv.supervisor` e a permissão, motivo, nunca o
      próprio operador); o diálogo do cancelamento mostra quem liberou e `CancelarItemAsync(…, liberacao)` grava na
      linha cancelada o `autorizado_por_id` e o motivo (colunas que o Core já tinha) e, no mesmo commit, a auditoria
      `item_cancelado` com o autorizador e a `liberacao` (`itens_venda`, `PDV › Venda`, o motivo sobe em
      `depois.motivo`). O serviço confere de novo (sem confiar só na tela). O pedido diz **qual item** o supervisor
      libera ("Cancelar item 2 — CERV BRAHMA LT 350ML (1,000 UN, R$ 3,49)"; o combo, com o total das linhas); sem item
      selecionado, o F4 pede a seleção antes. Liberado, a **sequência fica travada** no diálogo do cancelamento (só
      leitura, foco na quantidade): só a quantidade a cancelar muda, nunca o item. O perfil padrão do operador tem a
      permissão: **por padrão nada muda**. O fluxo `acesso` da API já descia a permissão (`perfis_permissoes` com
      `pdv.%`, `permissoes` do módulo `pdv`) e o ERP já a mostrava em português ("PDV – Venda › Cancelar item", do
      catálogo `PERMISSOES` do shared); o `CicloOnlineTests` passou a conferir o rótulo, o perfil e a chave nova do
      `PadroesBool`. **Resposta ao dono** ("essas funções de baixo já são liberadas por login?"): sim — F11 (cada
      função), F12, Shift+F4, as formas do F10 e agora o F4 conferem permissão do perfil; o F6 é controlado pelo
      **Limite de desconto %** do usuário (acima dele, o supervisor; 0% = todo desconto pede o supervisor) **e** pela
      permissão `pdv.venda.desconto_item` (item) / `pdv.venda.desconto_total` (total) do perfil: sem ela, o limite do
      operador vale 0% (`ServicoVenda.LimiteDoDesconto`) e todo desconto pede o supervisor ("… (sem a permissão de
      desconto)"), com a liberação gravada como as outras (`liberacoes`, `autorizado_por_id`, auditoria); F2, F3 e F5
      não têm permissão no catálogo (o F3 que diminui pede a de cancelar item, acima).
    - **Saída por clique das telas abertas pelo clique**: a tela do fechamento (F11 › 3) ganhou os botões das teclas da
      legenda ("Conferir/Confirmar [Enter]", "Contar cédulas [F3]", "Zera caixa [F5]", "Recontar [F4]", "Voltar [Esc]",
      cada um visível quando a tecla vale, e "Seguir [Enter]" no fim), e o contador de cédulas (fechamento e
      sangria/reforço) ganhou "Usar o total [Enter]" e "Voltar [Esc]": o caixa só com teclado numérico e mouse não
      fica preso numa tela que só saía pelo Esc.
    - **Versão 0.9.1**: `<Version>` do `Directory.Build.props` (e os exemplos do `.iss` e do `gerar-instalador.ps1`).
    Testes: `UsabilidadeTelasTests` (headless, mouse simulado: os botões F3, F4, F6, F10 — com o Lançar do pagamento
    —, F11 — com o item S clicado —, F12, Shift+F4 e F7 disparam o mesmo da tecla e o foco volta ao código, com um
    bipe logo depois do clique; nenhum botão focável e com 44 px; a barra em 1920×1080; a opção "texto" pela
    configuração do terminal liberada pelo supervisor, com as chaves e a auditoria antes/depois; a pesquisa só por
    números com o exato antes do começa e do contém, o código adicional do fardo, letras recusadas no F2 e no campo de
    código, setas + Enter e o duplo clique incluindo, e desligada como antes; a janela do item pelo duplo clique — um
    clique só seleciona e mantém o foco —, quantidade, desconto dentro do limite e com a liberação (auditoria e
    `autorizado_por_id`), tirar desconto, o KG com 3 casas, o decimal recusado na unidade, o combo sem quantidade e
    removido pela janela, o cancelado que não abre; o F4 sem a permissão pedindo a liberação, a própria operadora
    recusada, o supervisor gravado no item e nas duas auditorias, o serviço recusando sem liberação; a chave
    `pdv.cancelar_item_exige_supervisor` pedindo mesmo com a permissão; e o terminal real com o perfil da nuvem sem a
    permissão liberado pelo supervisor do perfil padrão; o pedido do F4 com o item e a sequência travada; o desconto
    de 10% só por clique ("10" + "Aplicar em %", na janela e no F6) e o número com o botão do R$ em reais; o DUN do
    fardo na pesquisa incluindo o fardo (12 a 37,90); dígitos sem produto no campo de código abrindo a pesquisa, com o
    multiplicador, e desligada como antes; diminuir sem cancelar item pedindo o supervisor na janela, no F3 e no "−",
    a própria operadora recusada e o cancelamento parcial auditado; o desconto sem a permissão do operador pedindo o
    supervisor na janela e no F6; a saída por clique do fechamento e do contador de cédulas; e a barra em 1366×768 e
    1920×1080 sem estourar a largura nem cortar rótulo), `CatalogoLocalTests` (a ordem exato > começa > contém,
    código adicional como linha da embalagem, o DUN resolvido como o bipe, código só de compra, inativo e letras),
    `VendaTests` (`Desconto.Ler` com o tipo do botão) e `CicloOnlineTests` (o catálogo do shared). Capturas:
    `GENESISPDV_CAPTURAS` grava `pdv-40` a `pdv-46` (barra, pagamento, configuração, pesquisa, janela do item, 1920,
    a linha do fardo na pesquisa).
    - Fora deste bloco: o "Enter na lista" (a lista não toma o
      foco), botões clicáveis nas opções do Montar combo (o catálogo real não tem combos; os botões de navegação e
      confirmação existem), a grade de produtos (cardápio interno, FUT) e o teclado numérico na tela (toque).

### Central do PDV (engrenagem)

66. **Contratos da Central na nuvem: 6 permissões novas e o perfil de sistema "Encarregado"** (Central do PDV, bloco
    G1; decisões do dono de 04/11/2026: PC-1 com a D23 mantida, PC-7, PC-8, PC-9, PC-13 e o limite de 30 dias; PDV
    31.2; ERP 11.3, 11.4; MD 7.9). A nuvem conhece as permissões antes de qualquer PDV com a Central; **nenhuma tela
    muda neste bloco** e o PDV 0.9.1 continua igual (as chaves novas descem no fluxo `acesso` como as outras e o caixa
    não as confere ainda).
    - **Permissões** (`PERMISSOES` do shared, grupo novo **"PDV – Central do PDV"**, todas com liberação; espelho em
      `PermissoesPdv`): `pdv.venda.consultar_historico` (vendas dos caixas fechados do terminal nos **últimos 30
      dias**; sem ela, só as do caixa aberto), `pdv.caixa.consultar_fechamentos` (fechamentos dos mesmos 30 dias,
      **só como foram impressos**, PC-9: calculado e diferença só no ERP, O3), `pdv.diagnostico.ver` (sincronização,
      logs, ocorrências, backups), `pdv.diagnostico.pacote_suporte`, `pdv.auditoria.ver_local` (histórico de uso) e
      `pdv.config.parametros_locais` (bloqueio de tela e pasta secundária do backup, "Fazer backup agora"). Painel de
      saúde e Sobre ficam com `pdv.acesso.entrar`, sem PIN (PC-7). Os rótulos do ERP (Perfis de acesso e Permissões
      Gerais do usuário) vêm do próprio catálogo; não há tela nova no ERP.
    - **D23 mantida (PC-1 = A):** **não** se cria `pdv.venda.cancelar_venda_sessao_fechada` nem as quatro chaves
      `pdv.cancelamento_posterior_*` do plano; venda de caixa fechado continua sem cancelamento em lugar nenhum até a
      Fase 3 (pelo ERP). Testes do shared e do `CicloOnlineTests` falham se a permissão ou as chaves aparecerem.
    - **Perfis padrão:** Operador nenhuma; **Supervisor de caixa** as 4 de consulta (histórico, fechamentos,
      diagnóstico, pacote); Gerente e Administrador as 6 (o Gerente é `pdv.*` menos o `SOMENTE_MASTER`; o
      Administrador, tudo menos o `SOMENTE_MASTER`). `pdv.caixa.consultar_fechamentos` só mostra o fechamento:
      reimprimi-lo continua com `pdv.documento.reimprimir` (plano 3.1), e o rótulo no ERP não fala em reimprimir.
    - **Perfil de sistema "Encarregado"** (`chave_sistema = 'encarregado'`, PC-8 ao pé da letra: "Supervisor +
      vendas/caixas antigos + diagnóstico + pacote de suporte; sem histórico de uso e sem parâmetros"): para a loja sem
      gerente, quem libera no lugar do PIN do dono. Como o Supervisor de caixa já recebe as 4 consultas, o Encarregado
      tem **as mesmas permissões do Supervisor de caixa** (libera item, venda em andamento, sangria acima do limite,
      cancelar sangria/reforço, fechar ou operar o caixa de outro, PIX manual, forma com senha, vender sem estoque; vê
      as consultas da Central). **Não cancela a venda paga** (O6/D23: só o Gerente, e o caixa continua dizendo "só o
      gerente") — **revisto pelo dono em 05/11/2026: cancela a do caixa aberto (decisão 78)**. **Desconto acima do limite** não é permissão do perfil: vale o **Limite de desconto %** do usuário
      (PDV 12.3), que o dono define no cadastro dele. **Fica de fora** (continua com o Gerente ou o Master):
      `pdv.venda.cancelar_venda_finalizada` (até a decisão 78), `pdv.config.terminal` (configuração e restaurar backup),
      `pdv.config.fiscal`, `pdv.config.parametros_locais`, `pdv.auditoria.ver_local` (histórico de uso),
      `pdv.offline.estender` e o que é só do Gerente na matriz (lote vencido, horário restrito, crediário acima do
      limite, troca fora do prazo e em dinheiro). Só PDV (sem permissão do ERP, não entra no ERP). Ninguém recebe o
      perfil sozinho: o dono o escolhe no usuário. A descrição do perfil começa com "Perfil do sistema" e diz que
      libera ações no caixa.
    - **Pergunta ao dono — respondida em 05/11/2026 (sim; decisão 78):** o Encarregado ganha o cancelamento da venda paga
      do caixa aberto (muda a O6), ou basta usar o Supervisor de caixa? Se ele aprovar, entra num bloco próprio: o seed acrescenta a
      permissão ao perfil de sistema e incrementa `permissoes_versao`; os textos do caixa ("só o gerente" no
      `ServicoVenda` e na ajuda F1), a Prontidão (O6) e o roteiro do piloto mudam junto. A ordem é essa porque o seed
      só acrescenta: conceder antes e tirar depois exigiria uma migração de dados nas empresas já migradas.
    - **Empresas já criadas** (`aplicarSeedEmpresa`, rodado pelo pós-migração de `db:migrate:empresas` e
      `db:referencias`): insere o perfil que falta pela `chave_sistema`, acrescenta aos perfis de sistema só as
      permissões que faltam e incrementa `permissoes_versao` dos usuários de cada perfil que ganhou alguma (uma vez:
      reaplicar não muda nada). Correção no seed: se a empresa já tem um perfil **próprio** com o mesmo nome (o dono
      pode ter criado um "Encarregado" à mão), `uq_perfis_nome` derrubava o pós-migração; agora o de sistema entra
      como **"Encarregado (padrão)"** (depois "(padrão 2)", "(padrão 3)"…, sem limite, para nunca ficar sem nome) e o
      dela fica intocado, sem permissão nova. O "padrão" no nome separa os dois no seletor de perfil do usuário, que
      só mostra o nome (a lista de Perfis de acesso já marca o de sistema com o selo "padrão").
    - **Perfis personalizados:** **sem migração de concessão** (o plano pedia conferir o banco do piloto, que este
      fluxo não alcança). Nada que existe passa a exigir as permissões novas neste bloco, então nenhum perfil perde
      acesso; quem tem um perfil próprio só não vê as abas novas até alguém marcar a permissão no ERP. Antes do bloco
      que fechar algo hoje aberto (por exemplo o F11 › S atrás de `pdv.diagnostico.ver`), conferir na nuvem:
      `select p.nome, pp.permissao from perfis p join perfis_permissoes pp on pp.perfil_id = p.id and pp.excluido_em
      is null where p.chave_sistema is null and p.excluido_em is null and pp.permissao like 'pdv.%'`.
    - **Chaves da loja:** nenhuma nova. O plano previa a marca `sensivel` no catálogo de configurações para a aba
      Parâmetros mascarar; não há chave que desça ao PDV e seja segredo (`segredo` já existe e nunca desce em claro),
      então não se cria outra marca: um teste do shared garante que nenhuma chave com `pdv = true` é `segredo`.
    Testes: `permissoes.spec.ts` (grupo e liberação das 6, ausência das de cancelamento posterior, a tabela por
    perfil, o rótulo do fechamento sem "reimprimir", o Encarregado = Supervisor, sem cancelar venda paga,
    configuração, histórico nem ERP), `configuracoes.spec.ts`, `provisionamento.test.ts` (empresa "antiga" sem o
    Encarregado, com perfil próprio "ENCARREGADO" e o supervisor sem as permissões: o pós-migração cria "Encarregado
    (padrão)" com a lista do shared, não mexe no perfil dela, completa o supervisor e incrementa `permissoes_versao`
    uma vez; a segunda rodada não muda nada; com "Encarregado", "(padrão)" e "(2)" a "(9)" ocupados, entra
    "Encarregado (padrão 2)") e `CicloOnlineTests` (espelho das 6 constantes, supervisor e a declaração do
    Encarregado sem chave a mais no `perfis-padrao.ts`).

67. **Fundação de segurança e logs da Central (sem tela)** (Central do PDV, bloco G2; plano 3.3, 5.4 e 5.5; decisões do
    dono de 04/11/2026: PC-7 e D23 mantida; PDV 31.3, 32.1). As peças que impedem vazamento e o log limpo, antes de
    qualquer aba da Central (a tela chega no G3). **Nenhuma migração, nenhum contrato novo com a nuvem.**
    - **`ChavesExibiveis`** (`Data/Entidades/TabelasLocais.cs`, ao lado de `ChavesConfiguracaoTerminal.Internas`): lista
      de **permitidos** das chaves de `configuracao_terminal` que podem aparecer numa tela, no pacote de suporte ou no
      antes/depois da auditoria: as 16 da impressora e da gaveta e as do caixa (`tela.tema`, `tela.barra_funcoes`,
      `pesquisa.somente_numeros`, `backup.pasta_secundaria`). Chave fora das duas listas **não aparece**. O Data não
      conhece o Hardware nem o App, então a lista é de textos e o `ChavesTerminalTests` confere que batem com
      `ChavesHardware`, `ChavesPreferencias` e `ServicoTema`, que as duas listas não se cruzam, que toda constante de
      chave está em exatamente uma (inclusive as internas, por reflexão) e que **nenhum código** chama
      `Obter/Gravar/Remover/LerConfiguracao(es)Async` (ou o SQL da restauração) com a chave escrita à mão; o teste com a
      tela confere o banco depois da ativação real, da impressora, do tema e da pasta do backup. Chave nova (por exemplo
      `tela.bloqueio_inatividade_min`, no G11) entra numa constante e numa das duas listas.
    - **`MascaradorSuporte`** (`App/Servicos/Diagnostico`): um só, para o visor, o pacote e a auditoria, **por
      contexto** (nunca "toda sequência de dígitos"): `Bearer …` e `Authorization:` (só o esquema e a credencial; o resto
      da linha fica); o valor de `nome=valor` e `nome: valor` (solto ou entre aspas) e dos campos JSON (texto, número,
      lista ou objeto inteiros; também no JSON escapado dentro de outro, `\"token\":\"…\"`, e no JSON de uma célula de
      CSV, `""token"":""…""`) com nome sensível: `token`, `chave`, `senha`, `pin`, `secret`, `segredo`, `privada`,
      `authorization`, `cpf`, `cpf_cnpj`, `br_code`, `payload_pix`, `documento`, `email`, `telefone`, `celular`, sozinhos
      ou com prefixo/sufixo ligado por `_`, `.` ou em camelCase (`access_token`, `backup.chave`, `senhaPdvHash`,
      `accessToken`; `gaveta.pino` e `tipo_pinpad` não); CPF e CNPJ **pontuados**; BR Code lido campo a campo (EMV) do
      `000201` até o CRC (campo `63`), sem engolir o que vem depois; hash argon2 (`$argon2id$…`); bloco PEM de chave
      privada; a pasta do perfil (`C:\Users\fulano`, também escapada no JSON e com espaço no nome, e `/home/fulano` fora
      de um endereço) vira `%USERPROFILE%`; no Windows, o caminho exato do perfil desta máquina e a conta
      (`DOMÍNIO\usuário`, a que o log grava no "ativado com outra conta") viram `%USERPROFILE%` e
      `%USERDOMAIN%\%USERNAME%`. Idempotente. **Não** mascara `true`/`false` (as regras da loja que o suporte lê, como
      `pdv.permite_pin_curto`), o nome terminado em `_em` (data, como `token_expira_em`), o campo JSON `chave` sozinho
      (no PDV é a coluna com o **nome** da configuração) nem `payload_sha256`, GTIN-14, número da venda, uuid, valores ou
      CPF sem pontuação (não se distingue de um código; o campo `cpf_cnpj_*` é que mascara). Aplicado na exibição e na
      exportação, **não** no gravador do Serilog (nenhum log grava segredo hoje; o mascarador é a segunda barreira).
    - **Log** (`ConfiguracaoLog`, usado pelo `Programa` e pelos testes): `Microsoft.*` e `System.Net.Http.HttpClient.*`
      só a partir de `Warning` (acabam as 4 linhas do `IHttpClientFactory` por chamada: heartbeat a cada 30 s, pull,
      push); arquivo do dia até **20 MB** com `rollOnFileSizeLimit` (passou, `…_001.log` no mesmo dia), **30 arquivos**
      guardados (até 600 MB): 30 dias num caixa normal, menos num dia de erro em laço (os `_001`, `_002` contam). Cada linha leva o **código curto do terminal** depois do nível (`[INF] cx2-9f3a01bc Categoria …`),
      posto pelo `EnriquecedorTerminal` quando o `SessaoTerminal` recebe a identidade; antes dela a linha é **igual à de
      antes** (data, nível, categoria, mensagem; a exceção nas linhas seguintes). São dois formatos no mesmo arquivo (e
      os arquivos de versões anteriores só têm o sem código): o leitor do G8 aceita os dois. Nada de pessoa. O código (`IdentidadeTerminal.CodigoCurto`, sem coluna) usa os 8 **últimos** dígitos do `terminal_id` e
      não os 8 primeiros do plano: o UUIDv7 começa pelo horário e dois caixas ativados no mesmo minuto teriam o mesmo
      começo. Sem pacote NuGet novo.
    - **`IAutenticadorOperador.AutenticarParaCentralAsync`**: o PIN pelas regras do login (7.2: usuário, bloqueio por
      tentativas — o erro conta no **mesmo** bloqueio do terminal —, PIN, ativo, loja, `pdv.acesso.entrar`, totem) e o
      operador com as permissões efetivas, **sem abrir sessão de operador** (não troca o operador logado, não grava o
      `login`, não mexe no caixa). No espelho é o próprio `AutenticarAsync` (que nunca abriu sessão: quem abre é o
      `LoginViewModel`); a demonstração usa os operadores simulados.
    - **`AcessoCentral`** e **`AbasCentral`** (`App/Servicos/Diagnostico`, singleton): uma Central aberta por vez,
      `AbrirPelaVenda(operador)` ou `AbrirPeloLoginAsync(usuario, pin)` até o `Encerrar`. As 11 abas (0 a 9 e P) com a
      permissão de cada uma; Painel de saúde e Sobre com `pdv.acesso.entrar` (PC-7). **Liberar** (Ctrl+L na Central,
      não F2 como no plano 3.3: o F2 já é o "Salvar" das abas 3 e 7): usuário e PIN de quem tem `pdv.supervisor` (como
      toda liberação, 31.3) e alguma permissão liberável a mais; não o próprio usuário. Empresta **só dentro da Central**
      e **só as permissões de ver** as abas e as consultas (`acesso.entrar`, `venda.consultar`,
      `venda.consultar_historico`, `caixa.consultar_fechamentos`, `diagnostico.ver`, `auditoria.ver_local`,
      `diagnostico.pacote_suporte`). As de ação ficam fora mesmo quando abrem uma aba: `pdv.config.terminal` (aba
      Impressora e gaveta: editar, testar, abrir a gaveta, F5 a F8), `pdv.config.parametros_locais` (editar os
      parâmetros, fazer backup) e `pdv.documento.reimprimir` pedem a **própria liberação** (31.3, com o liberador no
      `autorizado_por_id`), como fora da Central; e **nunca** as sem liberação do catálogo (`pdv.config.fiscal`, que pede
      o PIN de quem a tem na hora da ação, e `pdv.caixa.ver_calculado_fechamento`, O3). A ação que a tela grava com uma
      permissão emprestada (o `exportar` do pacote, no G9) leva o `AcessoCentral.AutorizadoPor(permissao)` no
      `autorizado_por_id`. Vale até sair da Central ou **5 min sem uso**, contados pelo relógio **monotônico** (o do
      Windows pode ser acertado para trás ou para a frente; a hora do sistema fica só na auditoria e na contagem da
      tela). Só o **uso** renova: `RegistrarUso` (tecla, clique) e abrir uma aba pela liberação; `Tem`/`PodeAbrir` só
      consultam, para a tela redesenhar o menu e a contagem sem esticar a liberação. Expirada, é esquecida (e
      `AbasLiberadas` esvazia). É a única "elevação" do PDV (31.3 diz que a liberação vale só para a ação): a Central só
      empresta o ver, e o que muda algo continua pedindo a própria liberação. Sem motivo (não há ação a justificar; a
      `liberacao` sobe sem `depois.motivo`). A resposta do PIN que chega depois de sair (ou reabrir) a Central é
      descartada: nada é emprestado nem gravado em nome da Central que já acabou.
    - **Auditoria:** a liberação grava `liberacao` (já no catálogo da nuvem; sobe no lote) com `entidade = central_pdv`,
      `localizacao = pdv.central`, o usuário, o `autorizado_por_id` e no `depois` a origem (`venda` ou `login`), as abas
      e as permissões emprestadas. Entrar pelo login e abrir Sincronização, Logs ou Histórico de uso (uma vez por
      abertura, de novo depois de outra liberação, com o liberador quando a aba só abriu por ele) grava a ação **local**
      `central_acessada`: fica fora do `CatalogosNuvem.AcoesAuditoria`, o `OutboxSync` não a põe no lote e o lote com a
      `liberacao` continua válido (teste). Sem permissão a aba não abre e nada é gravado; a mesma aba apertada duas vezes
      seguidas grava um acesso só. O PIN recusado ao **entrar pelo login** grava o `login_negado` (`localizacao =
      pdv.central`, o motivo e o `depois.login_informado`), como o login do caixa: sobe e vira `historico_logins`, e quem
      testa PINs pela engrenagem aparece no ERP. O PIN recusado no **Liberar** não grava nada, como o diálogo de liberação
      da 31.3 (conta no mesmo bloqueio; a liberação não é um login).
    - **Desativação (D22):** o gatilho recusa a auditoria; a `RegraNegocioException` vira `SomenteLeitura` (a Central
      continua só para ver) e a liberação é recusada com a mensagem da trava: sem a `liberacao` gravada, nada é
      emprestado. Já só leitura, o Liberar devolve a mensagem sem conferir o PIN (não roda o argon2 nem gasta tentativa
      do bloqueio).
    - Fora deste bloco: as telas (G3 em diante), o leitor do arquivo de log (G8), o pacote (G9) e o bloqueio por
      inatividade (G11). Não se criou `pdv.backup.restaurar` nem tempo de liberação configurável (plano 3.2).
    Testes: `MascaradorSuporteTests` (tabela do que mascara, do que não pode mascarar, o perfil e a conta do Windows com
    espaço no nome e a linha com segredos plantados), `ChavesTerminalTests` (também: toda constante de texto com o
    prefixo de uma chave do terminal está na lista do teste), `ConfiguracaoLogTests` (a composição real do
    `IHttpClientFactory` com 5 heartbeats: com a configuração de antes saem as linhas do HttpClient, com a nova nenhuma;
    o aviso dele e o `Information` do PDV continuam; o código do terminal só depois da identidade; a virada para o
    `_001` com um limite pequeno) e `AcessoCentralTests` (abas do operador, liberação com as abas e sem as de ação nem
    as sem liberação, `AutorizadoPor`, 5 min que só o uso renova e pelo relógio monotônico, recusas sem auditoria, o
    `login_negado` da entrada pelo login no lote, `central_acessada` uma vez por abertura, o lote sem ela, D22 sem
    conferir o PIN, a resposta do PIN depois de sair descartada e, com a tela e o espelho de verdade, o PIN da Central
    no mesmo bloqueio do login e sem sessão de operador).

68. **Casca da Central do PDV e a aba Impressora e gaveta** (Central do PDV, bloco G3; plano 1, 3.3 e 4; decisões do
    dono de 04/11/2026: PC-7 e D23 mantida; PDV 6, 28.2, 31.3). A antiga tela de configuração do terminal vira a
    **Central do PDV** (a engrenagem ⚙), sem mudar o que já funcionava. **Nenhuma migração, nenhum contrato novo com a
    nuvem, nenhuma permissão nova.**
    - **Onde abre:** no login, **Ctrl+Alt+C** ou o botão **⚙ Central do PDV** (usuário e PIN pelas regras do login, sem
      sessão de operador, `AcessoCentral.AbrirPeloLoginAsync`; o PIN recusado grava o `login_negado`); na venda, **F11 ›
      8** ou o **⚙ Central** no fim da barra de funções (o 16º botão, "F11 › 8": a barra de 0.9.1 fica em 2 linhas de
      8, sem cortar rótulo em 1366 nem em 1920), com o operador logado e as permissões dele. Na venda só com o **caixa
      livre** (a mesma mensagem do F11 › 3); nos dois lugares, nunca durante a **confirmação da desativação** (D22,
      `ServicoCaixa.MensagemConfirmandoDesativacao`, como o logout). A legenda em texto (barra "Texto", 0.9.1), o F1 e o
      F11 dizem onde fica.
    - **Tela** (`ViewModels/Central/CentralPdvViewModel`, `Views/Central/CentralPdvView`): cabeçalho com loja, caixa e
      quem está na Central ("MARIA (operador do caixa)", "CARLOS (entrou pelo login)"); menu lateral com as 11 abas de
      `AbasCentral` (0 a 9 e P), que **rola** quando não cabe (a janela na altura mínima de 700 px com as duas faixas);
      **dígito** (ou `NumPad`, ou `P`) com o foco no menu, **clique** ou Enter no botão. Todos os botões da Central, os
      da aba 3 inclusive, têm no mínimo **44 px** (plano 4; o `Button.acao` do resto do caixa continua com 42). Abre no
      **Painel de saúde** (PC-7). A aba que a pessoa não pode ver tem o **cadeado** (a que só
      abriu pela liberação, o cadeado aberto). Esc: dentro de uma aba volta ao menu; no menu sai para o login ou a venda
      (as duas pelo botão também; o rodapé diz os dois). Se a venda não carregar na volta (banco ocupado, erro de
      leitura), a Central continua ativa com a mensagem e o Esc tenta de novo (quem encerra a Central é a troca de
      página, não o Esc). Toda tecla e todo clique na Central contam como uso da liberação
      (`AcessoCentral.RegistrarUso`); um relógio de 1 s só redesenha os cadeados e a faixa (não renova nada) e, quando a
      liberação acaba (5 min sem uso), a aba que só abria por ela volta ao Painel com o aviso. Sair da Central por
      qualquer caminho (Esc, restaurar backup, desativação ou revogação trocando a tela) acaba a liberação: o
      `ShellViewModel` chama o `Encerrar` ao trocar de página.
    - **Liberar** (Ctrl+L, o botão, ou o clique numa aba de **consulta** com cadeado): usuário e PIN do supervisor num
      diálogo sobre a Central, a mensagem de recusa sem fechar, e a aba pedida abre sozinha depois do PIN; a faixa azul
      diz quem liberou, as abas e até que horas vale sem uso. É o `AcessoCentral.LiberarAsync` do G2 (só as permissões
      de ver; auditoria `liberacao`). Quando quem liberou não vê a aba pedida (o Encarregado e o Histórico de uso,
      PC-8), a liberação vale para as outras e a mensagem diz "ENCARREGADO não vê a aba 6 Histórico de uso".
    - **Aba 3 "Impressora e gaveta"** (`AbaHardwareViewModel`, antes `ConfiguracaoTerminalViewModel`, movida com o
      histórico): a configuração de antes, inteira — impressora, gaveta, o bloco **Tela do caixa** da 0.9.1 (barra de
      botões ou texto, pesquisa só por números), a fila de impressão, F2/F5/F6/F7/F8 e, **só na Central aberta pelo
      login**, F9 Restaurar backup. Como `pdv.config.terminal` é permissão de **ação** (o Liberar da Central não a
      empresta), a aba com cadeado **abre e pede ela mesma** o usuário e o PIN de quem a tem (31.3, sem motivo, como o
      Ctrl+Alt+C de antes): `IAutenticadorOperador.LiberarAsync` com o usuário da Central como solicitante (o próprio
      usuário não libera). Abre direto: na venda, com `pdv.config.terminal` do operador (como o F11 › 8 de antes); pelo
      login, só com `pdv.config.terminal` **e** `pdv.supervisor` de quem entrou (o que o Ctrl+Alt+C de antes exigia; o
      perfil personalizado com a permissão sem supervisor pede a liberação, e a prontidão do ERP continua certa). O menu
      segue a mesma regra: a aba 3 tem o cadeado enquanto pede a liberação e o cadeado aberto depois da liberação dada nela. A
      auditoria: na venda, o operador e quem liberou; pelo login, quem entrou com as duas permissões fica também como
      quem autorizou; com a liberação na aba, quem está na Central e quem liberou. A liberação dada **na aba** vale só
      enquanto ela fica aberta: trocar de aba descarta a aba e a volta pede o supervisor de novo (como sair da
      configuração de antes; senão a gaveta, F6, e a configuração ficariam abertas em nome do supervisor até sair da
      Central). A aba aberta com a permissão do próprio usuário fica a mesma ao trocar de aba e voltar. As teclas
      também são **botões** (F2 Salvar … Esc Voltar ao menu) que não tiram o foco do campo; o "F9 Restaurar backup" só
      aparece pelo login e depois da permissão.
    - **Restaurar backup: PIN na hora** (plano 3.3). O F9 abre a tela do C17, que pede **sempre** o usuário e o PIN de
      quem tem `pdv.supervisor` e `pdv.config.terminal` (`LiberarAsync` com o solicitante vazio: pode ser o próprio
      gerente que entrou), mesmo que a Central já tenha conferido o PIN da entrada ou que a aba tenha sido liberada: a
      Central aberta e esquecida no caixa não restaura um banco em nome de ninguém. A aba fica ocupada enquanto a lista
      de backups carrega, e o `ShellViewModel.IrParaRestaurarBackupAsync` só troca a página se a Central que pediu
      ainda estiver na frente (quem saiu dela nesse meio-tempo não recebe a restauração por cima do login).
    - **As outras abas** (Painel, Vendas, Caixas, Sincronização, Logs, Histórico de uso, Parâmetros, Backup, Sobre,
      Pacote) mostram, por ora, o que vão trazer (texto para o dono) e "chega numa próxima atualização": elas chegam nos
      blocos G4 a G11, todas na 0.10.0 (a versão continua 0.9.1 até lá). Abrir Sincronização, Logs e Histórico de uso já
      grava o `central_acessada` (G2).
    - **Desativação (D22):** durante a confirmação a Central **não abre** (o ⚙ e o F11 › 8 da venda, o Ctrl+Alt+C e o
      ⚙ do login e a entrada com o PIN, sem conferir o PIN). Quando a trava chega com a Central já aberta, ela fica: a
      auditoria recusada vira a faixa vermelha "só para consulta", salvar na aba 3 mostra a mensagem da trava sem sair
      da tela e o Liberar é recusado sem conferir o PIN.
    - Mudou de texto: o F11 › 8 ("⚙ Central do PDV"), a dica do "🖶 Sem impressora", a mensagem da gaveta desligada e o
      título do "Restaurar backup" ("Central do PDV › Restaurar backup"; o Esc dele continua indo ao login, como
      antes), o erro do dispositivo de impressora do Linux ("confira a impressora na Central do PDV › 3 Impressora e
      gaveta") e o roteiro do piloto (F11 › 8 › 3). A `localizacao` da auditoria da impressora
      continua "PDV › Configuração do terminal" (o ERP já filtra por ela).
    Testes: `CentralTelasTests` (o ⚙ da barra abre no Painel com o foco no menu e os cadeados do operador; o dígito e o
    clique; Esc à venda sem gravar nada; com a venda em andamento nem o ⚙ nem o F11 › 8 abrem; a aba com cadeado pede o
    supervisor, recusa o PIN errado, abre depois do certo, grava `liberacao` e o `central_acessada` com quem liberou, não
    libera a aba 3; sair acaba a liberação; a liberação que acaba sem uso fecha a aba emprestada, com o uso renovando; o
    ⚙ do login com o PIN errado (`login_negado`) e o certo, sem sessão de operador; a D22 só leitura e as três recusas
    de abrir na confirmação; a liberação da aba 3 que acaba ao trocar de aba; pelo login, o TECNICO com
    `pdv.config.terminal` sem supervisor pedindo a liberação e o restaurar pedindo o PIN na hora; a restauração que
    carrega depois de sair não abre por cima do login; o Encarregado que não vê a aba pedida; o Esc que não consegue
    voltar à venda e tenta de novo; o menu que rola em 1024 × 700 e os botões de 44 px; o rodapé e o texto da aba
    Vendas; o `AutenticadorComExtras` dos testes traz o TECNICO e o ENCARREGADO) e os de antes
    adaptados ao caminho novo: `ImpressoraTelasTests` (F11 › 8 › 3 com a liberação na aba, F7 da fila, F9 inexistente
    pela venda; Ctrl+Alt+C › 3 testa, grava e audita com o CARLOS como antes), `UsabilidadeTelasTests` (16 botões na
    barra, a aba 3 pelo mouse, o bloco Tela do caixa) e `RestaurarBackupTelasTests` (a MARIA na Central não vê o F9 nem
    libera a si mesma; o CARLOS libera a aba, o F9 pede o PIN de novo, a MARIA não libera a restauração e o CARLOS
    sim, que fica no `autorizado_por_id` do `restaurar`).

69. **Painel de saúde, Sobre o terminal e o disco quase cheio** (Central do PDV, bloco G4; plano 4 e 4.1; decisões do
    dono de 04/11/2026: PC-7; spec 6.1, 32.2). O operador vê o que está errado e o que fazer, sem PIN e sem internet.
    **Nenhuma migração, nenhum contrato novo com a nuvem, nenhuma permissão nova** (a versão continua 0.9.1).
    - **`VerificadorSaude`** (`App/Servicos/Diagnostico`): as 12 verificações de `Verificacoes/` (`IVerificacaoSaude`),
      **todas locais** (banco local, memória e disco; nada vai à nuvem), rodadas **em paralelo** com `Task.Run` (fora da
      tela) e **2 s cada** (`OpcoesSaude.LimitePorVerificacao`): a que trava ou falha vira um item amarelo "não deu para
      conferir agora" (mensagem mascarada) e as outras aparecem assim mesmo — o tempo total fica no limite, nunca na
      soma. A que passou do limite e ainda roda não é disparada de novo (a rodada seguinte espera a mesma: uma thread
      presa, nunca uma por minuto). Cada verificação lê só o que mostra (contagens e a linha mais recente, pelo índice
      quando há; nunca a tabela inteira na memória). Ordem do Painel: vermelho, amarelo, verde; dentro da cor, a do
      plano. Os limites ficam em `OpcoesSaude` (constantes do código, não chaves da loja). Antes de restaurar um backup
      (C17), junto do backup e do sync, o `MonitorSaude` para e o `VerificadorSaude.SuspenderAsync` espera as
      verificações em curso (até 10 s) e não deixa outra começar até o app reabrir: no Windows, uma conexão aberta no
      `pdv.db` impediria a troca do arquivo. Cada item tem a frase, o **o que fazer** e, quando ajuda, um botão
      (abrir a aba certa ou Sincronizar agora):
      | Item | Amarelo | Vermelho |
      |---|---|---|
      | Internet e envio ao ERP | sem internet com a fila em dia; online com registro esperando envio há mais de 1 h | terminal bloqueado pela nuvem (revogado, hardware, regressão, token, 403); **sem internet com a fila parada** (registro esperando há mais de 1 h); com `pdv.dias_max_offline` preenchida, a um dia de parar de vender |
      | Registros recusados | — | algum `rejeitado` no outbox: "quem resolve é o ERP, em Cadastros › PDVs / Terminais › este caixa › Eventos com erro" |
      | Sequência (lacuna, C15) | lacuna recuperável | lacuna a declarar (F11 › S › F4, supervisor fiscal) |
      | Relógio (C16) | desvio da nuvem > 2 min | > 5 min (os limites do ERP) ou `relogio_regrediu` nas últimas 24 h |
      | Impressora | sem impressora configurada; comprovante esperando | comprovante que falhou (o erro, F7 na aba 3) |
      | Gaveta | — | o último pulso falhou (deste processo, ou o último registro da gaveta no `log_local` é a falha, nas 24 h) sem outro que deu certo depois; desligada é verde |
      | Disco (spec 32.2) | < 1 GB livre | < 200 MB (abrir caixa novo bloqueado) |
      | Backup | caixa aberto (há mais de 15 min) e o último sucesso há mais de 4 h, ou nenhum | a última tentativa deste processo falhou depois do último sucesso |
      | Banco local | — | o `integrity_check` da abertura falhou (guardado em `EstadoBanco`; o Painel nunca o roda) |
      | Caixa aberto | há mais de `pdv.horas_alerta_sessao` | de dia operacional anterior ("F11 › 3") |
      | Versão | — | abaixo da mínima da nuvem (o como atualizar de sempre) |
      | Erros recentes | erro no `log_local` nas últimas 24 h: só a quantidade e a hora do último (o texto fica na aba 5) | — |
      **Sem internet com a fila parada é vermelho** (o "pronto quando" do G4: o operador vê o ⚠ na venda e, no Painel,
      o que fazer e o código do terminal), com o mesmo limite de 1 h do amarelo online; a tabela do plano 4.1 só punha o
      vermelho perto do `pdv.dias_max_offline` (nula por padrão, O18), e aí o caso do critério de aceite nunca acendia o
      ⚠. Sem internet com a fila em dia (nada esperando há mais de 1 h) continua amarelo: a venda segue e nada está em
      risco. Se o dono preferir o ⚠ só mais tarde, o limite é o `OpcoesSaude.PendenteAntigo`. **Erros recentes** mostra
      só a quantidade e a hora: o Painel abre sem PIN (PC-7) e a mensagem pode ser a de qualquer exceção (com nome, CPF
      sem pontuação ou trecho de payload que o mascarador não reconhece); o texto fica na aba 5, que pede
      `pdv.diagnostico.ver`. O motivo da recusa do ERP e o erro da impressora continuam na frase (mascarados).
      Para a gaveta e o backup, o `ServicoGaveta` guarda o último pulso bom e o que falhou (`UltimoPulsoOkEm`,
      `UltimaFalhaEm`) e grava a falha da venda e do movimento também no `log_local` (antes só o teste e o F11 › 9
      gravavam); o primeiro pulso bom depois de uma falha registrada grava "A gaveta voltou a abrir" (`info`, origem
      `gaveta`; uma linha por recuperação, a consulta uma vez por processo), e o Painel compara o último registro da
      gaveta: o app reaberto não fica vermelho por até 24 h por uma falha que já passou. O `ServicoBackup` guarda a
      última falha (`UltimaFalha`). O Painel não declara lacuna, não reprocessa nem
      mexe na impressora: as teclas de hardware (F5 a F8) continuam na aba 3, que pede ela mesma `pdv.config.terminal`.
    - **Aba 0 Painel de saúde** (`AbaPainelViewModel`/`AbaPainelView`; `pdv.acesso.entrar`, sem PIN, PC-7): abre já
      verificando, com o resumo ("2 problemas e 1 ponto de atenção · verificado às 14:32") e o **código do terminal para
      o suporte** (decisão 67) no topo; verifica de novo a cada visita. Foco: a Central abre com o foco no menu (o dígito
      escolhe a aba, como no G3); o **0 de novo** (ou Enter no botão da aba) leva o foco à lista; ↑/↓ escolhem a linha,
      **Enter faz a ação dela**, **F5** verifica de novo, **Ctrl+Alt+S** sincroniza agora (a demonstração diz que não
      sincroniza) e **Esc** volta ao menu. A rodada refaz a lista: se o foco estava na aba (na lista, ou na própria aba
      pelo 0 de novo antes da primeira rodada terminar), ele volta à linha escolhida, e ↑/↓, Enter e F5 seguem sem
      clique. Tudo também pelo mouse: o botão de cada linha e os de baixo (os botões do
      caixa não recebem o foco, decisão 65). A bolinha tem a palavra ao lado (OK, ATENÇÃO, PROBLEMA) para quem não
      distingue as cores.
    - **Aba 9 Sobre o terminal** (`AbaSobreViewModel`/`AbaSobreView`; `pdv.acesso.entrar`, sem PIN): empresa (código e
      razão social do resumo da ativação), loja, caixa, o código curto e o `terminal_id` completo, o servidor (só o
      host; "Demonstração" sem nuvem), a situação, quando foi ativado, o nome do computador, a versão do app, as
      migrações aplicadas e a última, o sistema, o disco livre e o tamanho e a pasta do banco, dos logs e dos backups
      (lidos fora da tela; as pastas pelo `MascaradorSuporte`). Nada secreto. **Enter** (ou Ctrl+C, ou o botão) copia
      "código · terminal id · versão" para a área de transferência (montado já ao abrir a aba, da identidade em
      memória: o Enter antes de terminar de carregar copia o certo); sem ela, a tela diz o código a ditar. F5 atualiza,
      Esc volta ao menu; o 9 de novo leva o foco à aba.
    - **Ícone ⚠ na barra da venda** (ao lado da conexão): o `MonitorSaude` roda a rodada **barata** (o disco sem somar
      as pastas) a cada **60 s**, ligado depois do banco conferido (como o backup periódico); a barra só lê o resultado
      guardado (`VerificadorSaude.Ultimo`) no relógio de 1 s, nada roda na tela. Com item vermelho aparece "⚠ Disco" (ou
      "⚠ 2 problemas"), com a frase na dica; o clique abre a Central no Painel com as regras do ⚙ (caixa livre, fora da
      D22). O Painel aberto também atualiza o ícone.
    - **Disco quase cheio** (spec 32.2 revista; plano 4.1): abaixo de **200 MB** livres o caixa **não abre sessão nova**
      (`DiscoCheioException` no `ServicoCaixa.AbrirAsync`; gravar com o disco cheio pode corromper o banco), mas **a venda
      em curso nunca é bloqueada** (a spec dizia "bloqueia novas vendas": não bloqueia, o risco é parar a loja num falso
      positivo). Na tela de abertura, depois do fundo e da diferença do turno herdado conferidos, o operador pede o
      supervisor (`pdv.supervisor`, usuário, PIN e motivo na hora, 31.3; o próprio usuário não libera) e, liberado, a
      abertura segue sozinha; Esc no pedido deixa o aviso do disco e nada é gravado. O supervisor logado confirma com
      outro Enter, e a `liberacao` dele leva o motivo fixo "Disco quase cheio: abertura liberada pelo próprio supervisor
      logado" (o motivo é obrigatório na liberação). O log de texto (Serilog, que vai no pacote de suporte) grava o id
      de quem liberou, nunca o nome; o nome fica na auditoria. A liberação vale **1 h** para qualquer abertura deste caixa, medida pelo relógio monotônico (acertar a hora
      do Windows não a estica; some ao fechar o app), e grava a `liberacao` (já no catálogo; sobe no lote) com o livre
      e a validade no `depois`; na D22 nada é gravado nem liberado. A abertura automática (`pdv.solicita_abertura_caixa`
      desligada) com o disco quase cheio vira a tela de abertura, que diz por quê, mostra o fundo herdado só leitura (sem
      observação nem F2) e pede a liberação; liberada, abre **como a automática** (`abertura_automatica`, o fundo
      herdado ou 0,00, sem pedir `pdv.caixa.abrir` nem abrir a gaveta), não como a manual. Sem como medir o disco, não
      bloqueia. O `MedidorDisco` mede o disco da pasta de dados (o do `pdv.db`), como o `disco_livre_mb` do heartbeat.
    - Fora deste bloco: as abas 1, 2, 4 a 8 e P continuam mostrando o que vão trazer (G5 a G11); o filtro da aba 5 pelo
      item do Painel chega com ela (G8); o `saude.json` do pacote, no G9; o ERP mostrar a saúde do terminal, no G15
      (decisão 77).
    Testes: `PainelSaudeTests` (sem tela: as 12 na ordem do plano; cada verificação em verde, amarelo e vermelho com o
    estado simulado — sync (offline com a fila parada vermelho, com a fila em dia amarelo), outbox,
    `pdv.dias_max_offline`, relógio pelo desvio e pela regressão, fila de impressão, gaveta pelo log local e pelo pulso
    (e o app reaberto depois do "voltou a abrir", uma linha por recuperação), disco nos limites, backup que falhou,
    banco, versão mínima e erros sem o texto; uma rodada completa e a barata sem nenhum `integrity_check` entre os
    comandos SQL e sem chamada à nuvem; a verificação travada e a que lança não seguram o Painel, que termina perto do
    limite de uma; a presa de forma síncrona não é disparada de novo a cada rodada; a suspensão para a restauração
    espera a rodada em curso e não começa outra) e
    `PainelSaudeTelasTests` (o ícone ⚠ que aparece com o disco e a impressora em vermelho e abre a Central no Painel
    pelo mouse, o vermelho primeiro com o que fazer e o código do terminal, o 0 de novo levando o foco à lista e o Enter
    da linha abrindo a aba 3, o F5 e o Ctrl+Alt+S, nada gravado só por olhar; o caixa aberto há 30 h e de dia anterior
    e o backup velho; o Sobre com o código, o id, a versão e o banco, e o Enter que copia; o disco quase cheio
    recusando a abertura da MARIA, o CARLOS liberando com o PIN e o motivo, a `liberacao` gravada, a venda finalizada
    com 150 MB livres e a liberação que acaba depois de 1 h; o Esc no pedido do supervisor; o supervisor logado
    confirmando com outro Enter, com o motivo fixo; a abertura automática liberada que abre como a automática com um
    PIN só; o caixa já aberto vendendo com o disco caindo para 150 MB, sem liberação, e a liberação recusada na D22; o
    foco que volta à lista depois da primeira rodada e do F5; o Sobre com o texto a copiar antes de carregar), mais o
    `CentralTelasTests` adaptado (o Painel e o Sobre de verdade no lugar do "chega numa próxima atualização") e o
    `RestaurarBackupTelasTests` (o Painel suspenso depois da restauração).

70. **Vendas na Central: o caixa aberto e os fechados dos últimos 30 dias** (Central do PDV, bloco G5; plano 4.2 e 5.3;
    decisões do dono de 04/11/2026: D23 mantida, PC-11 e o limite de **30 dias** no lugar dos 90 do plano; PDV 22.1,
    22.2). A aba **1 Vendas** acha e reimprime uma venda antiga sem internet. **Nenhuma migração, nenhum contrato novo
    com a nuvem, nenhuma permissão nova** (a versão continua 0.9.1).
    - **Escopo** (`ConsultasHistoricoLocal`, Data): o **caixa aberto** deste terminal (de qualquer data) e os **fechados
      nos últimos 30 dias**, contados pelo **dia operacional** (o começo do dia de 29 dias atrás, com o fuso e a hora de
      corte da loja, `DiaOperacional.Inicio`; o fechamento a partir dele). Mais antigo, só no ERP (Vendas / Fechamentos
      de caixa); o banco local não apaga nada (PC-11). O teto fica **no SQL**: o caixa de 31 dias, ou de outro terminal,
      volta vazio mesmo pedido pelo id. O filtro "Caixa" (`F3`/`Shift+F3` ou a lista) tem o **caixa aberto primeiro**
      ("desde 08:02 · MARIA · 12 vendas", o padrão, como o dono pediu), **"Todos os caixas dos últimos 30 dias"** (a busca
      da "venda 4512 da semana passada" sem saber o caixa: `1`, `F3`, o número) e cada fechado ("Fechado 03/11 18:30 ·
      aberto 03/11 08:00 · JOÃO · 85 vendas"). Sem `pdv.venda.consultar_historico` (a própria ou a emprestada pelo
      **Ctrl+L** da Central, decisão 67), só o caixa aberto: quem decide é o `ServicoHistoricoVendas` (App), que lê a
      permissão do `AcessoCentral` ele mesmo (quem chama não passa a permissão; fora da Central, sem usuário, só o aberto)
      e troca qualquer caixa pedido pelo aberto (a tela não é a única barreira); a soma das pagas também é decidida lá
      (só a permissão do próprio usuário, O3). A faixa diz como liberar. A liberação que acaba (5 min sem uso) devolve a
      lista ao caixa aberto com o aviso (o relógio de 1 s da Central confere) e fecha na hora o detalhe e o pedido do
      supervisor de uma venda de caixa fechado; o Ctrl+R ou o Enter que chega antes do relógio confere o histórico na hora
      e é recusado com o mesmo aviso (nada sai de novo). Com o histórico, a última página (ou a busca sem nada) diz "mais de 30
      dias: consulte no ERP"; o caixa escolhido que passa dos 30 dias (a hora de corte virou o dia) sai da lista com esse
      aviso, não com o de liberação acabada.
    - **Filtros no SQL**: número (inteiro, como o F12: o de exibição completo sem diferenciar maiúsculas, só os dígitos
      sem os zeros, o novo da nuvem do "Aplicar com novo número", T27) ou CPF/CNPJ com ou sem máscara; situação (`F4`:
      todas, pagas, canceladas); operador; forma (as usadas no alcance); valor de/até. **50 por página por cursor**
      (hora desc, número desc; a hora é a finalização ou, na em andamento cancelada, o cancelamento), `PgDn` mais
      antigas, `PgUp` volta (os botões também), sem repetir nem pular com várias vendas na mesma hora. Rodapé "Vendas 51
      a 62 de 62 · página 2" e, **só para quem vê o calculado do caixa** (`pdv.caixa.ver_calculado_fechamento`, O3), a
      soma das pagas do filtro (na primeira página). `F6` limpa (volta ao caixa aberto), `F5` lê de novo.
    - **Lista e detalhe**: número (e o novo da nuvem), data e hora, operador, total, formas, o **CPF mascarado**
      (`***.456.789-**`; CNPJ `**.345.678/0001-**`), o caixa ("aberto" ou "fech. 03/11") e o selo **CANCELADA** ou
      **CANCELADA DEPOIS** (`cancelada_em` depois do `fechada_em` do caixa dela: nenhum caminho do PDV faz isso, D23; o
      selo só aparece se o dado chegar assim, sem recalcular nada). **Enter** (ou o duplo clique) abre o detalhe: o
      operador, o caixa da venda (aberto em, por quem, fechado em), os itens, os pagamentos, as liberações, o
      cancelamento e o **CPF inteiro** (as linhas são as do Enter do F12, `TextoDetalheVenda`). O atalho para a aba 2
      Caixas (`F7`) chegou com ela (G6, decisão 71).
    - **Ações**: **Ctrl+R** a 2ª via (`ServicoVenda.ReimprimirAsync`, que não depende da sessão: o comprovante original
      da fila com a marca; aberta pelo login, sem operador no caixa, quem está na Central assina a auditoria) com a
      `localizacao` "PDV › Central do PDV › Vendas"; sem `pdv.documento.reimprimir`, o **supervisor libera na hora**
      (31.3: usuário, PIN e motivo, sobre a aba; o liberador no `autorizado_por_id`), porque a liberação da Central só
      empresta o ver. Com a permissão própria, a venda de caixa fechado achada só pelo histórico emprestado leva no
      `autorizado_por_id` quem o emprestou (o contrato do `AcessoCentral.AutorizadoPor`). O comprovante **gerado de
      novo** (sem o original na fila, por exemplo depois da restauração e da reidratação, C17) sai com o **operador da
      venda** (o nome pelo `operador_id` dela), nunca o de quem reimprime (vale também para o F12 depois da troca de
      turno). Com o detalhe aberto, Ctrl+R e Ctrl+Del agem sobre a venda **do detalhe**, não sobre a escolhida da lista;
      a releitura (o relógio, a volta à aba) que tira essa venda da lista fecha o detalhe e o pedido do supervisor, e o
      F5 não relê com eles abertos.
      **Ctrl+Del**: venda de **caixa fechado não se cancela no PDV** ("só se consulta e reimprime"; D23 mantida, o dono
      espera a Fase 3); a paga do **caixa aberto**, pela Central aberta na venda, sai para a venda com o **F12 nela** e o
      diálogo do cancelamento de sempre (o gerente ou o encarregado, a devolução por pagamento, o motivo; se ela não
      estiver no F12, nada abre); pela Central do login, a mensagem "entre no caixa e use o F12".
    - **F12 continua o mesmo** (Enter, Ctrl+R, Ctrl+Del, com a venda em andamento para reimprimir) e ganha o **F3
      "Caixas anteriores"** (e o botão), que abre a Central › 1 Vendas com as regras do ⚙ (caixa livre, fora da D22).
      Desvio do plano 4 ("F12 abre a aba Vendas"): o F12 é da tela de venda (funciona com a venda em andamento, o
      cancelamento mexe na gaveta e no troco da venda) e a Central exige o caixa livre; o F12 virou o caso particular
      "uma sessão" da mesma consulta (`ConsultasVendaLocal.VendasDaSessaoAsync` chama a `ConsultasHistoricoLocal`, com os
      filtros no SQL no lugar do filtro em memória). O F1 e o F12 dizem onde fica.
    - **Foco e mouse** (decisão 65): o `1` abre a aba já com o foco no campo do número (como a aba 3; o `1` de novo volta
      a ele; pelo F3 do F12 também, mesmo quando a aba fica pronta antes da tela da Central e o menu tomaria o foco); ↑/↓, Enter, Ctrl+R e as teclas F funcionam dali; Esc fecha o pedido do supervisor, depois o detalhe,
      depois volta ao menu. Toda ação tem botão de 44 px; caixa, situação, operador e forma são listas clicáveis e, ao
      fechar (escolhida pelo mouse ou pelo teclado), devolvem o foco ao campo (o ComboBox com o foco tomaria o Enter, o
      F4 e as setas); a lista cabe em 1024 × 700. A aba lê de novo a cada visita (os filtros ficam). **Teclado
      numérico** (plano 4): `+` mais antigas, `−` mais novas (só com o campo vazio: no CPF com máscara o `−` é o traço) e
      `*` abre o detalhe (onde ficam as ações da linha, Ctrl+R e Ctrl+Del, que o plano punha num menu); o caractere
      dessas teclas não entra no campo. Os nomes dos operadores são lidos fora da thread da tela.
    - **Sem migração** (o plano previa `IndicesHistoricoVendas`): medido com **120 mil vendas sintéticas em 90 dias**
      (o volume do plano; cerca de 40 mil nos 30 dias) **e o outbox como o da loja** (que não é expurgado: um
      `venda.finalizada` por venda com o payload de ~5 KB, que passa da página do SQLite, o `resultado` `{}` dos
      confirmados e alguns renumerados, o `venda.cancelada` das canceladas e os eventos de caixa), toda leitura entra
      pelos índices que já existem (`ix_vendas_sessao_caixa_id`, o da venda nos pagamentos, o do agregado no outbox) e a
      página fica em 25–55 ms (primeira, do meio, um caixa, número, CPF com e sem máscara, o número sendo digitado,
      operador + forma + valor, nada achado, forma que ninguém usou), longe dos 300 ms. O número novo da nuvem (T27)
      é o único que lê o `resultado` dos eventos do alcance (~40 mil, cada um depois do payload): ~125 ms, e só quando
      o texto cabe na faixa da renumeração (`ConsultasHistoricoLocal.InicioFaixaRenumeracao`, o
      `INICIO_FAIXA_RENUMERACAO` da API: acima de 9.000.000, com até 10 dígitos, inteiro ou no fim do número de
      exibição). Sem essa regra, cada tecla do CPF ou do número em "Todos os caixas" custava ~120 ms (medido); o teste
      confere que o CPF, o CNPJ e o número do caixa não fazem essa leitura. A consulta do caixa aberto de quem vê só
      ele é curta (`CaixaAbertoAsync`, sem contar as vendas dos 30 dias). Os índices do plano não seriam usados (o
      filtro do texto é um OR com o número em maiúsculas) ou trocariam o custo de lugar: um índice pela hora deixaria
      a primeira página instantânea, mas o filtro que acha pouco (CPF, forma rara) passaria a varrer **o histórico
      inteiro** em ordem (anos de vendas), e todo índice novo pesa em cada venda gravada. O teste confere o plano do
      SQLite: nenhuma leitura de vendas, pagamentos ou eventos varre a tabela (só a lista de sessões, algumas por dia).
      Sem coluna nova (o `EsquemaNuvemTests` não muda).
    - Fora deste bloco: a aba 2 Caixas e a reimpressão do fechamento (G6), a sincronização detalhada e as "vendas a
      copiar" (G7). Venda de caixa fechado continua sem cancelamento em lugar nenhum até a Fase 3.
    Testes: `ConsultasHistoricoLocalTests` (Data: o aberto primeiro e os fechados nos 30 dias deste terminal, o aberto
    antigo que conta, operadores e formas do alcance; filtros combinados e o teto mesmo pelo id; formas, número da
    nuvem e o selo só pelo dado; o cursor de 137 vendas em grupos da mesma hora sem repetir nem pular, a página exata
    sem página vazia; 120 mil vendas e o outbox delas com cada consulta abaixo de 300 ms, o plano sem varredura e o
    número novo da nuvem procurado só na faixa da renumeração; a consulta curta do caixa aberto),
    `DiaOperacionalTests` (o começo do dia operacional), `VendasCentralTelasTests` (a MARIA só com o caixa aberto e o
    serviço recusando o fechado pelo id sem a tela dizer a permissão; o CARLOS libera e a 4512 aparece em "todos", com o
    CPF mascarado, o detalhe com o caixa e o CPF inteiro, o Ctrl+Del recusado, a 2ª via auditada na Central com o CARLOS
    no `autorizado_por_id`, o caixa de 40 dias de fora com o aviso do ERP, F6 e Esc; o
    Ctrl+Del da venda do caixa aberto que abre o cancelamento do F12 nela e o F3 do F12 que abre a aba (e fica na
    mensagem com a venda em andamento); pelo login, o CARLOS com a soma das pagas, 62 vendas em duas páginas pelo teclado
    e pelos botões, o aviso do ERP na última página, o `+`/`−`/`*` do numérico (e o `−` do CPF com máscara), o detalhe
    da página 2 que fecha na volta à aba, a situação escolhida pelo mouse que devolve o foco ao campo (o F4 seguinte é
    da aba) e o TECNICO que reimprime com o CARLOS liberando na hora; a janela de 1024 × 700 com os botões de 44 px e o
    duplo clique; a liberação que acaba devolvendo a lista ao caixa aberto e fechando o detalhe e o pedido do supervisor
    da venda de caixa fechado (e o Ctrl+R antes do relógio, recusado), com a 2ª via gerada de novo no nome do operador da venda; o caixa que passa dos 30 dias
    com o aviso do ERP), o `CentralTelasTests` adaptado (a aba 1 de verdade, com o foco no campo) e o
    `CancelamentoFinalizadaDadosTests` de antes (o filtro do F12, agora no SQL, igual).

71. **Caixas na Central: o aberto e os fechados dos últimos 30 dias, como foram impressos** (Central do PDV, bloco G6;
    plano 4.3 e 5.2; decisões do dono de 04/11/2026: PC-9 opção A, PC-11 e o limite de **30 dias**, D23 mantida; PDV
    21.4, 21.6, 22.2). A aba **2 Caixas** acha e reimprime o fechamento de um caixa antigo sem internet e **sem recalcular
    nada**. Nenhum contrato novo com a nuvem, nenhuma permissão nova (a versão continua 0.9.1); **uma migração** só de
    índice (`IndiceFilaImpressaoDocumento`).
    - **Escopo e permissão:** os mesmos caixas da aba Vendas (decisão 70): o **aberto** deste terminal primeiro e os
      **fechados nos últimos 30 dias** pelo dia operacional (`ServicoHistoricoVendas.Desde`), mais antigos só no ERP; o
      teto fica no SQL (`ConsultasHistoricoLocal.SessoesAsync` e `RetratoAsync`: o de 31 dias, ou de outro terminal,
      não volta nem pedido pelo id). A aba pede `pdv.caixa.consultar_fechamentos` (a própria ou a emprestada pelo
      **Ctrl+L** da Central, decisão 67); quem decide é o `ServicoHistoricoCaixas`, pelo `AcessoCentral` (a tela não
      passa a permissão), e toda ação (`Enter`, `Ctrl+R`, `F6`, `F7`) confere de novo na hora (a liberação que acabou
      entre o relógio de 1 s e a tecla é recusada; o serviço também confere na lista, no detalhe e no resumo do dia).
      Quando a liberação acaba, o relógio da Central (`AbaCaixasViewModel.ConferirPermissoes`) esvazia a aba guardada: a
      lista, o detalhe, a 2ª via, o resumo e o pedido do supervisor (o PIN digitado depois não reimprime nada); a próxima
      visita lê de novo. Sem paginação: são alguns caixas por dia, lidos numa consulta.
    - **Como foram impressos (PC-9 A):** a fonte única é o **retrato** gravado no fechamento — `fechamentos_caixa` (tipo,
      hora, o que ficou na gaveta, o **total contado**, a justificativa e o `resumo` do turno, SYNC 9.6),
      `fechamentos_caixa_formas` (só o **contado** de cada forma) e as sangrias e os reforços da sessão (como o relatório
      21.4 os lista; a abertura, a sangria do fechamento e os estornos ficam de fora) — e os **bytes** do relatório na
      `fila_impressao`. **Nunca** o `RepositorioCaixa.ApurarAsync` nem os estornos escolhidos no outbox (recalcular
      mudaria o calculado das formas a prazo canceladas depois): os tipos que a aba lê (`CaixaHistorico`,
      `FechamentoRetrato`, `FormaContada`, `RetratoCaixa`) **não têm** o calculado nem a diferença (O3: só no ERP); o
      detalhe termina com "Calculado e diferença: só no ERP (Fechamentos de caixa)". O resumo guardado fora do contrato
      (por exemplo vindo da nuvem) só some do detalhe; nada quebra.
    - **Lista:** situação (ABERTO, Fechamento, Troca de turno, ou Fechado sem o retrato neste banco), abertura,
      fechamento, operador, vendas, o contado ("—" no aberto) e o **envio do `caixa.fechado` ao ERP** (enviado,
      aguardando, recusado pelo ERP — quem resolve é o ERP —, ou sem registro), lido sem o payload; e o selo
      **"canceladas depois: n · R$ x"** (vendas do caixa com `cancelada_em` depois do `fechada_em` dele: nenhum caminho
      do PDV faz isso, D23; o selo só aparece se o dado chegar assim, sem recalcular nada). Rodapé com a quantidade e
      "mais de 30 dias: consulte no ERP".
    - **Detalhe** (`Enter`, o `*` do numérico ou o duplo clique): operador, abertura e fundo, vendas, o fechamento (zerou
      ou o que ficou na gaveta), o contado por forma (Dinheiro primeiro), o total contado, a justificativa, o resumo do
      turno guardado (vendas, ticket médio, canceladas, itens cancelados, descontos e liberações), o envio, as sangrias
      e os reforços (hora, tipo, valor e os cancelados, como o relatório: quem retirou e a observação ficam no
      comprovante do movimento e no ERP, e o `MovimentoRetrato` nem os lê) e o bloco **"Depois do fechamento"** (número, valor e hora de cada
      cancelada depois, e "o fechamento impresso deste caixa não mudou"). O caixa aberto mostra o que já tem (abertura,
      vendas, sangrias e reforços) e diz que o fechamento ainda não foi feito. A venda local não guarda a sessão do
      cancelamento: "em que caixa o dinheiro saiu" fica para quando houver um cancelamento posterior (não há, D23).
    - **2ª via (`Ctrl+R`):** os **bytes originais** do relatório (o primeiro trabalho `fechamento_caixa` do fechamento na
      fila; a 2ª via entra como `fechamento_caixa_reimpressao` e não o troca) com a marca "2ª VIA - REIMPRESSÃO dd/mm
      hh:mm" do cupom (`LayoutComprovanteVenda.Reimpressao`). É o papel daquele dia, mas **o calculado não sai para quem
      não o vê**: o relatório que saiu com o calculado e a diferença (a loja fora do padrão O3: conferência ligada para
      quem tem `pdv.caixa.ver_calculado_fechamento`, fechamento não cego ou `pdv.imprime_calculado_no_fechamento`) só
      sai de novo, e só aparece na tela, para quem está na Central e o veria no próprio fechamento **pelas regras de
      agora** (`RegrasFechamento.ImprimeCalculadoNoRelatorio` com a permissão **própria** — ela não se empresta, e o
      supervisor que libera a reimpressão não a passa); os outros recebem "este relatório saiu com o calculado: consulte
      no ERP", antes do PIN e sem gravar nada (PC-9; a O3 vale também para a 2ª via). Saber se o original trouxe o
      calculado: pelo texto dos bytes (`ServicoHistoricoCaixas.TrazCalculado`, a palavra "calculado", que todo layout do
      fechamento com o calculado imprime desde o C10a — "Total calculado:" sempre — e o cego nunca); na dúvida (a
      palavra numa forma, na justificativa ou no nome da loja) vale como se trouxesse, nunca o contrário. Nenhuma coluna
      nova nem chave no `resumo` (que sobe no `caixa.fechado`): o original antigo também é reconhecido. A tela mostra o
      texto da 2ª via abaixo do detalhe e rola até ele (`BringIntoView`; ↑/↓ e PgUp/PgDn, ou o 8/2/9/3 do numérico,
      rolam o detalhe); pela lista, sem impressora (a única cópia é a da tela), o detalhe abre com ela. Sem o original
      (o banco recuperado pela nuvem, C17): "comprovante indisponível; consulte no ERP", **sem montar de novo** e sem
      gravar nada — e isso é conferido **antes** de pedir o supervisor. Pede
      `pdv.documento.reimprimir` (a própria, ou o supervisor na hora com usuário, PIN e motivo, 31.3: a liberação da
      Central só empresta o ver). Auditoria `reimpressao` (já no catálogo; sobe no lote) **antes** da impressora, com a
      entidade `fechamentos_caixa` (o nome da tabela, como as outras auditorias do caixa; o plano dizia `fechamento`), o
      id do fechamento, a `localizacao` "PDV › Central do PDV › Caixas", quem está na Central e no `autorizado_por_id` o
      supervisor da hora ou, sem ele, quem emprestou a consulta dos fechamentos; no `depois`, o documento, a sessão e o
      tipo. O caixa aberto não tem o que reimprimir (a mensagem diz que o relatório sai no F11 › 3).
    - **Atalhos entre as abas (`F7`):** na aba Caixas, "Vendas do caixa" abre a aba 1 com o filtro naquele caixa (os
      outros filtros limpos; sem o histórico de vendas, a aba 1 diz como liberar; sem a aba 1, o cadeado pede quem pode);
      na aba Vendas, "Caixa da venda" (na lista ou no detalhe) abre a aba 2 já no detalhe do caixa da venda (sem a aba 2,
      o cadeado; depois do PIN ela abre na lista). O pedido do supervisor deixado aberto na aba Caixas (a pessoa foi à
      aba Vendas pelo mouse) fecha quando o `F7` de lá abre o detalhe.
    - **Resumo do dia (`F6`):** o resumo diário do F11 › 6 (21.6) para o dia operacional do caixa escolhido, num painel
      sobre a aba (`Ctrl+P` imprime, `Esc` volta), com as regras de lá aplicadas a **quem está na Central**:
      `pdv.relatorio.resumo_diario` (ou o supervisor na hora; a `liberacao` gravada uma vez) e, para quem não vê o
      calculado, só as quantidades (O3). `ServicoCaixa.ResumoDiarioAsync` ganhou o parâmetro `quem` (a Central aberta
      pelo login não tem operador logado).
    - **Teclado e mouse** (decisão 65; o dono usa o numérico): o `2` abre a aba com o foco no painel da lista (o `2` de
      novo volta a ele); ↑/↓ escolhem (no detalhe, rolam; as setas ficam no code-behind porque os `KeyBinding` são
      lidos antes do túnel da tela), `Enter`/`*` detalhe, `Ctrl+R`, `F5` atualiza, `F6`, `F7`; `Esc` fecha o pedido do
      supervisor, depois o resumo, depois o detalhe, depois volta ao menu. A mensagem e o erro de um caixa não seguem
      para o detalhe de outro nem voltam à lista com o `Esc`. Toda ação tem botão de 44 px; a lista cabe em 1024 × 700.
      A aba lê de novo a cada visita.
    - **Índice da fila (`IndiceFilaImpressaoDocumento`, `ix_fila_impressao_documento` em `fila_impressao(tipo_documento,
      referencia_id)`):** a fila também não é expurgada (um cupom por venda, com os bytes), e o original do fechamento
      (e o do cupom, na reimpressão da venda) era procurado varrendo a tabela. Migração nova (a do G5 não existiu: a
      decisão 70 ficou sem índice); roda depois do backup `antes-migracao` como as outras; `fila_impressao` é só local,
      então o `EsquemaNuvemTests` não muda. Medido com o volume do G5 (120 mil vendas em 90 dias, o outbox e um cupom de
      1,5 KB por venda na fila, o fechamento de cada caixa): lista ~30 ms, detalhe ~5 ms, o original ~1 ms; nada que
      cresce com as vendas é varrido (a fila pelo índice novo; vendas, outbox, formas e movimentos pela sessão ou pelo
      fechamento). Só as tabelas de uma linha por caixa podem ser lidas inteiras (as sessões e, com poucos caixas, os
      fechamentos).
    - Fora deste bloco: a sincronização detalhada e as "vendas a copiar" (G7); o cancelamento de venda de caixa fechado
      continua fora do PDV (D23, Fase 3 pelo ERP); a sessão onde o dinheiro de uma cancelada depois saiu.
    Testes: `ConsultasHistoricoCaixasTests` (Data: o aberto primeiro e os fechados nos 30 dias deste terminal pelo
    retrato, o contado por forma, o resumo, as sangrias e os reforços do relatório, as canceladas depois só pelo dado, o
    envio, nenhuma propriedade de calculado ou diferença nos tipos lidos, o teto mesmo pelo id, o resumo fora do
    contrato, o original como o primeiro trabalho da fila, o volume sintético abaixo de 300 ms com a fila pelo índice
    novo) e `CaixasCentralTelasTests` (o fechamento de 15 dias reimpresso com os bytes originais e a marca, offline, sem
    o calculado nem a diferença na tela, auditado, e **nenhuma consulta da apuração** no banco durante a lista, o
    detalhe e a 2ª via — um interceptador de SQL que pega a apuração de verdade quando chamada —; o de 40 dias de fora;
    o F7 até as vendas do caixa e de volta ao detalhe; sem o original, "indisponível" sem gravar nada; o ENCARREGADO que
    reimprime e tira o resumo do dia com o CARLOS na hora — só as quantidades para ele (O3) e os valores quando a loja
    tira o fechamento cego —, cujo pedido esquecido não segura o F7 da aba Vendas, cujo "indisponível" vem antes do PIN e
    cujo F7 cai no cadeado da aba 1; a MARIA com a aba pela liberação da Central, o caixa aberto primeiro, o selo e o
    bloco das canceladas depois, o `*` do numérico, o duplo clique, os botões de 44 px em 1024 × 700 e a 2ª via do
    relatório com o calculado recusada; o CONFERENTE, sem ver o calculado, recusado do mesmo jeito, cujo F7 sem o
    histórico de vendas diz como liberar, e a 2ª via que sai quando a loja liga o calculado no relatório — pela lista,
    sem impressora, no detalhe, rolada até a vista e rolável pelo teclado em 1024 × 700; o TECNICO cuja liberação acaba
    com o pedido do supervisor aberto — a aba esvazia — e entre o relógio e o `F6`/`F7`, recusados na tela e no serviço),
    o `ImpressoraTests` (o relatório do fechamento reconhecido com e sem o calculado em 48, 42, 32 e 30 colunas, lido
    em outra largura) e o `MovimentosCaixaTelasTests` com o parâmetro novo do resumo.

72. **Sincronização na Central: as vendas que a nuvem ainda não confirmou ("vendas a copiar")** (Central do PDV, bloco
    G7; plano 4 e 5.5; pedido do dono de 04/11/2026, como no Nuvem3; decisões do dono: PC-7, D23 mantida; PDV 30.2,
    30.4; SYNC 7.2, 8.5, 8.6, 12.5). A aba **4 Sincronização** mostra o que não subiu, por quê e desde quando, sem tocar
    no que é do ERP. **Nenhuma migração, nenhum contrato novo com a nuvem, nenhuma permissão nova** (a versão continua
    0.9.1).
    - **Onde abre:** o **`⇅ N`** da barra da venda virou botão e abre a Central já na aba 4 (as regras do ⚙: o caixa
      livre, fora da D22; com a venda em andamento, a mensagem de sempre). A aba pede `pdv.diagnostico.ver` (a própria
      ou a emprestada pelo **Ctrl+L**, decisão 67): a MARIA clica no `⇅` e o pedido do supervisor já aparece com o foco
      no usuário (a `CentralPdvView` foca a liberação quando a Central nasce numa aba com cadeado); depois do PIN, a aba
      abre. Abrir grava o `central_acessada` (G2). O **F11 › S** continua (funciona com a venda em andamento e tem o
      F4 da lacuna) e ganha o **F3 "Lista completa"** (e o botão; a linha diz "F3  Lista completa: … (abre a Central › 4
      Sincronização; caixa livre)", para não ler como caminho de menu) para a aba 4, com a mesma regra do caixa livre. Desvio
      do plano ("F11 › S vira atalho"): o mesmo do F12 na decisão 70 — o status rápido é da tela de venda, a Central
      exige o caixa livre.
    - **Vendas não confirmadas (a primeira lista, o pedido do dono)** (`ConsultasSincronizacaoLocal.VendasNaoConfirmadasAsync`):
      uma linha **por venda**, não por evento (o `venda.finalizada` e o `venda.cancelada` dela juntos). **Vermelho
      RECUSADA** quando algum evento dela está `rejeitado` (com o motivo da nuvem); **amarelo** AGUARDANDO, ENVIANDO ou
      NOVA TENTATIVA (com as tentativas e a próxima); as recusadas primeiro, depois na ordem de envio (a menor sequência).
      A cor nunca vem sozinha: a palavra fica ao lado (PDV 9.1). **A confirmada sai da lista**; a que estava na tela e
      a nuvem confirmou (o envio passou ou o ERP reprocessou) fica **verde "✓ CONFIRMADA"** até a próxima leitura manual
      (F5, outra página, outra lista, outra visita): "a venda fica verde sozinha". A que estava na tela e o ERP
      **descartou** fica **sem cor, "DESCARTADA NO ERP · decisão final"**, nunca verde: o descarte é a decisão final e a
      nuvem não tem a venda (`VendasResolvidasAsync` devolve as confirmadas e as descartadas separadas; antes a descartada
      virava "✓ CONFIRMADA" na lista enquanto o detalhe dizia "descartada"). A lista acompanha o sync sozinha: o relógio de 1 s
      da Central (`AbaSincronizacaoViewModel.Tique`) relê quando os pendentes, os recusados ou a conexão mudam, ou a cada
      15 s (as tentativas andam), sem nada na thread da tela; o detalhe aberto acompanha também. A venda cujos eventos
      não confirmados foram todos **descartados no ERP** (decisão final) não aparece; o rodapé diz quantas.
      O `EVENTO_DIVERGENTE` (SYNC 8.4) é vermelho com "chame o suporte" no lugar do ERP. 50 por página, por cursor
      (recusada?, sequência do **primeiro evento da venda**, o `venda.finalizada`, mesmo já confirmado): a venda nova
      entra no fim e a que tem um evento confirmado entre as páginas não muda de lugar (a chave não é o primeiro evento
      *aberto*, que mudaria e a repetiria no fim). O limite: a pendente que vira recusada entre as páginas sobe para o
      grupo das recusadas, que fica antes do cursor, e só aparece na primeira página (F5); o contador do rodapé a conta.
    - **O motivo da nuvem pelo `eventos-status`** (revisa a decisão 58): o `erro`/`retido` da consulta horária passa a
      gravar o motivo atual no `ultimo_erro` do `rejeitado` (antes ficava o do push): o ERP pode ter reprocessado e a
      nuvem recusado de novo por outro motivo, e é ele que o vermelho mostra. A situação não muda (continua `rejeitado`,
      a decisão é do ERP), o divergente fica como está, nada é confirmado. O "Reenviar agora" antecipa a consulta. O
      **`ERRO_INTERNO` vira o texto genérico do push** ("Falha ao aplicar o evento."): a nuvem guarda no
      `eventos_recebidos.erro` a mensagem crua da falha (a do PostgreSQL ou da exceção, até 2000 caracteres, com tabela,
      coluna e às vezes o valor), que o push esconde do terminal de propósito e o `eventos-status` devolve; ela não vai
      para o banco local (backup, pacote de suporte do G9) nem para a tela, e o mascarador não a pegaria. O certo do lado
      da API é o `eventos-status` também não devolver o texto interno (TS, fora deste bloco).
    - **Detalhe** (`Enter`, o `*` do numérico ou o duplo clique; `DetalheAsync`): a faixa colorida com o que está
      acontecendo e o que fazer — recusada: "A nuvem recusou: <motivo>. Quem decide é o ERP: Cadastros › PDVs /
      Terminais › este caixa › Eventos com erro (reprocessar ou descartar). Quando o ERP resolver, a venda fica verde aqui
      sozinha"; pendente: "o caixa envia sozinho, na ordem…" —; o caixa e o operador; os **itens e os pagamentos**
      (`TextoDetalheVenda`, com o CPF/CNPJ **mascarado**, e cada linha passa pelo `MascaradorSuporte`, também o motivo do
      cancelamento digitado: aqui é diagnóstico, não consulta de venda) **só da venda "a copiar"** (algum evento ainda não
      confirmado nem descartado: o pedido do dono). Da venda que a nuvem já tem, os itens seguem a regra da aba 1 Vendas
      (decisão 70): só com `pdv.venda.consultar_historico` (a própria ou a emprestada) e da venda dos últimos 30 dias pelo
      dia operacional (`ServicoSincronizacaoCentral.VendaDoDetalheAsync`); senão, "veja na aba 1 Vendas ou no ERP". Sem
      isso a visão "Todos os registros" › confirmados (o outbox nunca é expurgado) abria itens, pagamentos e documento de
      venda de meses atrás a quem só tem `pdv.diagnostico.ver`. **Cada envio**
      (o tipo, a sequência, a situação, quando foi gravado, as tentativas, o envio do lote atual, a próxima tentativa, a
      confirmação, o último erro mascarado e as **dependências** com a situação delas aqui — "depende de: caixa
      (abertura e fechamento) — aguardando" explica a venda parada atrás da abertura); e as **ocorrências do log**
      ligadas (o `log_local` que cita a venda pelo id ou pelo número, ou um dos eventos pelo id, a partir de 5 min antes
      do primeiro). **Nunca o payload nem o contexto**: os tipos lidos não têm essas propriedades e as consultas não
      leem essas colunas (o teste confere o SQL); "o conteúdo do registro não aparece aqui: o suporte o vê no ERP".
    - **Ocorrências ligadas, gravadas agora** (`EnvioPush.OcorrenciaRecusa`, `ServicoSincronizacaoHttp.OcorrenciaResolvida`):
      o evento que a nuvem recusa (rejeitado, retido ou descartado no push) grava no `log_local` (origem `sync`, `aviso`)
      o tipo, a sequência e o motivo, com o id do evento e do agregado e o código no `detalhes` (sem payload), na mesma
      transação do resultado; a decisão do ERP que chega (o reprocessado aceito, `info`; o descartado, uma vez) também.
      Sem isso o detalhe não teria log ligado (o `log_local` não citava evento nenhum). É o começo dos "pontos de
      gravação" do G8 (plano 5.5); o leitor do log e as dicas ficam lá. O `log_local` não sobe nem tem a trava da D22.
    - **"Reenviar agora" (F6, o botão, ou Ctrl+Alt+S)** (`ServicoSincronizacaoCentral.ReenviarAgora`): **só** o
      "Sincronizar agora" de sempre (push, heartbeat, pull e a consulta das recusadas no ERP na hora). Não muda nenhum
      evento: o lote é o mesmo, a ordem é a mesma, a espera que a nuvem pediu (`Retry-After`) continua valendo, e
      apertar de novo não duplica nada (a nuvem reconhece o `evento_id`). Na recusada o botão se chama "Conferir no ERP
      agora" (é o mesmo ciclo, que busca a decisão). Na demonstração: "nada sobe nem desce". O plano punha o "Sincronizar
      agora" no `Enter` da aba; aqui o `Enter` é o detalhe, como nas abas 1 e 2, e o reenvio fica no F6 (e no
      Ctrl+Alt+S de sempre). **Não há descartar nem
      reprocessar no PDV** (continua só no ERP, plano 8): nem comando, nem botão (o teste confere).
    - **As outras listas (F3 troca; os botões no topo, com a quantidade):** **Caixa não confirmado** (a segunda seção
      do pedido): abertura e fechamento (`sessao_caixa`), sangria, reforço e o cancelamento deles (`movimento_caixa`),
      um por evento, com o tipo, o valor e a hora do movimento (sem o payload: da tabela do movimento ou da sessão), as
      mesmas cores, os recusados primeiro, o descartado de fora. **Todos os registros**: o outbox inteiro, 50 por
      página, por situação (F7: a enviar e recusados na ordem de envio; confirmados e todos, o mais novo primeiro) e,
      nos a enviar e recusados, por tipo (F8; nos confirmados o tipo leria o outbox inteiro, que não é expurgado, atrás
      de um tipo raro: a consulta recusa). **Comandos do ERP**: os 100 mais novos do `comandos_recebidos` (o tipo em
      palavras, quando, executado/falhou e o resultado mascarado). O resumo no topo: o indicador, a última confirmação,
      quantos a enviar, os **recusados que esperam o ERP** (`ContagemRecusadosAsync`; o descartado lá é citado à parte,
      "1 descartado no ERP", sem vermelho — o `QuarentenaTotal` do F11 › S conta todo `rejeitado` e deixaria o resumo
      vermelho para sempre depois do descarte), a fila de impressão; o **último erro da conexão** (401, DNS, TLS: o porquê
      de as vendas ficarem amarelas), mascarado; a lacuna em vermelho com o F4. **F9 "Situação completa"** (e o botão):
      tudo do F11 › S no painel do detalhe — último pull, push e heartbeat, desvio do relógio, cursores, pendentes por tipo,
      quarentena, lacuna, fila de impressão e o último erro —, com as mesmas linhas (`TextoStatusSync`, que o F11 › S passou
      a usar), mascaradas; o plano pedia o `StatusDetalhadoSync` inteiro na aba.
    - **Lacuna (F4)**: como no F11 › S (decisão 59), com `pdv.config.fiscal` de quem está na Central ou de quem a tem,
      na hora (usuário, PIN e motivo; 31.3). A Central **não empresta** essa permissão (decisão 67): o ENCARREGADO que
      liberou a aba não declara a lacuna. Sem lacuna, o F4 só avisa. A auditoria `liberacao` leva **quem está na Central**
      e pediu e a tela "PDV › Central do PDV › Sincronização" (`OrigemLiberacaoLacuna`, parâmetro opcional do
      `DeclararLacunaAsync`/`AutorizarRecuperacaoLacunaAsync`; sem ele, o operador da venda e o F11 › S de sempre): a
      Central aberta pelo login não tem operador na sessão, e o registro saía sem quem pediu.
    - **O detalhe não abre vazio**: o detalhe tem a versão dele (`_versaoDetalhe`); a releitura da lista que o relógio
      dispara no meio da leitura do detalhe não o descarta mais (antes a versão era a da lista: o painel abria com o
      título e as linhas vazios até a releitura seguinte, até 15 s). O caixa não confirmado mostra o fundo de troco só na
      abertura (no fechamento e no cancelamento do movimento, "—"; no detalhe da sessão, "fundo de troco R$ …").
    - **Teclado e mouse** (decisão 65; o dono usa o numérico): o `4` abre com o foco no painel da lista; ↑/↓ escolhem,
      `Enter`/`*` detalhe, `PgDn`/`PgUp` ou `+`/`−` página, `F3`/`Shift+F3` lista, `F4`, `F5`, `F6`, `F7`, `F8`, `F9`; no detalhe
      ↑/↓ e PgUp/PgDn (ou 8/2/9/3) rolam; `Esc` fecha o pedido do supervisor, depois o detalhe, depois volta ao menu.
      Toda ação tem botão de 44 px, cabe em 1024 × 700. A liberação que acaba esvazia a aba (`ConferirPermissoes`, como
      na aba Caixas) e o serviço recusa a leitura sem a permissão (a tela não é a única barreira).
    - **Desempenho, sem migração** (o plano previa um índice `eventos_saida(status, criado_em)` "se não existir"): o
      `ix_eventos_saida_status (status, sequencia_terminal)` já existe e dá a ordem de envio. Toda consulta entra por ele
      **com igualdade, uma por situação** (a enviar são três consultas): com o `IN` de várias situações e as estatísticas
      de um outbox quase todo confirmado (o `ANALYZE` do teste), o SQLite preferia varrer a tabela ou o índice da
      sequência; com a igualdade e a ordem do índice, não. O agregado entra pelo `ix_eventos_saida_agregado`, o evento
      pelo id, o log pelo `ix_log_local_ocorrido_em` (a partir do primeiro evento da venda, nunca o log inteiro pela
      chave). Medido com o volume do G5 (120 mil vendas, o outbox delas com o payload de ~5 KB) e **3 mil vendas na fila**
      (uns dias sem internet) com 40 recusadas: 2 a 52 ms por consulta (a primeira página das vendas ~33 ms), longe dos
      300 ms; nenhuma varre a tabela; o índice da sequência só é percorrido com o `LIMIT` da página; nenhuma lê o
      payload. Sem coluna nova (o `EsquemaNuvemTests` não muda).
    - Fora deste bloco: o leitor do arquivo de log, as dicas e os demais pontos de gravação (G8); o pacote de suporte com
      o `status-sync.json` e o `outbox.csv` (G9); reprocessar ou descartar no PDV (fica no ERP); o envio remoto dos logs.
    Testes: `ConsultasSincronizacaoTests` (Data: uma linha por venda, as recusadas primeiro com o motivo, a confirmada e a
    descartada fora, o divergente, o cancelamento na fila com a finalizada confirmada, as que ficam verdes e as
    descartadas à parte, a contagem dos recusados sem a descartada; a paginação de 137 vendas com uma nova entre as
    páginas, sem repetir nem pular, e a venda com a finalizada confirmada entre as páginas, que não se repete; o caixa não confirmado com o valor do movimento;
    "todos" por situação, tipo e cursor; o detalhe com a dependência e as ocorrências só da venda; os comandos; nenhuma
    propriedade de payload ou contexto nos tipos; o volume sintético abaixo de 300 ms, sem varredura e sem ler o payload
    nem o contexto no SQL), `SincronizacaoCentralTelasTests` (o `⇅` da MARIA que pede o ENCARREGADO e abre a aba; a
    recusada vermelha com o motivo e a pendente amarela; o detalhe com os itens, o pagamento, o envio, o último erro, a
    dependência, a ocorrência ligada e nada do payload; o F6 e o botão que só pedem o ciclo, duas vezes, sem evento novo;
    o ERP que resolve e a venda verde no detalhe e na lista até o F5; o caixa não confirmado com o reforço; "todos" com o
    F7 até os confirmados; os comandos; nenhum descartar/reprocessar; os botões de 44 px em 1024 × 700 e o `*`; a
    liberação que acaba esvaziando a aba; o F11 › S com a venda em andamento recusando o F3 e, com o caixa livre, levando
    à aba; o F4 sem lacuna, e com ela pedindo `pdv.config.fiscal` na hora — o ENCARREGADO recusado, o CARLOS declarando;
    o gerente que abre direto, com o `central_acessada` e sem `liberacao`, a demonstração que "nada sobe" e o `⇅` com a
    venda em andamento; a confirmada aberta pelos confirmados sem os itens para quem só tem o diagnóstico; o motivo do
    cancelamento com CPF mascarado; o fundo de troco só na abertura; a origem da lacuna na auditoria; a descartada no
    ERP sem cor e o resumo fora do vermelho, com os itens para o CARLOS; a troca de página sem a linha resolvida; a
    releitura no meio da leitura do detalhe, que não o deixa vazio; o último erro da conexão e o F9), `CicloOnlineTests` (a ocorrência ligada do rejeitado no push, sem o payload; o `eventos-status`
    que atualiza o motivo do retido e grava as ocorrências do reprocessado e do descartado, e nenhuma do já descartado;
    o `ERRO_INTERNO` cru da nuvem que vira o texto genérico), `LacunasTests` (a origem da liberação na auditoria).
    As três classes com o volume sintético (G5, G6 e esta) rodam numa coleção sem paralelismo (`ColecaoVolumeSintetico`):
    juntas, as cargas de 120 mil vendas disputavam a máquina e a medição de uma pegava o pico da outra.

73. **Logs e ocorrências na Central: o erro de ontem com o que fazer, sem abrir o Windows Explorer** (Central do PDV,
    bloco G8; plano 4, 5.4 e 5.5; decisões do dono de 04/11/2026: PC-7, PC-12; PDV 32.2). A aba **5 Logs e
    ocorrências** acha um erro de ontem em menos de um minuto, offline. **Nenhuma migração, nenhum contrato novo com a
    nuvem, nenhuma permissão nova** (a versão continua 0.9.1).
    - **Onde abre:** o `5` no menu da Central (ou o clique), com `pdv.diagnostico.ver` (a própria ou a emprestada pelo
      **Ctrl+L**, decisão 67); abrir grava o `central_acessada` (G2). O botão do item **"Erros recentes"** do Painel de
      saúde (decisão 69) abre a aba já filtrada nos **erros das últimas 24 h** (`AcaoSaude.Filtro`,
      `VerificacaoErros.FiltroErrosRecentes`); com o cadeado, o filtro espera o PIN do supervisor e entra depois dele.
    - **Duas fontes (F3 alterna; os dois botões no topo):** as **ocorrências** do `log_local` (impressora, gaveta,
      sincronização, backup, login, sistema), cada uma com a **dica do que fazer** (`CatalogoOcorrencias`), e o
      **arquivo técnico** (o Serilog do dia escolhido, o que o suporte lê), do mais novo ao mais antigo, com a exceção
      inteira no detalhe. Filtros, todos também pelo mouse: o **nível** (F4: todos, avisos e erros, só erros), o
      **período** nas ocorrências (F6: últimas 24 h, hoje, ontem, 7 dias — o padrão —, 30 dias, tudo; pelo dia do
      calendário da loja) ou o **dia** no arquivo (F6, os dias com arquivo de log, com o tamanho), a **origem** (F7, nas
      ocorrências) e o **texto** (o campo, que recebe o foco). O F4, o F6 e o F7 avançam e, com **Shift**, voltam um
      (como o Shift+F3 das abas 1 e 4; pelo mouse, as listas). **F8 limpa** (cada aba tem as suas teclas: na aba 1 o F6
      é o limpar, aqui o F6 é o período, o filtro mais usado, e o limpar ficou no F8, livre nesta aba). F5 lê de novo,
      50 por página pelo cursor (PgDn/PgUp, ou `+` e `−` do numérico; o `−` só pagina com o campo vazio); o rodapé conta
      as linhas já mostradas ("Ocorrências 51 a 55"), não 50 por página. Trocar um filtro apaga o aviso do filtro de
      antes (o "erros das últimas 24 h" do Painel, o fim do dia). Enter (ou `*`, ou o duplo clique) abre o detalhe:
      quando, o nível (a palavra ao lado da cor, PDV 9.1), a origem, o código, o que aconteceu, os dados ligados (o
      documento, a venda, o evento) e o **texto técnico**; Esc fecha o detalhe e volta ao menu. Botões de 44 px, cabe em
      1024 × 700.
    - **Tudo mascarado** (`MascaradorSuporte`, decisão 67) antes de chegar à tela: a mensagem, o detalhe e cada registro
      do arquivo. O `detalhes` é um JSON (abaixo), e o texto técnico (a exceção) fica escapado dentro dele: a quebra de
      linha vira `\n` e a aspa vira `\"`, e as regras de `senha=`, `token:` e `Bearer` (que exigem que o nome não venha
      grudado numa letra) e a do valor entre aspas não pegavam. Por isso o `MascararDetalhes` abre o JSON e mascara
      **valor a valor**, cada texto já decodificado, e o campo de nome sensível vira `"***"` inteiro; o JSON volta
      montado (o texto solto das linhas antigas e o JSON quebrado, pela máscara do texto inteiro). O detalhe da tela
      mascara de novo o que tira do JSON. O pacote do G9 (o `ocorrencias.csv`) deve usar o mesmo `MascararDetalhes`.
    - **A busca** é a mesma nas duas fontes: **sem diferença de acento nem de maiúscula** ("nao" acha "não", "IMPRESSÃO"
      acha "impressão"; `BuscaSemAcento`), e nas ocorrências também pelo **título da dica** (a coluna "Resumo":
      "documento não impresso" acha a falha do cupom). O `LIKE` do SQLite só ignora a maiúscula no ASCII, então o SQL só
      **pré-seleciona** (a vogal, o c e toda letra fora do ASCII viram o curinga de uma letra; os códigos cujo título
      tem o texto e as linhas sem código das origens cujo título tem o texto também entram) e a conferência exata é em
      memória, **depois da máscara**: procurar um CPF pontuado ou um token não "acha" a linha onde ele foi escondido. As
      linhas que a conferência descarta não deixam buraco: o serviço lê mais do banco até encher a página, até **2.000
      linhas lidas** por página (então "a busca parou nas 2.000 ocorrências já procuradas: PgDn procura mais para trás",
      como o arquivo técnico); o cursor só vem quando há linhas depois. Assim o termo que só existe escondido responde
      como o que não existe ("Nenhuma ocorrência", sem o PgDn aceso), salvo se aparecer em mais de 2.000 linhas. Só lê:
      nada é gravado nem apagado pela aba (nem na D22). Quem decide é o `ServicoLogsCentral`, pelo `AcessoCentral` (sem
      a permissão, recusa: a tela não é a única barreira); a liberação que acaba esvazia a aba (`ConferirPermissoes`,
      como nas abas 2 e 4).
    - **Ocorrências com código e origem padronizados** (`Data/Repositorios/OcorrenciasLocais.cs`): o `log_local` ganha o
      **código** dentro do `detalhes` (JSON, sem mudar o schema; o `EsquemaNuvemTests` não muda), com a origem dele. O
      conjunto é **fechado** (`CodigoOcorrencia`, construtor privado): `IMPRESSAO_FALHOU`, `IMPRESSAO_FALHOU_SEM_FILA`,
      `FILA_IMPRESSAO_PAROU`, `CONFIGURACAO_ALTERADA` (impressora); `GAVETA_FALHOU`, `GAVETA_VOLTOU`;
      `REGISTRO_RECUSADO`, `REGISTRO_RESOLVIDO_ERP`, `COMANDO_FALHOU`, `MENSAGEM_ERP`, `RECUPERACAO_NUMERACAO` (sync);
      `BACKUP_FALHOU`, `BACKUP_COPIA_FALHOU`, `RESTAURADO_OFFLINE` (backup); `PIN_FORA_DOS_LIMITES` (login);
      `ERRO_INESPERADO` (sistema). Toda linha nasce no `Ocorrencias.Nova` (ou no
      `RepositorioTerminal.RegistrarOcorrenciaAsync`, que o usa; o `RegistrarLogAsync` de texto solto saiu): o código,
      os dados que ligam a ocorrência e, em `texto`, o detalhe técnico (a exceção); acentos como texto (a busca acha
      "não"). O código que a nuvem devolve na recusa fica à parte, em `codigo_nuvem` (antes estava no `codigo`). As
      linhas de antes desta versão continuam: sem código, a dica vem da origem; a origem `app` (o erro inesperado de
      antes) conta como **sistema** no filtro. As origens `caixa` e `venda` do plano entram com o primeiro ponto de
      gravação delas (nenhuma opção morta no filtro).
    - **Pontos de gravação novos** (plano 5.5): o documento que não saiu na impressora (`ServicoImpressao`: o tipo, a
      venda ou o fechamento e o erro; `aviso`, para não acender os "Erros recentes", que o Painel já mostra na
      Impressora), com o nome do documento em português ("Cupom da venda", "QR do PIX", "Relatório de fechamento do
      caixa"; o tipo cru fica no detalhe). O que só vale na hora e não fica na fila (o QR do PIX, `cancelado`, fora do
      F7) grava `IMPRESSAO_FALHOU_SEM_FILA`, cuja dica é "mostre a tela ao cliente", não o F7. A fila que parou no F7; a
      configuração da aba 3 gravada (`info`, o resumo; o antes e o depois ficam na auditoria); o comando do ERP que
      falhou (`ProcessadorComandos`, uma vez por comando: o `falhou` e a ocorrência na **mesma transação**, senão a
      repetição devolveria o resultado gravado e a ocorrência sumiria; o "não suportado nesta versão" tem a dica de que
      é normal); o backup que falhou (`ServicoBackup`, `aviso` pelo mesmo motivo da impressora: o item Backup do Painel
      já fica vermelho; se o banco também falhar, fica só no arquivo; com a restauração em curso, nada vai para o
      banco). O evento recusado e a decisão do ERP já gravavam desde o G7 (decisão 72) e ganharam o código. Os do plano
      que dependem de blocos seguintes ficam com eles: parâmetro alterado e backup manual (G11), pacote gerado (G9). O
      campo do documento na ocorrência é `tipo_impressao`, não `tipo_documento`: o mascarador esconde todo campo com
      "documento" no nome (o CPF/CNPJ).
    - **`LeitorLogArquivo`** (`App/Servicos/Diagnostico`): lê **pelo final**, em blocos de 64 KB, com
      `FileShare.ReadWrite` (o Serilog continua escrevendo o do dia), sem carregar o arquivo (até 20 MB, decisão 67): a
      primeira página de um arquivo de 20 MB lê dois blocos. A linha que começa com a data e o nível abre um registro; as
      seguintes (a exceção) são dele. Aceita os dois formatos da decisão 67 (com e sem o código do terminal) e a
      categoria do `ILogger`. Um dia com `_001`, `_002` (o limite de tamanho) é lido do mais novo ao mais antigo, como um
      só; o cursor é a **parte** do arquivo (o `_001`, não a posição na lista: o `_001` que o Serilog abre entre duas
      páginas entra no começo da lista, e o F5 relê a lista) e a posição do começo do registro (o arquivo só cresce no
      fim: nada se repete nem se pula; a parte que sumiu continua do fim da seguinte).
      Com um filtro que acha pouco, a página para depois de ler **8 MB** e diz "a busca parou na parte já lida do
      arquivo" (o PgDn continua dali): a tela nunca espera o arquivo inteiro. Linha solta no começo do arquivo vira um
      registro sem data; linha gigante sem quebra é cortada em pedaços de 1 MB; o BOM e o `\r` do Windows somem. A troca
      de filtro cancela a leitura em curso. O nível do arquivo vira o do `log_local` (`[WRN]` → aviso).
    - Fora deste bloco (plano 7): o pacote de suporte com `ocorrencias.csv` e `logs/` mascarados (G9, que usa estas
      peças); o envio remoto dos logs pelo ERP (`enviar_logs` continua "não suportado", PC-12); o nível Debug temporário
      com tela; a retenção do `log_local` (PC-11: só medir). Sem índice novo: a consulta entra pelo
      `ix_log_local_ocorrido_em` (o id é o rowid, a mesma ordem do índice; nenhuma ordenação à parte, o teste confere o
      plano), então o índice `(ocorrido_em, nivel)` do plano não foi preciso.
    Testes: `ConsultasLogLocalTests` (Data: o código, a origem, os dados e o texto no detalhe, os acentos como texto e
    as linhas de antes sem código; os filtros de nível, período, origem com o legado `app` e texto com o `%` e o `_`
    escapados, combinados (o texto no SQL é a pré-seleção); 137 linhas em 3 páginas sem repetir nem pular, com a mesma
    hora em várias e uma nova entre as páginas; o plano pelo `ix_log_local_ocorrido_em` sem `TEMP B-TREE`),
    `LeitorLogArquivoTests` (o Serilog de verdade escrevendo, com o arquivo aberto, nos dois formatos, a exceção junto
    do registro e mascarada, os filtros de nível e texto sem acento e o token que a busca não acha; o arquivo de 20 MB
    cuja primeira página lê até 2 blocos em menos de 1 s e o filtro do começo do dia que para no orçamento e acha na 3ª
    página; o dia com o `_001` paginado de 7 em 7 com blocos de 17 e 64 bytes, com acentos e `\r\n`, sem repetir nem
    pular, e a pasta do perfil mascarada na pilha; a linha solta, a sem fim de linha e o CPF pontuado),
    `CatalogoOcorrenciasTests` (todo código, achado por reflexão, tem dica e está no `Todos`; toda origem do filtro tem
    código; e nenhum arquivo do código cria `LogLocal` à mão nem usa o `RegistrarLogAsync`; todo tipo de documento
    impresso tem nome legível), `ServicoLogsCentralTests` (os segredos plantados no texto técnico — depois de uma
    quebra, entre aspas, no começo, num dado — mascarados no detalhe, no JSON que continua abrindo e na busca; a busca
    sem acento nem maiúscula e pelo título da dica, também o das linhas antigas; a página que a máscara esvaziaria
    completada do banco, sem pular nem repetir, e o limite de leitura; os períodos pelo dia da loja com a máquina em
    Tóquio; 20 mil linhas — um ano sem retenção, PC-11 — com o texto que não existe e o escondido que para nas 2.000
    lidas; e o serviço que recusa sem a permissão), `LogsCentralTelasTests` (o cupom que não saiu numa impressora de
    rede que não responde vira a ocorrência com a venda; levado a ontem, a MARIA abre a aba pela liberação do
    ENCARREGADO, o F6 até "Ontem" mostra só ele com "Documento não impresso", o detalhe com o código, o documento, a
    venda e o "F7 imprime de novo", a busca, o F8, o F3 para o arquivo do dia com a exceção mascarada, o F4, o mouse e
    os botões de 44 px em 1024 × 700, e nada gravado no `log_local` só por olhar; o "Erros recentes" do Painel que pede
    o supervisor e abre a aba nos erros de 24 h com o CPF mascarado, o F4 que apaga o aviso do Painel e o Shift+F4 que
    volta, o botão do Painel com a liberação já ativa (sem o PIN de novo), e a liberação que acaba esvaziando a aba e o
    serviço recusando; a busca que a máscara esvaziaria enchendo a página, com o rodapé "51 a 55"; o F7 com a
    impressora ainda desligada que grava um `FILA_IMPRESSAO_PAROU`, e o F7 que imprime, que não grava outro), mais o
    `CicloOnlineTests` (o `codigo` do PDV e o `codigo_nuvem` na recusa; o comando não feito e a mensagem do ERP gravados
    uma vez cada; o `log_local` que recusa a linha deixa o comando em `recebido`, e a repetição grava os dois), o
    `LeitorLogArquivoTests` (o `_001` aberto entre as páginas), o `ImpressoraTelasTests` (o QR do PIX que não saiu com o
    código sem fila) e o `PainelSaudeTests` (adaptado ao `RegistrarOcorrenciaAsync`; o `BACKUP_FALHOU` gravado; o backup
    que falha com a restauração em curso não grava nada).

74. **Histórico de uso na Central: quem cancelou, deu desconto ou abriu a gaveta, por operador, sem internet** (Central
    do PDV, bloco G10; plano 4.4 e 5.4; decisões do dono de 04/11/2026: PC-7, PC-8; PDV 32.1). A aba **6 Histórico de
    uso** mostra o `log_auditoria_local` em frases e o resumo da semana por operador, offline. **Uma migração de índices
    (`IndicesHistoricoUso`), nenhum contrato novo com a nuvem, nenhuma permissão nova** (a versão continua 0.9.1).
    - **Quem vê:** `pdv.auditoria.ver_local` (o Gerente e o Master; decisão 66), a própria ou a emprestada pelo
      **Ctrl+L** de quem a tem (decisão 67). O Encarregado não vê (PC-8): a liberação dele vale para as outras abas e a
      Central diz "ENCARREGADO não vê a aba 6" (decisão 68). Quem decide é o `ServicoHistoricoUso`, pelo `AcessoCentral`
      (sem a permissão, recusa: a tela não é a única barreira); a liberação que acaba esvazia a aba
      (`ConferirPermissoes`, como nas abas 2, 4 e 5: a lista, o resumo, o detalhe e também os nomes do filtro F7 e o
      texto buscado). Abrir grava o `central_acessada` (G2); a aba só lê, não grava nem apaga nada (nem na D22).
    - **A lista** (`ConsultasAuditoriaLocal`, Data): o mais novo primeiro, 50 por página pelo cursor (PgDn/PgUp, ou `+`
      e `−` do numérico; o rodapé conta as linhas mostradas). Cada linha: a hora (no fuso da loja), o grupo, a **frase**
      ("MARIA cancelou um item · liberado por CARLOS"; sem pessoa, o nome curto: "Relógio do Windows voltou"), a
      descrição que o caixa gravou (mascarada) e a **marca de envio**, com a palavra ao lado da cor (PDV 9.1): **só
      local** (a ação fora do `CatalogosNuvem.AcoesAuditoria`: desconto, item cancelado, Central aberta… ficam só neste
      caixa), **a enviar** (no catálogo, sem lote ou com o lote esperando), **✓ enviado** (o lote `auditoria.registros`
      confirmado: já está guardado na nuvem; o ERP não tem tela da auditoria do PDV), **recusado** (o lote rejeitado;
      quem resolve é o ERP, aba 4) e **descartado no ERP** (o lote recusado que o ERP descartou na fila de decisão:
      continua `rejeitado` e só o `resultado` diz, `ConsultasVendaLocal.Descartado`; não entra na nuvem). O cursor é a
      hora e os ids já mostrados nesse mesmo instante: o `id` é texto no SQLite e o EF não compara `Guid` com `<`; nada
      se repete nem se pula (o registro gravado no mesmo milissegundo do cursor entre duas páginas aparece uma vez na
      seguinte).
    - **Filtros, todos também pelo mouse:** o **período** (F3: hoje, ontem, 7 dias — o padrão, "o resumo da semana" — e
      30 dias; pelo **dia operacional** da loja, o fuso e a hora de corte, como as abas 1 e 2, não o calendário da aba
      5: a madrugada depois do corte é do dia de antes). **No máximo os últimos 30 dias**, na lista e no resumo, como as
      vendas e os caixas da Central (decisão do dono de 04/11/2026, no lugar dos 90 dias da PC-11): não há "tudo", e o
      `ServicoHistoricoUso` não lê antes disso seja qual for o filtro pedido; o banco guarda o resto (nada é apagado,
      PC-11) e a tela diz que vendas e caixas mais antigos ficam no ERP. O **grupo** (F4: acessos, vendas, caixa,
      configuração, sistema, plano 4.4; a ação de outra versão só aparece em "todos"), **quem fez** (F7: quem tem algum
      registro no período, pelo nome; o supervisor que só liberou aparece na frase, não como quem fez — **revisto pelo
      dono em 05/11/2026: o F7 traz também o que a pessoa liberou com o PIN, decisão 78**) e o **texto** (o
      campo, que recebe o foco). F3, F4 e F7 avançam e, com **Shift**, voltam um (como nas abas 1, 4 e 5); F8 limpa; F5
      lê de novo. A busca é a da aba 5 (decisão 73): sem diferença de acento nem de maiúscula, na descrição, no motivo e
      também no **verbo e no nome curto da ação** ("gaveta" acha a gaveta aberta; "venda paga" acha o cancelamento da
      paga), nunca nos nomes de quem fez ou liberou que a frase mostra (o SQL não os pré-seleciona; a pessoa é o F7); o
      SQL só pré-seleciona (pode trazer a mais, nunca a menos: as ações cuja descrição a tela troca, abaixo, entram
      sempre) e a conferência é no texto exibido, depois da máscara (o CPF que a operadora escreveu no motivo, o PIN do
      login negado e o pagador do PIX não "acham" a linha onde foram escondidos); a página é completada do banco até
      2.000 registros lidos.
    - **O detalhe** (Enter, `*` ou o duplo clique; Esc volta): quando, a frase, o grupo e a nuvem, o registro, o motivo
      e onde, todos mascarados (`MascaradorSuporte`), e do antes/depois **só os campos exibíveis**
      (`DescritorAuditoria.CamposExibiveis`: as `ChavesExibiveis` do terminal — na edição da impressora, só o que mudou,
      "impressora.ip: 192.168.0.50 → 192.168.0.51" — e os valores e referências que o caixa grava: valor, desconto,
      forma, número, documento, abas…), cada valor mascarado; o resto vira "+2 campos não mostrados aqui". Ficam de
      fora, mesmo mascarados: o `login_informado` do login negado (pode ser um PIN digitado no campo errado), o pagador
      e o `txid` do PIX à mão, o **`dinheiro_estimado`** da sangria recusada (o esperado da gaveta: O3, o fechamento
      cego) e todo campo de outra versão. Nunca o `chave`/token interno (`ChavesConfiguracaoTerminal.Internas` não cruza
      a lista). **A descrição que repete o que fica de fora** é trocada antes da máscara
      (`DescritorAuditoria.DescricaoExibivel`), na lista, no detalhe e na busca: o login negado vira "Login negado" (ou
      "Login negado na Central do PDV"), sem o que foi digitado no campo do usuário — o `LoginViewModel` e a Central
      gravam "Login negado para '9876'", e a máscara não reconhece um PIN solto de 4 a 6 dígitos —, e o PIX à mão vira
      "PIX de R$ 25,00 confirmado manualmente às 14:32", sem o nome do cliente. O `documento` só aparece quando é um
      impresso que o caixa grava (`cupom`, `fechamento_caixa`); outro valor vira `***` (o mascarador esconde o documento
      pelo **nome** do campo, o CPF, e o valor sozinho perde esse contexto).
    - **As frases** (`DescritorAuditoria`, App): cada ação que o caixa grava hoje tem grupo, verbo e nome curto, e
      também todas as do catálogo da nuvem (a versão seguinte não aparece crua); a desconhecida vira "registrou …" no
      grupo Sistema. Duas frases dependem do registro, não só da ação (`Descrever(registro)`): o **`venda_cancelada`** é
      a ação do caminho normal do cancelamento da **venda paga** (F12, com o dinheiro que sai da gaveta) e também da
      **em andamento** (o Shift+F4 com o `venda.cancelada` aceito; o `cancelar` fica só para a em andamento fora da
      sessão ou na nuvem T13), então a frase sai da venda do `registro_id` (`finalizada_em`: a em andamento nunca foi
      paga; sem a venda no banco, o `sai_da_gaveta` do `depois`, que só a paga grava): "cancelou uma venda paga" ou
      "cancelou uma venda em andamento"; e a **liberação dada a si mesmo** (o supervisor que libera o próprio caixa com
      o disco quase cheio: quem pediu e quem autorizou são ele) é "liberou com a própria permissão de supervisor", não
      "pediu uma liberação". O `DescritorAuditoriaTests` **varre o código** (o `RegistroAuditoria(…)`, o
      `RegistrarAuditoriaAsync(…)`, a entidade montada à mão, as constantes `Acao…`, o `Auditoria(…)` do caixa, o
      `new("liberacao", operador.Id…)` e o SQL da restauração) e quebra se surgir ação sem frase; a lista mínima do
      teste prova que a varredura não ficou cega.
    - **F6 Resumo por operador** do período (o "pronto quando" do plano; F3 muda o período; F6 ou Esc volta à lista):
      por pessoa, os **logins**, a primeira e a última atividade, as **vendas pagas** (pela hora do pagamento; a
      cancelada depois conta como venda e o cancelamento aparece à parte), os **itens cancelados**, as **vendas pagas
      canceladas** e as **em andamento canceladas**, os **descontos** — quantas vezes deu (pela auditoria) e em quantas
      vendas pagas e quanto (pelas vendas que continuam pagas: o desconto do item sem a promoção, que é da loja, e o no
      total sem os cascos descontados, C11c; o valor sai das vendas porque o desconto tirado ou a venda cancelada não
      deixam dinheiro a menos na gaveta) —, as **gavetas abertas sem venda** (o F11 › 9 e o teste da aba 3) e as
      **liberações** que pediu a outra pessoa e as que **deu como supervisor** (pelo `autorizado_por_id`; a "dada" ou
      "pedida" a si mesmo, como o gerente que entra pela Central com a permissão ou o supervisor que libera o próprio
      caixa, não conta em nenhuma das duas). As vendas pagas canceladas e as em andamento saem pela venda
      (`CancelamentosDeVendaAsync`, a mesma regra da frase): o Shift+F4 da operadora não aparece como "venda paga
      cancelada", o número que o dono usa para desconfiar de dinheiro tirado da gaveta. Entra quem fez algo, vendeu ou
      liberou no período, pelo nome. **Enter** numa pessoa (ou o botão) volta à lista só com o que ela fez; quem só
      vendeu ou só liberou não está no filtro "Quem" (quem fez): a lista mostra todos e a mensagem diz por quê ("CARLOS
      só deu liberações neste período: elas aparecem na frase de quem pediu"). As vendas são as **deste terminal** (o
      banco local é deste caixa).
    - **Índices (`IndicesHistoricoUso`, a migração do plano):** `log_auditoria_local(ocorrido_em, id)` (o período, na
      ordem da lista e do cursor, sem ordenação à parte), `(usuario_id, ocorrido_em)` (quem fez, a primeira e a última
      atividade) e `(acao, ocorrido_em)` (o grupo e as contagens do resumo). Diferente das vendas (decisão 70), aqui o
      índice paga: a auditoria não é expurgada (PC-11) e toda consulta é por período; sem ele, cada página varria a
      tabela inteira. Roda depois do backup `antes-migracao` como as outras (o teste aplica a migração sobre um banco na
      anterior com um registro e confere o backup, os três índices e o registro); não recria a tabela (os gatilhos da
      D22 ficam); `log_auditoria_local` é só local, então o `EsquemaNuvemTests` não muda. Medido com **um ano de
      auditoria (200 mil registros, ~550 por dia)** e as 120 mil vendas do G5: cada página, o filtro "quem", o grupo, o
      grupo raro em "tudo", o texto que não existe, as contagens, os cancelamentos de venda, as liberações pedidas e
      dadas, a atividade e as vendas da semana e do mês (o mês é o maior período da tela) ficam entre 1 e 40 ms (longe
      dos 300 ms); o teste confere pelo plano do SQLite que o `log_auditoria_local` entra sempre por um dos três índices
      (nunca a tabela inteira), que a lista do período não ordena à parte e que as vendas do resumo entram pelas sessões
      do período e pelo `ix_vendas_sessao_caixa_id` (nada que cresce com as vendas é varrido).
    - **Teclas e mouse:** ↑/↓ escolhem (a linha ou a pessoa do resumo), Enter detalhe, PgDn/PgUp página, F3 período, F4
      grupo, F7 quem, F6 resumo, F5 atualiza, F8 limpa, Esc fecha o detalhe ou o resumo e volta ao menu; toda tecla tem
      botão de 44 px; cabe em 1024 × 700. O foco fica no campo do texto (no resumo, na lista das pessoas); o ComboBox
      escolhido pelo mouse devolve o foco.
    - Fora deste bloco: o bloqueio de tela (`bloqueio`, G11) e o pacote de suporte com o `auditoria-resumo.csv` (G9)
      usam estas peças; a página de auditoria do PDV no ERP e ações novas no catálogo da nuvem continuam fora do plano;
      a retenção do `log_auditoria_local` (PC-11: só medir). A busca pelo **nome** de quem fez é o filtro F7 (o texto
      procura no que foi gravado, onde o nome do supervisor costuma estar).
    Testes: `ConsultasAuditoriaLocalTests` (Data: a migração sobre o banco anterior com o backup `antes-migracao`, os
    índices e o registro de antes; os filtros de período, quem, grupo e texto com o `%` e o `_` escapados, combinados, e
    a situação do lote pelo outbox, também o descartado pelo ERP; 137 registros em grupos do mesmo instante em 7
    páginas, com um novo entre as páginas e outro no mesmo milissegundo do cursor, sem repetir nem pular; as contagens,
    as liberações dadas e pedidas sem a "dada a si mesmo", os cancelamentos de venda paga e em andamento separados pela
    venda (e, sem a venda no banco, pelo `sai_da_gaveta`), na lista, no detalhe e nas contagens, a atividade e as vendas
    com o desconto do item sem a promoção, o do total sem os cascos, a cancelada que conta como venda e não como
    desconto, o item cancelado, a de outro terminal e a de fora do período; um ano de auditoria e 120 mil vendas abaixo
    de 300 ms pelos índices, pelo plano do SQLite), `DescritorAuditoriaTests` (a varredura do código e o catálogo da
    nuvem com frase; a frase com quem e quem liberou, sem pessoa e a de outra versão; a marca de envio pelo catálogo e
    pelo lote, com o descartado; a frase do cancelamento pela venda e a da liberação dada a si mesmo; a descrição
    exibível sem o PIN do login negado e sem o pagador do PIX; o antes/depois só com os exibíveis, mascarados: a edição
    da impressora só com o que mudou e sem a chave interna, o login digitado, o dinheiro estimado, o pagador do PIX, o
    `documento` só com os impressos conhecidos, o JSON quebrado) e `HistoricoUsoCentralTelasTests` (a MARIA vende com
    10% de desconto no item, cancela uma venda em andamento pelo caminho normal com o CARLOS liberando, tem uma venda
    paga cancelada no F12, abre a gaveta sem venda com um CPF no motivo, confirma um PIX à mão com o nome do pagador,
    tem uma sangria recusada; o login negado com o PIN no campo do usuário, como o código grava; o cadeado e o CARLOS
    que libera; as frases, "só local" e "a enviar", e o "✓ enviado" depois do lote confirmado; "cancelou uma venda paga"
    e "cancelou uma venda em andamento"; nem o PIN nem o pagador na lista, no detalhe ou na busca; a busca, o CPF
    escondido que não acha nada, o texto exibido que acha, os nomes da frase que não acham; o detalhe da sangria sem o
    estimado e o do login negado sem o login digitado; F4 e Shift+F4, F7, F8, o `*`; o F6 com os totais da MARIA — 1
    login, 1 venda paga, 1 venda paga cancelada e 1 em andamento, 1 desconto em 1 venda de R$ 1,29, 1 gaveta, 2
    liberações pedidas — e as 2 dadas pelo CARLOS; o F3 que vai de 30 dias a hoje, sem "tudo"; o Enter no CARLOS, que só
    liberou, com a mensagem, e o Enter que volta à lista só com ela; os botões de 44 px em 1024 × 700; nada gravado além
    da liberação e do acesso; a liberação que acaba esvaziando a aba, os nomes do F7 e o texto, e o serviço recusando;
    e, pelo login do dono, o registro de 40 dias atrás que não volta nem pelo serviço sem período, a liberação dada a si
    mesmo que não é "pedida", a busca que a máscara esvaziaria enchendo a página, com o rodapé "51 a 55", e as três
    páginas sem repetir).

75. **Parâmetros e backup na Central, e o bloqueio da tela por inatividade (desligado por padrão)** (Central do PDV,
    bloco G11; plano 4, 4.5 e 7; decisões do dono de 04/11/2026: PC-2, PC-7, PC-13; PDV 6.2.2, 6.8, 6.9, 7.4, 32.5). O
    gerente ajusta o que é do próprio caixa com validação e auditoria, vê as regras da loja como estão valendo e faz um
    backup agora, offline. **Nenhuma migração** (as chaves novas são de `configuracao_terminal`), **nenhum contrato novo
    com a nuvem, nenhuma permissão nova** (a versão continua 0.9.1).
    - **`ServicoParametrosLocais`** (App): os parâmetros do caixa — `tela.tema`, **`tela.bloqueio_inatividade_min`**
      (chave nova, de 0 a 120; **0 = desligado, o padrão**: PC-13 no lugar do 10 da spec 6.2.2) e
      `backup.pasta_secundaria` — gravados só no que mudou, num commit com a auditoria `editar` de `configuracao_terminal`
      (antes e depois só dessas chaves; o mesmo padrão do `ServicoHardware.GravarAsync`), e a ocorrência nova
      `PARAMETRO_ALTERADO` (`info`, origem sistema) no `log_local`. A pasta vai para a auditoria (que sobe no lote) e
      para a ocorrência **já pelo `MascaradorSuporte`** (o perfil do Windows no caminho vira `%USERPROFILE%`); só a
      `configuracao_terminal` guarda o caminho inteiro. Lê do banco antes de gravar (duas telas não gravam
      por cima com um "antes" velho) e recusa o que não mudou. Valida antes: os minutos na faixa e, **só quando ela muda**,
      a **pasta secundária** com o caminho completo, **fora das pastas do GenesisPDV** (dados, backup, logs, impressão e a
      pasta que contém dados e backup: a cópia no mesmo lugar do banco não protege de nada) e com o **teste de escrita**
      (cria a pasta se faltar, grava, lê e apaga um arquivo `.genesispdv-teste-…`; o mesmo do "Testar pasta"; a mensagem
      de falha sai mascarada). Vale pendrive, outra pasta da máquina ou **pasta de rede** (`\\servidor\…`, como a spec
      6.2.2 prevê; o backup já grava numa subpasta por terminal). A tela avisa que o backup é o banco inteiro, sem cifra
      (até a D41), com CPFs, e pede um pendrive guardado ou uma pasta (local ou de rede) que só a loja acessa. Gravar na
      Central pede `pdv.config.parametros_locais` (a própria, ou o supervisor na hora com usuário, PIN e motivo, 31.3: a
      liberação da Central só empresta o ver), com o liberador no `autorizado_por_id` e o motivo na auditoria. O
      **`PrepararAsync`** faz tudo o que se confere sem gravar (a faixa, o "nada mudou" lendo do banco, a regra da pasta e
      a unidade presente — o pendrive ligado —, só lendo o disco) e a aba 7 o chama **antes** do PIN do supervisor; o teste
      de escrita vem com a liberação. **Ctrl+Alt+T** (tema) continua sem permissão, mas passa pelo serviço e é auditado
      (`localizacao` "PDV › Venda › Ctrl+Alt+T"): parte do que está **no banco** (não da memória, que fica no padrão se a
      leitura da abertura falhou) e muda só o `tela.tema` — o bloqueio e a pasta ficam como estão, e a pasta de antes do
      G11 fora das regras de hoje não impede a troca; na D22 a auditoria recusada deixa o tema como estava e a mensagem da
      trava aparece. O `ServicoTema` só lê e aplica.
    - **Aba 7 Parâmetros** (`AbaParametrosViewModel`/`AbaParametrosView`; abre com `pdv.diagnostico.ver`, a própria ou a
      emprestada pelo Ctrl+L): os do caixa (o campo dos minutos recebe o foco — o numérico já digita —, o tema numa lista
      que devolve o foco ao fechar e a pasta), F2 Salvar, F6 Testar pasta, F5 Atualizar, Esc fecha o pedido do supervisor
      e volta ao menu; todos com botão de 44 px. Tudo o que se confere sem gravar vem **antes** do PIN do supervisor (ele
      não libera o que não vai gravar: 999 minutos, nada mudou, a pasta sem caminho completo). O **F6 Testar pasta** cria a
      pasta e grava um arquivo nela, então pede a **própria** `pdv.config.parametros_locais` (o ver emprestado pelo Ctrl+L
      não grava em disco); sem ela, o F2 testa a pasta depois da liberação. A mensagem do gravado fala só do que mudou (a
      pasta "testada agora" só quando ela mudou), e um texto de andamento ("Testando a pasta…", "Gravando…") aparece
      enquanto o disco ou a rede respondem. Abaixo, **as regras da loja só leitura** (PC-2: os caixas da mesma loja não
      divergem; editar continua só no ERP): cada chave de `ChavesConfiguracao` com o rótulo do ERP, o valor que está valendo em português
      ("Sim", "R$ 300,00", "sem limite", "Horário"), a origem (**definido no ERP para esta loja**, **para a empresa** ou
      **padrão do sistema**), o selo "🔒 definido no ERP" (spec 6.9), onde mudar ("ERP › Cadastros › Configurações › PDV
      (por loja: Lojas › Parâmetros)") e quando as regras desceram (o último pull do fluxo `configuracao`). O valor de
      outro tipo aparece como o padrão com o aviso, porque é o que o caixa usa (cada `Obter…Async` cai no padrão); o
      `null` também, nas chaves em que ele não quer dizer nada (as booleanas, as horas, a tolerância do fechamento): só
      onde ele tem sentido ("desligado", "sem limite", "sem teto") aparece como valor. O
      `RepositorioConfiguracoes.ValoresEfetivosAsync` lê todas numa consulta (loja ?? empresa ?? padrão, sem a de outra
      loja nem a excluída). Os rótulos ficam no `CatalogoRotulosConfiguracao` (App); nenhuma destas chaves é segredo
      (decisão 66), e nenhuma chave interna do terminal é regra da loja. A liberação da Central que acaba esvazia a aba
      (`ConferirPermissoes`, como nas outras), inclusive os campos do caixa (a pasta traz o perfil do Windows).
    - **Aba 8 Backup** (`AbaBackupViewModel`/`AbaBackupView`; `pdv.diagnostico.ver`): os backups deste caixa da pasta do
      PDV e da secundária, **uma linha por arquivo com onde está** ("pasta do PDV e secundária", "só na secundária";
      `ArquivoBackup.NaSecundaria`, lido fora da tela), quando, por quê em português (a cada 2 h, fechamento do caixa,
      saída do aplicativo, feito agora…) e o tamanho; o último backup que deu certo (`ultimo_backup_em`) e a última falha
      deste processo; a pasta secundária configurada. **F5 Fazer backup agora** (`ServicoBackup.FazerAgoraAsync`, motivo
      novo **`manual`**): o mesmo backup do periódico (a API de backup online, as duas pastas, a retenção), **fora da
      thread da tela** (`Task.Run`, como o periódico e o do fechamento: a cópia online, o sha256 e a cópia para o pendrive
      são síncronos e levariam a janela a "Não respondendo"); pede `pdv.config.parametros_locais` (a própria ou o
      supervisor na hora); **recusa com uma venda em andamento** (aberta ou em pagamento) no caixa aberto e durante a
      restauração, **antes** do PIN do supervisor (`ConferirAgoraAsync`: ele não libera o que vai ser recusado); com outro backup em curso, **espera** (um por vez) e a aba diz que está esperando. A falha vira a
      mensagem (mascarada) e conta como a do periódico (`UltimaFalha`, `BACKUP_FALHOU`); feito, grava a ocorrência nova
      `BACKUP_MANUAL` e a auditoria `criar` de `backup_local` (no catálogo; sobe no lote; no Histórico de uso, "fez um
      backup agora") com o arquivo, o tamanho e se a cópia saiu, quem pediu e quem liberou. Esse registro é melhor
      esforço: na D22, com o banco ocupado ou com a restauração começada nesse meio-tempo, o backup fica feito e a tela
      diz que o registro não foi gravado (não "não deu certo"). A tela do "Restaurar backup" usa os mesmos rótulos de
      motivo (`MotivosBackup.Rotulo`). O
      Painel de saúde fica verde no Backup (o item agora também diz "aba 8 Backup, F5"). **F9 Restaurar backup** aparece
      também aqui, só na Central aberta pelo login, e pede o PIN na hora na tela da restauração (como na aba 3). F6
      atualiza (F5 é o backup, como o plano e o Painel dizem), Esc volta.
    - **Bloqueio da tela** (PDV 7.4; PC-13: existe, desligado por padrão). `MonitorInatividade` (App): a janela avisa
      toda tecla, texto, clique, roda e movimento do mouse (o túnel, também o já tratado), medido pelo relógio
      **monotônico** (acertar a hora do Windows não bloqueia nem impede). A tela de venda (no relógio de 1 s, só a que
      está na frente) e a **Central aberta pela venda** conferem; com o `tela.bloqueio_inatividade_min` ligado, o
      operador logado e esse tempo sem uso, o `ShellViewModel.BloquearTelaAsync` troca a página pela
      **`TelaBloqueadaViewModel`** — a Central acaba ao trocar de página (com a liberação dela). **Nunca no meio do
      pagamento**: com a venda em pagamento ou um diálogo de pagamento na frente (o QR do PIX à espera do app do banco, a
      maquininha), o bloqueio por inatividade espera, porque o cliente está pagando e o QR sumiria. Também **F11 › 7** e
      **Ctrl+Alt+B**, mesmo com o bloqueio desligado (e no pagamento: o operador decidiu). A venda fica **como
      estava**: a tela de venda é a mesma, guardada na tela bloqueada (os itens, o diálogo aberto, que volta com o foco
      dele); nada é cancelado nem gravado de novo, e as teclas da venda não chegam
      atrás do bloqueio (a tela de venda sai da janela). Desbloqueia o **PIN do operador logado** (as regras e o bloqueio
      por tentativas do login, `AutenticarParaCentralAsync` com o login dele, sem abrir outra sessão) ou, com **F2**, um
      **supervisor** (`pdv.supervisor`, que não seja o próprio operador; spec 7.4); Esc volta do supervisor ao PIN ou
      limpa o PIN; os botões fazem o mesmo. O que não tem cara de PIN (fora de 4 a 8 dígitos: o leitor de código bipando
      no campo, 13 dígitos e o Enter) é recusado na tela, sem conferir: não conta tentativa nem bloqueia a operadora.
      Depois do desbloqueio volta a mesma tela de venda (a da Central bloqueada carrega a venda de novo) e o desbloqueio conta como uso. Alt+F4 na tela bloqueada com a venda em andamento é
      recusado como na venda. Auditoria, com a entidade **`tela_pdv`** (no ERP, `bloqueio` também é a conta de
      `usuarios` bloqueada por tentativas; quem filtra lá não confunde a tela do caixa com força bruta): **`bloqueio`**
      (já no catálogo; sobe) com `como` (`inatividade` ou `manual`) e os minutos; pelo PIN do operador, a ação nova
      **`desbloqueio`**, **só local** (fora do `CatalogosNuvem.AcoesAuditoria`, como o `central_acessada`: não entra no
      lote); pelo **supervisor**, a **`liberacao`** (já no catálogo; sobe, com ele no `autorizado_por_id`: é a sessão de
      outra pessoa reaberta com o PIN dele); e o **PIN recusado** (do operador ou do supervisor) grava o
      **`login_negado`** com o `login_informado`, como o login e a Central (sobe e vira `historico_logins` no ERP: quem
      testa PINs num caixa bloqueado aparece lá). Todas com frase no Histórico de
      uso. A auditoria é melhor esforço: na D22 o gatilho a recusa e a tela bloqueia e desbloqueia do mesmo jeito (o
      caixa nunca fica preso). Fica de fora: o bloqueio nas outras telas com operador (abertura, fechamento, troca de
      turno) e na Central aberta pelo login (sem operador no caixa; a liberação dela já acaba em 5 min sem uso).
    - **Chaves:** `tela.bloqueio_inatividade_min` entrou em `ChavesExibiveis.Caixa` (decisão 67; o antes/depois aparece
      no Histórico de uso) e na lista do `ChavesTerminalTests`. O `DescritorAuditoria` ganhou a frase do `desbloqueio` e
      os campos exibíveis `como`, `minutos`, `copia_secundaria`, `tamanho_bytes` e `motivo_backup`.
    - Fora deste bloco: o pacote de suporte (G9) com o `configuracao-terminal.json` e o `backups.csv`;
      `venda.qtd_alerta_multiplicador` e `pagamento.finaliza_ao_quitar` (6.2.2) continuam sem tela; exportar backup pela
      tela continua fora (o backup tem o banco inteiro sem cifra até a D41).
    Testes: `ParametrosCentralTelasTests` (pelo login, o CARLOS vê os do caixa no padrão e as regras da loja com o valor,
    a origem e onde mudar; a pasta sem caminho completo, a do próprio PDV e um arquivo no lugar da pasta recusados sem
    gravar nada; F6 testa o pendrive sem deixar arquivo; F2 grava o bloqueio e a pasta com o antes/depois só do que mudou,
    a ocorrência e o "nada mudou" na segunda vez; na aba 8, o F5 faz o backup nas duas pastas, a linha diz onde, a
    auditoria `criar` e o Painel verde no Backup; os botões de 44 px; a MARIA pela liberação da Central, com o gravar e o
    backup pedindo o supervisor na hora — Esc fecha sem gravar —, o CARLOS no `autorizado_por_id` com o motivo e sem o
    F9 pela venda; o backup agora recusado com a venda em andamento (pela tela, antes do PIN do supervisor); o bloqueio desligado que não bloqueia em 1 h, ligado
    em 10 min que a tecla adia e que bloqueia com a venda guardada, as teclas da venda presas, o PIN errado e o certo
    voltando à mesma venda com o item, o `bloqueio` com os minutos e a entidade `tela_pdv`, o `login_negado` do PIN
    errado, o `desbloqueio` só local, e o uso depois do desbloqueio; a Central da venda que bloqueia e volta à venda, e a
    do login que não bloqueia; Ctrl+Alt+B e F11 › 7, o F2 do supervisor, a própria operadora recusada (com o
    `login_negado`) e a `liberacao` com o CARLOS no `autorizado_por_id`; o Ctrl+Alt+T auditado; a faixa e a pasta do PDV
    recusadas no serviço e a permissão exigida; e, da revisão do bloco: o backup agora com um periódico em curso, que
    espera, avisa e lê o relógio fora da thread da tela; o backup feito com o registro recusado pelo banco e pela D22, e
    a tela que bloqueia e desbloqueia na D22; o Ctrl+Alt+T que parte do banco e não mexe no bloqueio nem na pasta; a
    MARIA pela liberação com a faixa, o "nada mudou" e a pasta recusados antes do PIN, o F6 recusado sem criar a pasta,
    o teste de escrita com a liberação e a aba que esvazia quando a liberação acaba; o leitor de código no PIN, que não
    conta tentativa; a inatividade que não bloqueia no pagamento e o Ctrl+Alt+B que volta ao pagamento com o foco; a
    pasta mascarada na auditoria e na ocorrência; a mensagem que só promete o teste da pasta quando ela mudou; o rótulo
    do `manual` na restauração), `CatalogoRotulosConfiguracaoTests` (toda chave de
    `ChavesConfiguracao`, por reflexão, com rótulo e nenhuma a mais nem interna; os padrões iguais aos do código; o valor
    em português, a origem e o inválido que vale o padrão, também o `null` onde ele não quer dizer nada),
    `DescritorAuditoriaTests` (o "fez um backup agora"), `CatalogoLocalTests` (Data: o valor efetivo pela loja, pela
    empresa ou pelo padrão, sem outra loja nem a excluída, e o último pull), `BackupLocalTests` (o `manual` nas duas
    pastas com o local de cada cópia e a retenção dele nas duas), mais o `AcessoCentralTests` e o `ChavesTerminalTests`
    com a chave e o tema novos.

76. **Pacote de suporte: o zip que o suporte entende sozinho, no pendrive, sem segredo** (Central do PDV, bloco G9; plano
    4, 4.6, 5.4 e 7; decisões do dono de 04/11/2026: PC-12 — o pendrive agora, o envio pelo ERP depois —, PC-7, D23
    mantida; PDV 32.1, 32.2). **Nenhuma migração, nenhum contrato novo com a nuvem, nenhuma permissão nova** (a versão
    continua 0.9.1).
    - **Onde gera:** a aba **P Pacote de suporte** (`AbaPacoteViewModel`/`AbaPacoteView`), com
      `pdv.diagnostico.pacote_suporte` — a própria ou a emprestada pelo **Ctrl+L** (decisão 67: o pacote só lê) —; o
      botão **"P  Pacote para o suporte"** no rodapé do Painel de saúde (e a tecla `P` nele), que leva à aba pelo mesmo
      caminho do menu (o cadeado pede o supervisor e a aba abre depois do PIN); e as telas **sem login**: a de **erro
      fatal** (`ErroFatalViewModel`: o banco corrompido sem backup, o de versão mais nova, a falha inesperada na abertura)
      e a de **terminal bloqueado** (desativado, hardware, suporte: `TerminalBloqueadoViewModel`), com **F2** ou o botão
      "Gerar pacote para o suporte". Do caixa ao pendrive em **três cliques**: ⚙, P e "Gerar e salvar" (o "pronto
      quando" do plano). A spec dizia "F11 › S › Gerar pacote"; o F11 › S continua só o status (o pacote fica na Central,
      que exige o caixa livre, e nas telas de erro). As abas "chega numa próxima atualização" acabaram: a P era a última
      (o `AbaEmBreveViewModel` saiu).
    - **Onde salva** (`IDestinosPacote`, `DestinosPacoteSistema`): os pendrives ligados e prontos (a raiz da unidade) e,
      por último e sempre, a pasta **`Documentos\GenesisPDV-suporte`** (criada na hora). Pendrive (`EhPendrive`): no
      Windows, o `DriveType.Removable` (o HD externo e o pendrive que o Windows vê como disco fixo não entram; a aba diz
      "nenhum pendrive reconhecido… salve nos Documentos e copie de lá"); no **Linux** o .NET tira o tipo do sistema de
      arquivos, não do barramento (só o `vfat` dá `Removable`; `exfat` e `ntfs` dão `Fixed`, `ntfs3` dá `Unknown`, o
      `fuseblk` do ntfs-3g dá `Network`; conferido no .NET 10), então vale a montagem sob `/media`, `/run/media` ou
      `/mnt` com `vfat`, `msdos`, `exfat`, `ntfs`, `ntfs3` ou `fuseblk` (e a `/boot/efi`, que é `vfat`, não entra). A aba lista
      os dois com ↑/↓ (o primeiro pendrive já escolhido), **F5** procura o pendrive de novo (o que acabou de ser ligado),
      **Enter** ou **F2** gera; as telas sem login usam o primeiro (o pendrive, ou os Documentos). O nome é
      `suporte-loja<código>-cx<nn>-AAAAMMDD-HHMM.zip` (a hora da loja; sem terminal, `suporte-caixa-…`); o do mesmo minuto
      ganha `-2`, `-3` (nunca apaga outro). Grava num `.parcial` e só no fim troca pelo nome certo: o pendrive tirado no
      meio não deixa um zip pela metade com o nome de pronto. Fora da thread da tela, um por vez (o segundo espera), e a
      tela diz "gerando…"; o Esc volta ao menu sem cancelar, e a volta à aba durante a geração não mexe em nada (o
      "gerando…" fica e o Enter não enfileira outro); depois de pronto, a volta procura o pendrive de novo sem apagar a
      frase com o nome do arquivo. Quem pede é conferido de novo **depois de esperar** o pacote da frente (a liberação do
      Ctrl+L que expirou ou a Central que fechou nesse meio-tempo recusam: o pacote não sai em nome de quem já não
      libera), e a liberação que acaba durante a geração a cancela (o `.parcial` é apagado); com o zip pronto, o registro
      sai mesmo assim.
    - **O que entra, por lista de permitidos** (`ServicoPacoteSuporte.ArquivosPermitidos`; o nome fora dela é recusado
      por `ExigirPermitido`, a segunda barreira): `manifesto.json` (a versão do app, o sistema, o computador, o código
      curto e o `terminal_id`, a empresa pelo código, a loja e o caixa, a situação, o servidor só pelo host, quando foi
      ativado, o último backup e a restauração, as pastas pelo mascarador, as migrações, quem gerou e quem liberou,
      quando, os avisos e o **SHA-256 e o tamanho de cada arquivo**), `saude.json` (a rodada completa do Painel de saúde),
      `status-sync.json` (a situação do ciclo, o `StatusDetalhadoSync` do F11 › S, os recusados sem decisão e os
      descartados no ERP, e a contagem do outbox por situação, pelo índice), `outbox.csv` (id, tipo, sequência, situação,
      descartado no ERP, tentativas, as datas, o lote, o último erro e as dependências — **sem payload, contexto nem o
      `resultado` da nuvem**: os não confirmados até **20.000 por situação** e os **2.000 confirmados mais novos**; o
      manifesto diz o corte de cada um, com o total), `comandos.csv` (os 100 mais novos; o tipo mascarado e o resultado,
      que é JSON — `{"erro": e.Message}` com a quebra de linha e a aspa escapadas —, pelo `MascararDetalhes`, valor a
      valor: como texto, o `senha=` depois do `\n` e o `"token"` escapado passavam; o mesmo na lista de comandos da aba 4),
      `ocorrencias.csv` (o `log_local` dos últimos 30 dias, até 20.000, o `detalhes` pelo `MascararDetalhes` da decisão 73,
      valor a valor), `logs/` (o arquivo técnico dos **últimos 7 dias**, mascarado), `configuracao-terminal.json` (só as
      `ChavesExibiveis`, filtradas **no SQL** e de novo na escrita; o valor pelo `MascararDetalhes`, como o
      `valor_json` das regras: o caminho da pasta do backup com o perfil escondido e o campo de nome sensível inteiro,
      para a chave nova que entrar na lista com um segredo dentro),
      `configuracoes-efetivas.json` (as regras da loja do `CatalogoRotulosConfiguracao` com o valor exibido, o JSON, a
      origem e o último pull: a mesma lista de permitidos da aba 7, nunca outra chave do espelho), `backups.csv` (nome,
      quando, por quê, tamanho, pasta do PDV ou secundária; sem o caminho), `fila-impressao.csv` (os 500 mais novos de
      cada situação, **sem os bytes**), `disco.json` e `auditoria-resumo.csv` (quantas vezes cada ação por dia da loja nos
      últimos 7 dias, até 100.000 registros, o corte dito no manifesto: **sem quem, motivo, descrição nem antes/depois**). As leituras são as do `ConsultasPacoteSuporte`
      (Data), que só projetam as colunas que o pacote leva: a identidade **sem o `token_protegido`**, o outbox sem o
      payload, a fila sem o conteúdo, a configuração sem as internas; cada uma entra por um índice que já existe (o
      outbox por situação, com a igualdade, como a aba 4). Cada parte é à parte: a que falha (o banco ocupado) vira um aviso
      no manifesto e o resto entra.
    - **O que nunca entra** (nenhum é lido): o `pdv.db`, o `-wal`, o `-shm`, os backups (`*.db`, `*.gz`), a
      `chave_terminal`, as chaves internas do terminal (`backup.chave`, `terminal.chave_privada`, `token.pendente`, o
      resumo da ativação — por isso o manifesto não tem a razão social, que o Sobre lê de lá), o token, os hashes de PIN
      (o espelho `usuarios` não é lido), os payloads e o contexto do outbox, os bytes dos impressos e o
      `encerramento.json`. Todo texto passa pelo `MascaradorSuporte` (decisão 67) antes de entrar: o CPF/CNPJ pontuado, o
      campo de nome sensível (também o CPF sem pontuação num `cpf_cnpj`), o BR Code, o hash argon2, o bloco PEM, o
      `Bearer`, o `senha=`, o perfil e a conta do Windows. A **conta que ativou o caixa** (`ativacao.conta`, uma chave
      interna que a tela de "ativado com outra conta" mostra) é lida só para ser escondida: vira `%CONTA_ATIVACAO%` em
      todo arquivo do zip (`MascaradorSuporte.OcultarConta`: `DOMÍNIO\usuário` em qualquer lugar, também escapada no JSON;
      o nome curto do Linux só entre aspas). No CSV, o texto que o Excel leria como fórmula (`=`, `+`, `@`, tabulação,
      retorno e o `-` quando o valor todo não é um número: `-1+cmd|' /C calc'!A0` vindo do `ultimo_erro` da nuvem ou do
      resultado de um comando) ganha um apóstrofo (`CampoCsv`; só o número negativo fica como está); `;` e BOM, para o
      Excel em português abrir direto.
    - **O arquivo técnico** é mascarado **registro a registro** (a linha que abre um registro e a exceção que vem atrás,
      `LeitorLogArquivo.AbreRegistro`): o bloco PEM e o JSON de várias linhas não se partem entre duas máscaras. Lido do
      mais novo ao mais antigo com `FileShare.ReadWrite` (o Serilog continua escrevendo o do dia), até **200 MB** lidos
      (sete dias normais cabem com folga, decisão 67); passou, os mais antigos ficam de fora e o manifesto diz quais. O
      registro gigante (um laço que grava um texto enorme) é mascarado em pedaços de 4 MB; cortado no meio de uma chave
      privada, o pedaço é escondido do `BEGIN` ao fim e as linhas seguintes até o `END` ficam de fora (o resto da chave
      nunca sai sem o `BEGIN` que a reconheceria); se o `END` nunca vem (o log truncado dentro da chave), o descarte para
      no registro seguinte, com a linha "[restante da chave privada omitido…]" no lugar e um aviso no manifesto (o resto
      do arquivo não some junto).
    - **Modo sem banco** (as telas sem login; plano 4.6): só o `manifesto.json` (sem o "gerado por"), os `logs/`
      mascarados e o `diagnostico.txt` (o título e o texto da tela, mascarados, com o aviso); **não abre o banco** (o banco
      pode ser o problema: o teste confere que nenhum byte do `pdv.db` muda e nada é criado ao lado). O
      `ServicoPacoteSuporte` pede no construtor **só o que este modo usa** (os caminhos, o relógio, a sessão, os destinos,
      o leitor do log e o logger); a Central, o banco, o sync, o Painel de saúde, o backup e as configurações são pedidos
      ao `IServiceProvider` na hora, dentro de cada parte do modo completo — o "O caixa não conseguiu abrir" nasce
      justamente da falha de um desses, e o pacote dele não pode depender deles (o teste quebra o `VerificadorSaude` ao
      montar e gera pelo botão). A mensagem de erro do F2 só fala do pendrive quando a falha é de disco. A ocorrência só
      onde o banco abriu: na tela de terminal bloqueado grava o `PACOTE_GERADO` (melhor esforço; a mensagem diz "sem login,
      na tela de terminal bloqueado" e a dica explica que aí não há quem no histórico de uso); na de erro fatal, só o log
      de texto. As duas telas mostram "o pacote contém registros técnicos do caixa…: entregue só ao suporte", e os botões
      têm 44 px.
    - **Restauração do backup** (aba 3 › F9 e aba 8, pelo login): como o backup, o Painel e o sync, o pacote é suspenso
      (`SuspenderParaRestauracaoAsync`, chamado pelo `RestaurarBackupViewModel`): cada leitura e a gravação do pacote no
      banco passam uma por vez com ela (a restauração espera a em curso por até 10 s), e depois que ela começou nenhuma
      parte lê nem grava — o pacote sai só com o manifesto e os logs, o aviso diz por quê, e a auditoria e a ocorrência
      não vão para o banco restaurado.
    - **Auditoria e ocorrência** (modo completo): a `exportar` (já no catálogo da nuvem; sobe no lote) com a entidade
      **`pacote_suporte`**, quem está na Central, quem liberou no `autorizado_por_id` (`AcessoCentral.AutorizadoPor`,
      decisão 67), a `localizacao` "PDV › Central do PDV › Pacote de suporte" e no `depois` o arquivo, o tamanho, o
      **SHA-256 do zip** e o destino (`pendrive` ou `documentos`, nunca o caminho, que tem o perfil do Windows); e a
      ocorrência nova **`PACOTE_GERADO`** (`info`, origem sistema, com a dica). No Histórico de uso, "gerou o pacote de
      suporte" (`DescritorAuditoria`; os campos `sha256` e `destino` exibíveis). Melhor esforço, como o backup agora
      (decisão 75): na D22 (o gatilho recusa a auditoria) ou com o banco ocupado, o pacote fica pronto e a tela diz que não
      ficou no histórico.
    - Fora deste bloco (plano 8, PC-12): o envio remoto do pacote pelo ERP (`enviar_logs` continua "não suportado";
      `POST /sync/logs`, o armazenamento e o "Pedir logs" no ERP ficam para a fase seguinte); o nível Debug temporário; a
      retenção do `log_local` e do outbox (PC-11: só medir); exportar o backup pela tela.
    Testes: `PacoteSuporteTelasTests` — a **varredura de segredos** (o critério de bloqueio do bloco): token (nos bytes
    do `token_protegido`, no `token.pendente`, num `Authorization: Bearer` do log, no `detalhes`, no erro do outbox, no
    resultado de um comando e na auditoria), chave privada (`terminal.chave_privada` e um PEM na exceção do log),
    `backup.chave` (na configuração e num JSON do log), hash de PIN (no espelho `usuarios`, no log e no texto técnico de
    uma ocorrência), CPF (pontuado e em `cpf_cnpj`) e BR Code (no payload do outbox, nos bytes da fila, no log e numa
    ocorrência) plantados no banco, na configuração e no log; **nenhum** aparece nos bytes do zip nem em nenhum arquivo
    dele descompactado (também com as aspas do CSV e do JSON desfeitas, e o token em base64); o zip sem `.db`, `-wal`,
    `-shm` nem `.gz` e só com nomes da lista; o manifesto que confere o tamanho e o SHA-256 de cada arquivo; o que entrou
    está lá, mascarado (o recusado, a ocorrência, o comando, a contagem da auditoria, a fila, a exceção do log com a
    chave escondida); a `exportar` com o hash do zip e sem o caminho, e o `PACOTE_GERADO`; o segundo pacote do mesmo
    minuto que não apaga o primeiro e vai para os Documentos sem pendrive (F5); ↑/↓, Enter, os botões de 44 px e o Esc;
    a MARIA pelo botão do Painel com o cadeado, o CARLOS liberando e o `autorizado_por_id`; o pacote na D22 com o aviso;
    o serviço que recusa sem a Central e sem a permissão e os nomes fora da lista; o **erro fatal com o banco corrompido
    e sem backup**: F2 gera o pacote sem banco (manifesto, `diagnostico.txt`, logs) com o banco intocado; o terminal
    bloqueado que gera sem login e grava a ocorrência; e o registro gigante cortado no meio da chave privada, que não vaza
    o resto dela. Na revisão do bloco: o comando que falhou com o erro em várias linhas e aspas (o `senha=` e o `Bearer`
    escapados) entra na varredura, e a aba 4 também o mascara; a conta que ativou o caixa na tela de terminal bloqueado
    (`%CONTA_ATIVACAO%`); a chave privada sem o `END` (o resto do log fica, com o marcador); o `CampoCsv` (`-1+1` e o DDE
    com apóstrofo, `-12.5` sem); o valor da configuração com `senha` e `pin`; o `EhPendrive` (exFAT, NTFS e FAT sob
    `/media`, a `/boot/efi` fora); o erro fatal por um serviço que não monta, pelo botão; a volta à aba P durante a
    geração (Esc, a aba 0 e a tecla `P` do Painel: o "gerando…" fica, o botão não gera outro, um zip só, e a frase do
    último pacote fica depois da volta pelo botão do Painel); a Central fechada enquanto o pedido esperava (recusado,
    nada gravado); a restauração suspendendo o pacote (só os logs, sem a `exportar`, e o `Suspenso` depois da
    restauração de verdade); e o outbox e a auditoria além do limite (volume sintético por `INSERT … WITH RECURSIVE`),
    com o corte no manifesto. As pastas de destino dos testes ficam dentro da pasta do PDV de teste (apagadas junto).
    Mais o `CatalogoOcorrenciasTests` (o código novo com dica) e o `DescritorAuditoriaTests` (a frase).

77. **O ERP mostra a saúde do computador do caixa** (Central do PDV, bloco G15; plano 6 e 7; PDV 32.2; SYNC 21.1, 21.2;
    ERP 12.4). Só a nuvem e o ERP mudam: **o PDV não muda** (continua 0.9.1, nada no contrato do heartbeat, nenhuma
    migração em nenhum banco). O dono vê pelo ERP o que o heartbeat já mandava desde a 1B e ninguém mostrava.
    - **API:** o `GET /api/terminais/:id` (`TerminalDetalhe` do shared) ganhou `discoLivreMb`, `tamanhoBancoMb` e
      `filaImpressaoPendentes`, lidos das colunas que o `POST /sync/heartbeat` já gravava em `terminais` (MD 3.15.1). Só
      o detalhe: a listagem (`TerminalResumo`) não muda, porque o plano pediu o detalhe e a coluna nova na lista seria
      uma decisão de tela à parte. Como o heartbeat grava o disco e o banco só quando vêm preenchidos (`?? undefined`, a
      regra de sempre da telemetria), um heartbeat que não conseguiu medir não apaga o último valor; a fila vem sempre
      (padrão 0 no contrato).
    - **Limites no shared** (`terminais.ts`): `nivelDiscoLivre` com `DISCO_LIVRE_AVISO_MB = 1024` e
      `DISCO_LIVRE_CRITICO_MB = 200`, os mesmos do Painel de saúde (`OpcoesSaude.DiscoAvisoBytes`/`DiscoBloqueioBytes`,
      decisão 69): o PDV compara bytes e manda MB arredondado para baixo, então "menos de 1 GB" lá é exatamente `< 1024`
      aqui (e `< 200` para o vermelho, em que o caixa não abre sessão nova sem o supervisor). `nivelFilaImpressao`:
      qualquer comprovante é âmbar. O heartbeat soma o que espera e o que falhou (`fila_impressao` `pendente` ou
      `falhou`), por isso o ERP **nunca pinta a fila de vermelho** (o Painel separa os dois; o ERP não sabe). O tamanho
      do banco não tem cor (PC-11: só medir; não há expurgo nem limite).
    - **SYNC 21.2 revista:** a linha "Disco" dizia "< 1 GB vermelho (PDV 32.2)"; a 32.2 revista no G4 diz < 1 GB amarelo
      e < 200 MB vermelho, e o ERP segue o PDV (o dono vê a mesma cor nos dois lugares).
    - **Tela** (`DetalheTerminal.tsx`, bloco novo **"Saúde do computador"** depois dos quatro blocos de cima, na largura
      toda como o Histórico: no grid de duas colunas o quinto bloco ficaria sozinho, com meia linha vazia): **Disco
      livre** ("47,1 GB"; abaixo de 1 GB o selo âmbar "850 MB · pouco espaço", abaixo de 200 MB o vermelho "150 MB ·
      quase cheio"), **Banco do caixa** ("412 MB", GB com uma casa a partir de 1024 MB) e **Fila de impressão** ("Nenhum"
      ou o selo âmbar "2 comprovantes não impressos": não "esperando", porque o número inclui os que falharam). O banco
      do ERP é **só o arquivo `pdv.db`** que o heartbeat mede (`FileInfo.Length`), sem o `-wal` e o `-shm`; o Sobre e o
      Painel somam os três (`MedidorDisco.TamanhoBanco`), então com um WAL grande antes do checkpoint o caixa mostra mais
      que o ERP. Só o formato segue o Sobre; o PDV não muda. Quando há cor, **o que fazer vai escrito embaixo**, numa
      linha própria na largura toda do bloco (não ao lado do rótulo, que ficaria espremido no celular; não só na dica: o
      dono olha de relance, e no celular não há passar o mouse), com as frases do Painel de saúde (`VerificacaoDisco`):
      no âmbar, "Libere espaço: apague arquivos que não são do caixa (downloads, fotos, vídeos) ou chame o suporte",
      e que abaixo de 200 MB o caixa não abre caixa novo e o supervisor pode liberar por 1 h; no vermelho, que abrir
      caixa novo está bloqueado (a venda em curso continua), a mesma frase de apagar e a liberação de 1 h. Nunca
      "programas que não usa": o driver da impressora, o TEF e o acesso remoto do suporte são programas. Para a fila,
      conferir papel e impressora e imprimir de novo na Central do PDV › 3 Impressora e gaveta (F7). A última linha diz
      de quando são os números: "Fila do último heartbeat (há 3 min); disco e banco da última medida." (a fila vem em
      todo heartbeat; o disco e o banco só quando o caixa conseguiu medir, e o anterior não é apagado; "há menos de 1
      min" no lugar de "agora") ou "O caixa ainda não mandou heartbeat.". **Sem heartbeat há mais de 24 h** (o
      `sem_contato` do ERP 12.1, pelo `ultimoHeartbeatEm`): os selos ficam **cinza** com o mesmo texto e, no lugar do
      que fazer, "Dado antigo: o caixa não manda heartbeat há mais de 24 h. Confira no Painel de saúde do caixa (Central
      do PDV › 0) antes de agir." (o disco pode já ter sido liberado ou enchido; mandar liberar espaço hoje com um dado
      de dez dias seria pedir o que talvez não precise). Sem o campo ("—", caixa que nunca informou). No **revogado**,
      só os últimos valores, sem selo nem cor (não há mais o que resolver). Os componentes `<DiscoLivre>` e
      `<FilaImpressao>` (o selo, com `modo` normal/antigo/sem_cor), o `dicaDiscoLivre`/`dicaFilaImpressao` (o que fazer)
      e o `tamanhoMb` ficam em `rotulos.tsx`, com o `data-nivel` (normal/aviso/critico) e o `data-antigo` que os testes
      conferem, como o `<DesvioRelogio>` (README do ERP › decisão 44). O `Campo` do detalhe ganhou a `dica` (a linha de
      baixo) e o valor passou a ser um `div` (o selo não cabe num parágrafo).
    - **Fora deste bloco:** coluna ou selo de disco na listagem de terminais e no Dashboard; alerta automático de disco
      quase cheio (`alertas`, SYNC 21.3 não tem um e criar exigiria regra de abrir/fechar como o `RELOGIO_DESVIO`); o
      "Solicitar logs" (envio remoto do pacote, PC-12, fase seguinte).
    Testes: `packages/shared/src/terminais.spec.ts` (`nivelDiscoLivre` nos limites 1024/1023 e 200/199, sem valor
    `null`; `nivelFilaImpressao` 0 e mais), `apps/erp-web/src/paginas/terminais/Terminais.test.tsx` (o `tamanhoMb`; o
    `<DiscoLivre>` e o `<FilaImpressao>` em cada faixa com o `data-nivel` e a cor que o Mantine grava no selo, cinza no
    dado antigo e sem cor no revogado; o `dicaDiscoLivre` nas duas faixas com as frases do Painel e sem "programa", e
    o `dicaFilaImpressao`; o detalhe com o disco crítico, o banco, a fila "não impressos" em âmbar, o que fazer fora da
    linha do rótulo, a origem "há 3 min" e o bloco fora do grid; a faixa âmbar com o que fazer e "há menos de 1 min";
    o heartbeat de dez dias com os selos cinza e o "Dado antigo" no lugar do que fazer; o detalhe sem os campos, com
    "—", "Nenhum" e "ainda não mandou heartbeat", e o revogado sem nenhum `data-nivel`) e
    `apps/api/test/integracao/terminais.test.ts` (os nulos e o 0 antes de qualquer medida; o heartbeat real com 850 MB,
    412 MB e 2 na fila chegando ao detalhe; o seguinte sem medir mantendo o disco e o banco e zerando a fila; a listagem
    sem a telemetria).

78. **Respostas do dono de 05/11/2026 na Central: o Encarregado cancela a venda paga e o "Quem" do Histórico de uso traz
    quem liberou** (Central do PDV, depois do G15; decisões do dono de 05/11/2026; PDV 13.3, 31.2, 32.1; roadmap D23).
    Duas respostas, sem pergunta nova: as duas saem decididas (não há "padrão até a confirmação do dono"). Versão
    continua **0.9.1**; nenhum contrato novo com a nuvem; **uma migração local de índice** (`IndiceAuditoriaAutorizadoPor`)
    e **nenhuma migração SQL na nuvem**.
    - **Encarregado cancela a venda paga do caixa aberto** (resposta à pergunta da decisão 66; diferente do Supervisor de
      caixa, que continua sem). `PDV_ENCARREGADO` em `perfis-padrao.ts` passa a ser `[...PDV_SUPERVISOR,
      'pdv.venda.cancelar_venda_finalizada']` — a permissão que o `ServicoVenda.CancelarFinalizadaAsync` e o
      `DialogoCancelarVendaFinalizadaViewModel` conferem desde o C11b: com ela, o encarregado logado cancela sem pedir
      ninguém; o operador e o supervisor pedem a liberação do PIN dele (`AutenticadorOffline.LiberarAsync` exige
      `pdv.supervisor` + a permissão, como sempre), e ele vai em `cancelamento_autorizado_por_id`, no `autorizado_por_id`
      dos estornos e na auditoria. **D23 continua valendo**: a permissão só alcança a venda **da sessão de caixa aberta**
      (`PrepararCancelamentoAsync` recusa a de outra sessão; a aba 1 Vendas mostra "Venda de caixa já fechado não se
      cancela no caixa" seja quem for) e não existe permissão de cancelar venda de caixa fechado (os testes do G1 que
      falham se ela aparecer continuam). Nada muda no código de cancelamento do caixa; mudam os textos que diziam "só o
      gerente": a recusa da liberação de quem não tem a permissão ("… não tem a permissão para cancelar venda paga
      (gerente ou encarregado)."), a ajuda F1 ("Ctrl+Del cancelar venda paga (gerente ou encarregado)"), o aviso da aba
      1 Vendas e os comentários; na nuvem, a explicação da regra "Quem libera o cancelamento da venda paga" da Prontidão
      (README da API › decisão 143), que passa a contar o encarregado com PIN como liberador. **Empresas já criadas:** pelo
      **seed idempotente do pós-migração**, o mesmo caminho do G1 (README da API › decisão 10): o `db:migrate:empresas`
      reaplica o seed em toda empresa, acrescenta a permissão ao perfil de sistema que nunca a teve e sobe o
      `permissoes_versao` dos usuários dele (o caixa recebe o perfil novo no próximo pull); a empresa que tirar a
      permissão do perfil não a recebe de volta. Por isso **não há migração SQL de empresa** (nem número novo de
      migração Drizzle: este branch está na 0019, a `main` na 0023 e o `funcionalidade/fase2-p5` na 0024 — e lá a
      resposta do Estoquista também foi pelo seed, sem a 0025 —; nada a renumerar no merge). A **descrição** do perfil
      de sistema mudou ("Supervisor de caixa + cancelar a venda paga do caixa aberto…"); o seed só a troca na empresa que
      ainda tem a descrição do G1 (`descricoesAnteriores` em `PerfilPadrao`; a que a empresa reescreveu fica).
    - **"Quem" do Histórico de uso inclui quem liberou com o PIN.** O `FiltroAuditoria.UsuarioId` passa a trazer o que a
      pessoa **fez** (`usuario_id`) **e** o que ela **liberou** para outra (`autorizado_por_id`), no SQL
      (`ConsultasAuditoriaLocal.Filtrar`); a lista de nomes do F7 (`UsuariosAsync`) junta os dois (duas leituras, cada uma
      pelo seu índice): o supervisor ou encarregado que só liberou passa a aparecer no F7 e, pelo Enter do resumo F6, a
      lista dele deixa de cair em "todos" (a mensagem "só deu liberações" saiu). **Como a tela diz que a linha entrou por
      ter liberado:** o `RegistroHistoricoUso.PorLiberacao` (a pessoa do filtro não é quem fez e é quem autorizou) põe o
      selo **LIBEROU** antes da frase (em âmbar, a palavra sempre ao lado da cor, PDV 9.1), a frase continua a de sempre
      ("MARIA cancelou uma venda em andamento · liberado por CARLOS"), a leitura para o leitor de tela começa por "CARLOS
      liberou com o PIN:", o rodapé explica o selo (`"LIBEROU": a ação foi de outra pessoa e CARLOS liberou com o PIN`) e
      o detalhe ganha a linha "Na lista porque CARLOS liberou com o PIN (a ação foi de MARIA).". O que a pessoa fez com a
      liberação de outro, ou liberou para si mesma, é "fez" (sem selo). O rótulo de acessibilidade do filtro passou a
      "Quem fez ou liberou". O resumo por operador não muda (as liberações dadas já eram contadas à parte).
      **Índice:** `ix_log_auditoria_local_autorizado_ocorrido_em` (`autorizado_por_id, ocorrido_em`), migração EF
      `IndiceAuditoriaAutorizadoPor` (depois do backup "antes-migracao" de sempre; só cria o índice, nenhum dado muda):
      com o `OR` das duas colunas o SQLite usa os dois índices, e o "quem liberou" de 30 dias com um ano de auditoria
      fica abaixo dos 300 ms do G10.
    - Testes: `permissoes.spec.ts` do shared (o Encarregado = Supervisor + só o cancelamento da venda paga; o Supervisor
      sem; a descrição nova e a anterior), `provisionamento.test.ts` (a empresa do G1, sem a permissão e com a descrição
      antiga: o pós-migração acrescenta só no Encarregado, troca a descrição, sobe o `permissoes_versao` do encarregado
      uma vez e não o do supervisor; reaplicado, nada muda; tirada pela empresa, não volta, e a descrição reescrita
      fica), `prontidao.test.ts` (o supervisor com PIN não resolve "Quem libera o cancelamento da venda paga"; o
      encarregado resolve), `CicloOnlineTests` (a declaração do `PDV_ENCARREGADO` acrescenta só essa chave ao supervisor),
      `GestaoVendasTelasTests` (a liberação do SUPERVISOR é negada e a venda continua paga; a do ENCARREGADO cancela, com
      ele em quem autorizou e na auditoria; o serviço recusa a liberação do supervisor sem a tela),
      `ConsultasAuditoriaLocalTests` (o filtro pela pessoa que só liberou, o F7 com ela, a migração do índice com a
      liberação de antes e o desempenho com o índice novo no plano) e `HistoricoUsoCentralTelasTests` (o F7 com o CARLOS,
      cada linha dele com o selo na tela, a leitura, o rodapé e o detalhe; a MARIA sem selo; o Enter no CARLOS pelo resumo
      vai à lista dele).

## Lacunas conhecidas (próximas fases)

SSE e snapshot, a recuperação de terminal antigo e a cifra do backup (22.3; a 22.1 chegou no C17, decisão 61),
exportação de pendências na
tela de desativado, ressincronização em sombra (6.11), comandos `enviar_logs`/`atualizar_app`/`reservar_faixa`,
as demais teclas do F11 (sangria, reforço, movimentos, limite de gaveta, resumo diário, status do sync e devolução de
cascos chegaram no C10b, decisão 53; a configuração do terminal e a abertura avulsa da gaveta, na I4, decisão 63), TEF, PIX dinâmico, crediário e as demais formas
da PDV-2 (dinheiro, maquininha e PIX estático chegaram no C11a, decisão 54), pesquisa FTS5, confirmação de idade e
horário restrito (fora da 1C pela O20 e a O21 do dono; só o espelho `restricoes_horario_venda` existe), "Bloqueia venda
sem estoque" nas alternativas do combo, variações, agrupamento configurável (`pdv.agrupa_produtos`) e `pdv.desmembra_produto_kit`,
na Central do PDV (Ctrl+Alt+C ou F11 › 8, aba 3: impressora, gaveta e "Restaurar backup", decisões 61, 63 e 68) o leitor serial, a
balança, o TEF e a tela, SQLCipher, AppImage e atualização automática (o instalador do Windows e o `.deb` chegaram na implantação I3, decisão 62; o `.deb` saiu da distribuição na decisão 80; a reimpressão e a gestão de vendas chegaram no C11b,
decisão 55; o desconto pelo valor do casco, no C11c, decisão 56). A senha da forma
(`formas_pagamento.senha_liberacao_hash`) e a do cliente usam o mesmo `VerificadorArgon2` quando as telas chegarem (a
ordem dos parâmetros do node-argon2 já é tratada).

Fila de decisão da nuvem (1C/C8, README da API › decisão 135): o reprocessamento e o descarte pelo ERP chegam ao
caixa pelo `eventos_resolvidos` que já existe (o `aplicado` vira `confirmado`, o `descartado` guarda o resultado); o
catálogo `CatalogosNuvem` ganhou a ação `evento_reprocessado`. A venda renumerada pela nuvem ("Aplicar com novo
número", faixa a partir de 9.000.001, T27) continua com o número do caixa no banco local: o `resultado` do evento traz
o número novo, que a gestão de vendas (F12, C11b, decisão 55) mostra ao lado do número do caixa; o comprovante
reimpresso continua o original, com o número do caixa.

79. **Versão 0.10.0: a Central do PDV** (05/11/2026). A `<Version>` do `Directory.Build.props` passa de 0.9.1 para
    **0.10.0** (e os exemplos do `GenesisPDV.iss` e do `gerar-instalador.ps1`), porque a Central (blocos G1 a G11, G9 e
    G15, decisões 66 a 78) muda o que o operador vê: a engrenagem ⚙ e o ⚠ na barra, as abas novas e as migrações locais de
    índices. Sobe o número do meio, e não o último, porque é funcionalidade nova, não correção. Nada muda no protocolo
    com a nuvem (`versoes_schema`), então o 0.9.x instalado continua vendendo com a API nova até a loja atualizar. O
    release sai pelo workflow "PDV release" e entra na página de download pela Implantação com `publicar_pdv`.

80. **PDV só no Windows: na CI, no release e na distribuição** (decisão do dono de 05/11/2026, para economizar minutos
    do GitHub Actions: GitHub Pro, 3.000 minutos por mês, e o runner Windows cobra 2×; D21; CONTRIBUTING.md › CI). As
    lojas usam só Windows, e o PDV no Linux era só para testes — e o job do PDV no Linux era o que mais gastava. O
    Linux deixa de ser **plataforma suportada de distribuição**:
    - **CI** (`.github/workflows/ci.yml`): o job do PDV deixa a matriz `ubuntu-latest`/`windows-latest` e roda só no
      `windows-latest`, com o mesmo nome de antes (`PDV (.NET 10) – windows-latest`): restore `--locked-mode`, build,
      a impressora de teste do spooler (decisão 63), os testes, o instalador e o teste dele (decisão 62). Saem o `.deb`
      (`gerar-pacote.sh` e `testar-deb.sh`), o artefato `GenesisPDV-deb` e a abertura do app com Xvfb no Linux. A
      definição de pronto da Fase 0 ("o PDV abre, cria o `pdv.db` e aplica as migrações locais") continua conferida no
      Windows pelo `testar-instalador.ps1`, que abre o PDV instalado com os caminhos da loja até "Banco local pronto".
    - **Formatação:** o `dotnet format --verify-no-changes`, que só rodava no PDV do Linux, vai para um job leve no
      `ubuntu-latest`, `PDV (.NET 10) – formatação` (checkout, SDK pelo `global.json`, `restore --locked-mode` e o
      format; sem build nem teste), com a mesma condição de mudanças do PDV (saída `pdv` do `mudancas.sh`). Fica no
      Linux para não depender do runner Windows (cobrado a 2× e mais lento para subir) nem das quebras de linha do
      checkout dele: o resultado é o mesmo da conferência local do `CLAUDE.md` › Checks.
    - **E2E PDV ↔ API** (`e2e-sync`, decisão 47): continua no Linux, como estava — é o teste da sincronização com a
      API (o PDV headless contra a API e o PostgreSQL do runner), não da distribuição.
    - **Release** (`.github/workflows/pdv-release.yml`): gera, testa e publica só o instalador do Windows (o `.exe` e o
      `.exe.sha256`); saem o job do `.deb` e o `.deb` das notas e dos arquivos do release. A Implantação
      (`implantacao.yml`, `publicar_pdv`) já só baixava e publicava o `.exe` e não muda; a página de download nunca
      ofereceu o `.deb`.
    - **O código continua multiplataforma:** nada muda no C# (o `ProtetorArquivo` do token no Linux, o
      `PermissoesGrupo`, as pastas de `/var/lib/genesispdv`, o transporte de dispositivo da impressora); o PDV compila e
      a suíte inteira roda no Linux do ambiente de desenvolvimento (as sessões na nuvem rodam os checks do `CLAUDE.md`
      no Linux), e os testes só de Windows (spooler, DPAPI) seguem pulando lá. O inverso também vale: os ramos só de
      Linux dos testes (as permissões `2770`/`g+rw` do `InicializacaoTests`, o `ProtetorArquivo` do `CriptografiaTests`)
      deixam de rodar na CI e ficam para a rodada local. Os scripts de `instalador/linux` ficam
      no repositório, **sem uso na CI** e sem garantia de que continuem funcionando; voltar a distribuir para Linux
      exige trazer de volta o job do `.deb` (o histórico do git tem o desenho da decisão 62) e o AppImage, que nunca
      chegou.
    - Nada muda no protocolo com a nuvem (`versoes_schema`) nem na versão do PDV: o instalado nas lojas continua igual.
    Na mesma economia, fora do PDV: o job TypeScript da CI roda só os testes unitários (shared, API e ERP), e a
    integração da API roda só no job do PostgreSQL 18, a versão da produção (antes rodava também no 16, no job
    TypeScript). Isso não foi pedido pelo dono, que falou só do PDV: foi escolha técnica, depois **decidida pelo dono
    em 05/11/2026** seguindo a recomendação (roadmap §16, D59); CONTRIBUTING.md › CI.
