# Impressora de teste do spooler RAW (implantação I4; README do PDV › decisão 63). Roda no CI (job do PDV no Windows),
# como administrador, antes dos testes:
#
#   pwsh apps/pdv/instalador/windows/preparar-impressora-teste.ps1
#
# Liga o serviço de spooler, instala o driver "Generic / Text Only" (do repositório de drivers do Windows), cria uma porta
# local que grava num arquivo e a impressora "GenesisPDV Teste RAW" nela, e passa o nome e o arquivo para os testes
# (GENESISPDV_IMPRESSORA_TESTE e GENESISPDV_IMPRESSORA_ARQUIVO no GITHUB_ENV): o SpoolerWindowsTests manda o documento
# pelo TransporteSpoolerWindows (OpenPrinter/StartDocPrinter RAW/WritePrinter) e confere os bytes no arquivo.
#
# No GitHub Actions (GITHUB_ACTIONS=true) qualquer falha do preparo é ERRO (::error:: e saída 1): é a única prova do envio
# RAW, e um aviso amarelo com o teste pulado deixaria o CI verde sem ela. Para tolerar um runner sem spooler, de
# propósito, defina a variável do repositório PDV_SPOOLER_OPCIONAL=1 (vira GENESISPDV_SPOOLER_OPCIONAL no job): aí, e
# fora do CI (execução local), o preparo só avisa e o teste fica pulado.
[CmdletBinding()]
param(
    [string] $Nome = 'GenesisPDV Teste RAW',
    [string] $Driver = 'Generic / Text Only'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$arquivo = Join-Path ([IO.Path]::GetTempPath()) 'genesispdv-impressora-raw.prn'
try {
    Set-Service -Name Spooler -StartupType Automatic
    Start-Service -Name Spooler
    if (-not (Get-PrinterDriver -Name $Driver -ErrorAction SilentlyContinue)) {
        Add-PrinterDriver -Name $Driver
    }

    if (-not (Get-PrinterPort -Name $arquivo -ErrorAction SilentlyContinue)) {
        Add-PrinterPort -Name $arquivo
    }

    if (Get-Printer -Name $Nome -ErrorAction SilentlyContinue) {
        Remove-Printer -Name $Nome
    }

    Add-Printer -Name $Nome -DriverName $Driver -PortName $arquivo
    $impressora = Get-Printer -Name $Nome
    Write-Host "Impressora de teste: $($impressora.Name) (driver $($impressora.DriverName), porta $($impressora.PortName))"
}
catch {
    $motivo = $_.Exception.Message
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GENESISPDV_SPOOLER_OPCIONAL -ne '1') {
        Write-Host "::error::Impressora de teste do spooler não preparada ($motivo): sem ela o envio RAW não é provado (PDV_SPOOLER_OPCIONAL=1 tolera o runner sem spooler)."
        exit 1
    }

    Write-Host "::warning::Spooler do Windows indisponível ($motivo): o teste do envio RAW fica pulado."
    exit 0
}

if ($env:GITHUB_ENV) {
    "GENESISPDV_IMPRESSORA_TESTE=$Nome" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "GENESISPDV_IMPRESSORA_ARQUIVO=$arquivo" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
