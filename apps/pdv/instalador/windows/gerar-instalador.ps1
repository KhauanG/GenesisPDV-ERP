# Gera o instalador do GenesisPDV para Windows (implantação I3; README do PDV › "Instalar na loja" e decisão 62):
# publica o executável único self-contained (win-x64) com a versão e a URL padrão da API, confere o executável
# (--info-build: versão, URL e sem demonstração), assina se houver certificado, compila o GenesisPDV.iss com o Inno Setup 6
# (instalado pelo Chocolatey se faltar) e grava o .sha256 ao lado. Usado pelo CI (job do PDV no Windows) e pelo
# workflow pdv-release; roda igual numa máquina Windows com o SDK do .NET 10:
#
#   pwsh apps/pdv/instalador/windows/gerar-instalador.ps1 [-Versao 0.12.0] [-UrlApi https://api.grupoicebeer.com.br]
#
# Sem -Versao vale a <Version> do apps/pdv/Directory.Build.props (a fonte única). Assinatura de código (opcional): as
# variáveis PDV_CERT_PFX_BASE64 e PDV_CERT_SENHA (segredos do ambiente release-pdv do GitHub); sem elas o passo é pulado
# e o Windows mostra o aviso do SmartScreen na instalação. Os dois saem do ambiente do processo logo no começo (nenhum
# processo filho os herda: dotnet publish, Chocolatey, ISCC) e a senha nunca vai para uma linha de comando: o .pfx entra
# num repositório de certificados temporário (Cert:\CurrentUser\My) e o signtool assina pela impressão digital (/sha1),
# que não é segredo; o certificado e a chave saem no fim. Saída: apps/pdv/publish/instalador/GenesisPDV-Setup-<versão>.exe
# (+ .sha256).
#
#   pwsh apps/pdv/instalador/windows/gerar-instalador.ps1 -PrepararInnoSetup
#
# só garante o Inno Setup (a versão fixa abaixo, pelo Chocolatey, se faltar um 6.3+) e sai: o workflow de release roda
# isso num passo próprio, sem os segredos no ambiente.
[CmdletBinding()]
param(
    [string] $Versao = '',
    [string] $UrlApi = 'https://api.grupoicebeer.com.br',
    [string] $Saida = '',
    [switch] $PrepararInnoSetup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Segredos da assinatura: lidos para variáveis do script e apagados do ambiente antes de qualquer processo filho.
$pfxBase64 = $env:PDV_CERT_PFX_BASE64
$senhaCertificado = $env:PDV_CERT_SENHA
Remove-Item Env:PDV_CERT_PFX_BASE64, Env:PDV_CERT_SENHA -ErrorAction SilentlyContinue

# Inno Setup 6.3 ou mais novo (o x64compatible do .iss). Faltando, esta versão fixa do pacote do Chocolatey (nunca "a mais
# nova"): atualizar é trocar o número aqui, revisado como qualquer mudança.
$VersaoInnoSetup = '6.4.3'

$pastaPdv = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$projeto = Join-Path $pastaPdv 'src\GenesisPDV.App\GenesisPDV.App.csproj'
$publicacao = Join-Path $pastaPdv 'publish\win-x64'
if (-not $Saida) { $Saida = Join-Path $pastaPdv 'publish\instalador' }

function Falhar([string] $mensagem) {
    Write-Host "::error::$mensagem"
    exit 1
}

function AcharIscc {
    $candidatos = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")
    # Instalação em outro lugar (ex.: a imagem do runner): pela entrada de desinstalação do Inno Setup ou pelo PATH.
    foreach ($chave in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1')) {
        # StrictMode: a entrada pode não existir ou não ter InstallLocation; ler a propriedade direto lançaria erro.
        $entrada = Get-ItemProperty $chave -ErrorAction SilentlyContinue
        $local = if ($entrada -and $entrada.PSObject.Properties['InstallLocation']) { $entrada.InstallLocation } else { $null }
        if ($local) { $candidatos += (Join-Path $local 'ISCC.exe') }
    }
    $comando = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($comando) { $candidatos += $comando.Source }
    $candidatos | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# Versão do Inno Setup do ISCC.exe. O ISCC.exe do instalador oficial não tem versão no próprio arquivo (o runner mostrou
# 0.0.0), então a ordem é: versão do arquivo; texto do produto; DisplayVersion da entrada de desinstalação do Inno Setup;
# a linha "Inno Setup X.Y.Z" que o próprio ISCC escreve ao rodar sem argumentos; 0.0.0 se nada disso disser.
function VersaoIscc([string] $arquivo) {
    $info = (Get-Item $arquivo).VersionInfo
    if ($info.FileMajorPart -gt 0) { return [version]::new($info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart) }
    if ("$($info.ProductVersion)" -match '(\d+)\.(\d+)\.(\d+)') { return [version]::new($Matches[1], $Matches[2], $Matches[3]) }
    foreach ($chave in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1')) {
        $entrada = Get-ItemProperty $chave -ErrorAction SilentlyContinue
        if ($entrada -and $entrada.PSObject.Properties['DisplayVersion'] -and
            "$($entrada.DisplayVersion)" -match '(\d+)\.(\d+)\.(\d+)') {
            return [version]::new($Matches[1], $Matches[2], $Matches[3])
        }
    }
    $saida = (& $arquivo 2>&1 | Out-String)
    if ($saida -match 'Inno Setup (\d+)\.(\d+)\.(\d+)') { return [version]::new($Matches[1], $Matches[2], $Matches[3]) }
    return [version]'0.0.0'
}

# Versão do pacote innosetup instalado pelo Chocolatey (0.0.0 se não houver).
function VersaoChocoInnoSetup {
    $linha = (& choco list innosetup --exact --limit-output 2>$null | Select-Object -First 1)
    if ("$linha" -match '^innosetup\|(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    return [version]'0.0.0'
}

# O runner do GitHub pode não ter o Inno Setup (ou ter um anterior ao 6.3): instala a versão fixa pelo Chocolatey.
# Um 6.3+ que já esteja na máquina (a imagem do runner traz um mais novo que a versão fixa) é usado como está.
function GarantirInnoSetup {
    $minima = [version]'6.3.0'
    $desconhecida = [version]'0.0.0'
    $iscc = AcharIscc
    # Versão do ISCC achado ou, se ele não disser, a do pacote do Chocolatey (o runner traz o Inno Setup por ele).
    $versao = if ($iscc) { VersaoIscc $iscc } else { $desconhecida }
    $choco = VersaoChocoInnoSetup
    if ($versao -eq $desconhecida -and $choco -gt $desconhecida) { $versao = $choco }
    if (-not $iscc -or ($versao -ne $desconhecida -and $versao -lt $minima)) {
        if ($choco -lt $minima) {
            & choco upgrade innosetup --version $VersaoInnoSetup --no-progress -y | Out-Host
            if ($LASTEXITCODE -ne 0) { Falhar "choco upgrade innosetup --version $VersaoInnoSetup falhou." }
        }
        $iscc = AcharIscc
        if (-not $iscc) { Falhar 'ISCC.exe não encontrado (nem nas pastas do Inno Setup 6, nem no registro, nem no PATH).' }
        $versao = VersaoIscc $iscc
        if ($versao -eq $desconhecida) { $versao = VersaoChocoInnoSetup }
        if ($versao -ne $desconhecida -and $versao -lt $minima) { Falhar "Inno Setup $versao em $iscc; é preciso o 6.3 ou mais novo." }
    }
    if ($versao -eq $desconhecida) {
        # Sem como saber a versão: segue, e um Inno Setup antigo demais recusa o .iss na compilação (x64compatible).
        Write-Host "::warning::Versão do Inno Setup em $iscc não identificada; seguindo (um anterior ao 6.3 recusa o .iss)."
    }
    Write-Host "Inno Setup $versao (pacote do Chocolatey: $choco): $iscc"
    return $iscc
}

if ($PrepararInnoSetup) {
    GarantirInnoSetup | Out-Null
    exit 0
}

if (-not $Versao) {
    $Versao = (& dotnet msbuild $projeto -getProperty:Version | Out-String).Trim()
}
# Só X.Y.Z: é o que vai no VersionInfo do Windows, no nome do arquivo e no versao_app comparado pela nuvem.
if ($Versao -notmatch '^\d+\.\d+\.\d+$') { Falhar "Versão inválida '$Versao' (use X.Y.Z)." }
Write-Host "GenesisPDV $Versao, API padrão $UrlApi"

# 1. Publicação: dotnet publish nunca leva a demonstração (ModoDemonstracao=false ao publicar).
if (Test-Path $publicacao) { Remove-Item -Recurse -Force $publicacao }
& dotnet publish $projeto -c Release -r win-x64 --self-contained -p:PublishSingleFile=true `
    "-p:Version=$Versao" "-p:GenesisUrlApiPadrao=$UrlApi" -o $publicacao
if ($LASTEXITCODE -ne 0) { Falhar 'dotnet publish falhou.' }
$exe = Join-Path $publicacao 'GenesisPDV.exe'
$extras = @(Get-ChildItem $publicacao | Where-Object { $_.Name -ne 'GenesisPDV.exe' })
if ($extras.Count -gt 0) { Falhar "A publicação deveria ter só o GenesisPDV.exe; veio também: $($extras.Name -join ', ')" }

# 2. Conferência do executável publicado (o mesmo que vai para o instalador).
$info = Join-Path ([IO.Path]::GetTempPath()) "genesispdv-info-$([guid]::NewGuid().ToString('N')).json"
$processo = Start-Process -FilePath $exe -ArgumentList '--info-build', "`"$info`"" -Wait -PassThru
if ($processo.ExitCode -ne 0 -or -not (Test-Path $info)) { Falhar "GenesisPDV.exe --info-build falhou (código $($processo.ExitCode))." }
$build = Get-Content $info -Raw | ConvertFrom-Json
Remove-Item $info
if ($build.versao -ne $Versao) { Falhar "O executável diz versão $($build.versao), esperado $Versao." }
if ($build.url_api_padrao -ne $UrlApi) { Falhar "O executável diz URL $($build.url_api_padrao), esperado $UrlApi." }
if ($build.modo_demonstracao) { Falhar 'O executável publicado está com o modo demonstração.' }
Write-Host "Executável conferido: $($build | ConvertTo-Json -Compress)"

# 3. Assinatura opcional (segredos do GitHub). O .pfx vai para Cert:\CurrentUser\My só durante a geração; o signtool e o
# SignTool do Inno assinam pela impressão digital (/sha1), sem senha na linha de comando nem na saída do ISCC.
$impressao = $null
$signtool = $null
if ($pfxBase64) {
    if (-not $senhaCertificado) { Falhar 'PDV_CERT_PFX_BASE64 sem PDV_CERT_SENHA.' }
    $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $signtool) { Falhar 'signtool.exe não encontrado (Windows SDK).' }
}

$pfx = $null
try {
    if ($pfxBase64) {
        $pfx = Join-Path ([IO.Path]::GetTempPath()) "genesispdv-$([guid]::NewGuid().ToString('N')).pfx"
        [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($pfxBase64))
        # O segredo já chega em texto pelo ambiente do GitHub; o SecureString só o leva ao Import-PfxCertificate.
        $senhaSegura = ConvertTo-SecureString -String $senhaCertificado -AsPlainText -Force
        $impressao = (Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $senhaSegura).Thumbprint
        Remove-Item -Force $pfx
        $pfx = $null
        $pfxBase64 = $null
        $senhaCertificado = $null
        & $signtool sign /sha1 $impressao /fd sha256 /tr http://timestamp.digicert.com /td sha256 /d GenesisPDV $exe
        if ($LASTEXITCODE -ne 0) { Falhar 'Assinatura do GenesisPDV.exe falhou.' }
    }
    else {
        Write-Host 'Sem PDV_CERT_PFX_BASE64: instalador sem assinatura (o Windows mostra o aviso do SmartScreen).'
    }

    # 4. Inno Setup (a versão fixa, se faltar; no workflow de release já veio do passo sem segredos).
    $iscc = GarantirInnoSetup

    # 5. Compilação do .iss (com o $f do Inno: o arquivo a assinar; $q são aspas).
    New-Item -ItemType Directory -Force -Path $Saida | Out-Null
    $argumentos = @("/DVersaoApp=$Versao", "/DPastaPublicacao=$publicacao", "/DPastaSaida=$Saida")
    if ($impressao) {
        $argumentos += '/DAssinar'
        $argumentos += "/Sgenesis=`$q$signtool`$q sign /sha1 $impressao /fd sha256 /tr http://timestamp.digicert.com /td sha256 /d GenesisPDV `$f"
    }
    $argumentos += (Join-Path $PSScriptRoot 'GenesisPDV.iss')
    & $iscc @argumentos
    if ($LASTEXITCODE -ne 0) { Falhar 'ISCC (Inno Setup) falhou.' }
}
finally {
    if ($pfx -and (Test-Path $pfx)) { Remove-Item -Force $pfx }
    if ($impressao) {
        $certificado = "Cert:\CurrentUser\My\$impressao"
        Remove-Item -Path $certificado -DeleteKey -ErrorAction SilentlyContinue
        if (Test-Path $certificado) { Remove-Item -Path $certificado }
    }
}

# 6. sha256 no formato do sha256sum (confere com "sha256sum -c" ou Get-FileHash).
$instalador = Join-Path $Saida "GenesisPDV-Setup-$Versao.exe"
if (-not (Test-Path $instalador)) { Falhar "Instalador não gerado: $instalador" }
$hash = (Get-FileHash -Algorithm SHA256 $instalador).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$instalador.sha256", "$hash  GenesisPDV-Setup-$Versao.exe`n")
Write-Host "Instalador: $instalador ($([math]::Round((Get-Item $instalador).Length / 1MB, 1)) MB, sha256 $hash)"
if ($env:GITHUB_OUTPUT) {
    "instalador=$instalador" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    "versao=$Versao" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
