# Teste de fumaça do instalador do GenesisPDV no Windows (implantação I3; README do PDV › decisão 62). Roda no CI (job
# do PDV no Windows e workflow pdv-release), como administrador, numa máquina sem o GenesisPDV:
#
#   pwsh apps/pdv/instalador/windows/testar-instalador.ps1 -Instalador <GenesisPDV-Setup-x.y.z.exe> -Versao x.y.z -UrlApi <url>
#
# 1. instala em silêncio e confere o exe, as pastas de %ProgramData%\GenesisPDV com MODIFICAR para Usuários, os atalhos,
#    a entrada de "Iniciar com o Windows", o registro de desinstalação com a versão e o --info-build do exe instalado;
# 2. abre o PDV instalado com os caminhos padrão (sem GENESISPDV_DADOS) até o log de %ProgramData%\GenesisPDV\logs dizer
#    "Banco local pronto" e confere o pdv.db em %ProgramData%\GenesisPDV\dados;
# 3. com o PDV aberto, o instalador por cima recusa (AppMutex) e não troca o exe; fechado, reinstala por cima, o pdv.db é
#    o mesmo (sha256) e o PDV reabre com ele; um instalador "mais antigo" que o instalado (DisplayVersion 99.0.0) desiste;
# 4. desinstala em silêncio e confere que o app saiu e o pdv.db e os dados de %ProgramData%\GenesisPDV ficaram.
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Instalador,
    [Parameter(Mandatory)] [string] $Versao,
    [Parameter(Mandatory)] [string] $UrlApi
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$appId = '{7125763E-1F1B-4A8F-9DE6-A27FFBE93EBB}_is1'
$pastaApp = Join-Path $env:ProgramFiles 'GenesisPDV'
$exe = Join-Path $pastaApp 'GenesisPDV.exe'
$pastaDados = Join-Path $env:ProgramData 'GenesisPDV'
$chaveRun = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$chaveDesinstalar = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$appId"
$atalhoMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\GenesisPDV.lnk'
$atalhoAreaTrabalho = Join-Path $env:PUBLIC 'Desktop\GenesisPDV.lnk'
$banco = Join-Path $pastaDados 'dados\pdv.db'
$pastaLogs = Join-Path $pastaDados 'logs'
$temp = Join-Path ([IO.Path]::GetTempPath()) "genesispdv-teste-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$Instalador = (Resolve-Path $Instalador).Path

function Falhar([string] $mensagem) {
    Write-Host "::error::$mensagem"
    @(Get-ChildItem $temp -Filter '*.log' -ErrorAction SilentlyContinue) + @(Get-ChildItem $pastaLogs -Filter '*.log' -ErrorAction SilentlyContinue) |
        ForEach-Object {
            Write-Host "--- $($_.Name)"
            Get-Content $_.FullName -Tail 60
        }
    exit 1
}

function Conferir([bool] $condicao, [string] $mensagem) {
    if (-not $condicao) { Falhar $mensagem }
    Write-Host "ok: $mensagem"
}

# Roda um instalador/desinstalador em silêncio com prazo (nunca fica preso numa caixa de mensagem) e devolve o código.
function Executar([string] $arquivo, [string] $log) {
    $argumentos = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"")
    $processo = Start-Process -FilePath $arquivo -ArgumentList $argumentos -PassThru
    if (-not $processo.WaitForExit(300000)) {
        $processo.Kill()
        Falhar "$arquivo não terminou em 5 min."
    }
    return $processo.ExitCode
}

function TemModificarParaUsuarios([string] $pasta) {
    $usuarios = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
    $modificar = [System.Security.AccessControl.FileSystemRights]::Modify
    foreach ($regra in (Get-Acl $pasta).Access) {
        try { $sid = $regra.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) } catch { continue }
        if ($sid -eq $usuarios -and $regra.AccessControlType -eq 'Allow' -and (($regra.FileSystemRights -band $modificar) -eq $modificar)) {
            return $true
        }
    }
    return $false
}

function InfoBuild([string] $arquivoExe) {
    $info = Join-Path $temp "info-$([guid]::NewGuid().ToString('N')).json"
    $processo = Start-Process -FilePath $arquivoExe -ArgumentList '--info-build', "`"$info`"" -Wait -PassThru
    if ($processo.ExitCode -ne 0 -or -not (Test-Path $info)) { Falhar "--info-build falhou em $arquivoExe." }
    return Get-Content $info -Raw | ConvertFrom-Json
}

# Quantas aberturas do PDV chegaram a "Banco local pronto" no log de %ProgramData%\GenesisPDV\logs.
function Aberturas {
    @(Get-ChildItem $pastaLogs -Filter '*.log' -ErrorAction SilentlyContinue | Select-String -Pattern 'Banco local pronto' -SimpleMatch).Count
}

# Abre o PDV instalado com os caminhos padrão (os da loja) e espera, com prazo, a abertura número $numero.
function AbrirPdv([int] $numero) {
    $processo = Start-Process -FilePath $exe -PassThru
    $limite = (Get-Date).AddSeconds(90)
    while ((Aberturas) -lt $numero -and (Get-Date) -lt $limite -and -not $processo.HasExited) { Start-Sleep -Milliseconds 500 }
    if ((Aberturas) -lt $numero) {
        if (-not $processo.HasExited) { $processo.Kill() }
        Falhar "o PDV instalado não chegou a ""Banco local pronto"" (abertura $numero) em 90 s."
    }
    return $processo
}

Conferir (-not (Test-Path $exe)) 'máquina sem o GenesisPDV antes do teste'
Conferir (-not (Test-Path $banco)) "sem pdv.db em $banco antes do teste"

# 1. Instalação silenciosa.
$codigo = Executar $Instalador (Join-Path $temp 'instalar.log')
Conferir ($codigo -eq 0) "instalação silenciosa terminou com 0 (veio $codigo)"
Conferir (Test-Path $exe) "exe instalado em $exe"
foreach ($sub in @('', 'dados', 'backup', 'logs', 'impressao')) {
    $pasta = Join-Path $pastaDados $sub
    Conferir (Test-Path $pasta) "pasta $pasta criada"
    Conferir (TemModificarParaUsuarios $pasta) "Usuários com MODIFICAR em $pasta"
}
Conferir (Test-Path $atalhoMenu) "atalho no menu Iniciar ($atalhoMenu)"
Conferir (Test-Path $atalhoAreaTrabalho) "atalho na área de trabalho ($atalhoAreaTrabalho)"
$run = (Get-ItemProperty -Path $chaveRun -Name 'GenesisPDV' -ErrorAction SilentlyContinue).GenesisPDV
Conferir ($run -eq "`"$exe`"") "Iniciar com o Windows marcado por padrão (Run = $run)"
$registro = Get-ItemProperty -Path $chaveDesinstalar -ErrorAction SilentlyContinue
Conferir ($null -ne $registro -and $registro.DisplayVersion -eq $Versao) "registro de desinstalação com a versão $Versao"
$build = InfoBuild $exe
Conferir ($build.versao -eq $Versao -and $build.url_api_padrao -eq $UrlApi -and -not $build.modo_demonstracao) `
    "exe instalado: versão $($build.versao), URL $($build.url_api_padrao), demonstração $($build.modo_demonstracao)"

# 2. Abre o PDV instalado como na loja (sem tela de ativação a responder: só até o banco local ficar pronto). Sem
# GENESISPDV_DADOS: o banco tem de nascer em %ProgramData%\GenesisPDV\dados, a pasta que o instalador cria e preserva.
Conferir ($null -eq $env:GENESISPDV_DADOS) 'GENESISPDV_DADOS não definida (caminhos padrão do PDV)'
$pdv = AbrirPdv 1
Conferir (Test-Path $banco) "PDV instalado abriu e criou o banco em $banco"

# 3a. Com o PDV aberto, o instalador por cima não segue (AppMutex) e o exe continua o mesmo.
$antes = (Get-Item $exe).LastWriteTimeUtc
$logAberto = Join-Path $temp 'reinstalar-aberto.log'
$codigo = Executar $Instalador $logAberto
Conferir ($codigo -ne 0) "instalador recusou com o PDV aberto (código $codigo)"
Conferir ([bool](Select-String -Path $logAberto -Pattern 'aberto neste computador' -SimpleMatch -Quiet)) 'o log do instalador mostra o aviso do PDV aberto'
Conferir ((Get-Item $exe).LastWriteTimeUtc -eq $antes) 'exe não foi trocado com o PDV aberto'
Conferir (-not $pdv.HasExited) 'o PDV continuou aberto'
$pdv.Kill()
$pdv.WaitForExit()

# 3b. Fechado o PDV, reinstala por cima; o pdv.db de ProgramData (o mesmo sha256) e um marcador na pasta de dados ficam,
# e o PDV reabre com esse banco.
$marcador = Join-Path $pastaDados 'dados\marcador-ci.txt'
Set-Content -Path $marcador -Value "teste do instalador $Versao"
$hashBanco = (Get-FileHash -Algorithm SHA256 $banco).Hash
$codigo = Executar $Instalador (Join-Path $temp 'reinstalar.log')
Conferir ($codigo -eq 0) "reinstalação por cima terminou com 0 (veio $codigo)"
Conferir ((Test-Path $exe) -and (Test-Path $marcador)) 'reinstalação manteve o exe e o marcador em ProgramData'
Conferir ((Test-Path $banco) -and (Get-FileHash -Algorithm SHA256 $banco).Hash -eq $hashBanco) "reinstalação manteve o pdv.db de ProgramData intacto (sha256)"
Conferir ($null -ne (Get-ItemProperty -Path $chaveRun -Name 'GenesisPDV' -ErrorAction SilentlyContinue)) 'Iniciar com o Windows continua na reinstalação'
$pdv = AbrirPdv 2
Conferir ((Test-Path $banco) -and -not $pdv.HasExited) 'PDV reinstalado reabriu com o banco de ProgramData'
$pdv.Kill()
$pdv.WaitForExit()
$hashBanco = (Get-FileHash -Algorithm SHA256 $banco).Hash

# 3c. Instalador mais antigo que o instalado (o Setup velho que ficou em Downloads): simula a 99.0.0 instalada e confere
# que o silencioso desiste sem trocar o exe nem o banco; depois a DisplayVersion volta.
$antes = (Get-Item $exe).LastWriteTimeUtc
Set-ItemProperty -Path $chaveDesinstalar -Name 'DisplayVersion' -Value '99.0.0'
$logAntigo = Join-Path $temp 'instalar-antigo.log'
$codigo = Executar $Instalador $logAntigo
Set-ItemProperty -Path $chaveDesinstalar -Name 'DisplayVersion' -Value $Versao
Conferir ($codigo -ne 0) "instalador mais antigo que o instalado desistiu (código $codigo)"
Conferir ([bool](Select-String -Path $logAntigo -Pattern 'mais antiga por cima de uma mais nova' -SimpleMatch -Quiet)) 'o log do instalador diz que a versão instalada é mais nova'
Conferir ((Get-Item $exe).LastWriteTimeUtc -eq $antes -and (Get-FileHash -Algorithm SHA256 $banco).Hash -eq $hashBanco) 'exe e banco intactos'

# 4. Desinstalação silenciosa: o app sai, os dados ficam.
$desinstalador = Join-Path $pastaApp 'unins000.exe'
Conferir (Test-Path $desinstalador) "desinstalador em $desinstalador"
$codigo = Executar $desinstalador (Join-Path $temp 'desinstalar.log')
Conferir ($codigo -eq 0) "desinstalação silenciosa terminou com 0 (veio $codigo)"
# O desinstalador do Inno termina numa cópia temporária: espera (com prazo) o exe e o registro de desinstalação sumirem.
$limite = (Get-Date).AddSeconds(60)
while (((Test-Path $exe) -or (Test-Path $chaveDesinstalar)) -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }
Conferir (-not (Test-Path $exe)) 'exe removido'
Conferir (-not (Test-Path $atalhoMenu) -and -not (Test-Path $atalhoAreaTrabalho)) 'atalhos removidos'
Conferir ($null -eq (Get-ItemProperty -Path $chaveRun -Name 'GenesisPDV' -ErrorAction SilentlyContinue)) 'Iniciar com o Windows removido'
Conferir (-not (Test-Path $chaveDesinstalar)) 'registro de desinstalação removido'
Conferir ((Test-Path $marcador) -and (Get-FileHash -Algorithm SHA256 $banco).Hash -eq $hashBanco) "pdv.db e dados em $pastaDados preservados na desinstalação"
Conferir (TemModificarParaUsuarios (Join-Path $pastaDados 'dados')) 'pasta de dados continua com a permissão de Usuários'

Remove-Item -Force $marcador
Write-Host 'Instalador do GenesisPDV conferido: instala, abre com o banco em ProgramData, recusa com o PDV aberto e a versão mais antiga, reinstala e desinstala sem perder dados.'
