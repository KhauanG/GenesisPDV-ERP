; Instalador do GenesisPDV para Windows (implantação I3; PDV 5.1, 32.6 e 32.7; README do PDV › "Instalar na loja" e
; decisão 62). Inno Setup 6, compilado pelo gerar-instalador.ps1 (CI do PDV no Windows e workflow pdv-release):
;
;   iscc /DVersaoApp=0.12.0 /DPastaPublicacao=<publish\win-x64> /DPastaSaida=<saída> GenesisPDV.iss
;
; - Por máquina (administrador), só x64, Windows 10 22H2 (10.0.19045) ou mais novo.
; - O aplicativo (o executável único self-contained do dotnet publish) vai para {autopf}\GenesisPDV; os dados ficam em
;   %ProgramData%\GenesisPDV\{dados,backup,logs,impressao} (CaminhosPdv.cs) com permissão de MODIFICAR para o grupo
;   Usuários: o PDV roda com a conta comum da loja, e sem isso o banco em ProgramData não abre.
; - Atualizar = instalar a versão nova por cima (o AppId é fixo, nunca mude): banco, backups e ativação ficam. Com o PDV
;   aberto (AppMutex = InstanciaUnica.NomePadrao), o instalador pede para fechá-lo pelo próprio programa, que faz o
;   backup de saída (C17); nunca fecha o processo sozinho (CloseApplications=no).
; - Versão mais antiga por cima de uma mais nova: recusada no modo silencioso e só com confirmação explícita (padrão
;   "Não") na tela, porque o PDV antigo não abre o banco que o novo migrou (InicializadorBanco, BancoDeVersaoMaisNova).
; - Desinstalar não apaga %ProgramData%\GenesisPDV (banco, backups, logs): a mensagem final diz onde ficaram.
; - Assinatura opcional (/DAssinar e /Sgenesis=... do gerar-instalador.ps1, com os segredos do GitHub); sem ela o
;   Windows mostra o aviso do SmartScreen (README).

#ifndef VersaoApp
  #error Informe a versão: iscc /DVersaoApp=x.y.z GenesisPDV.iss
#endif
#ifndef PastaPublicacao
  #define PastaPublicacao "..\..\publish\win-x64"
#endif
#ifndef PastaSaida
  #define PastaSaida "..\..\publish\instalador"
#endif

#define NomeApp "GenesisPDV"
#define ExeApp "GenesisPDV.exe"
; O mesmo nome de InstanciaUnica.NomePadrao (apps/pdv/src/GenesisPDV.App/Servicos/InstanciaUnica.cs).
#define MutexApp "Global\GenesisPDV.Instancia"
#define PastaDados "{commonappdata}\GenesisPDV"

[Setup]
; AppId fixo: é ele que faz a versão nova instalar por cima da anterior (e o que o desinstalador procura). Nunca mude.
AppId={{7125763E-1F1B-4A8F-9DE6-A27FFBE93EBB}
AppName={#NomeApp}
AppVersion={#VersaoApp}
AppVerName={#NomeApp} {#VersaoApp}
AppPublisher=Genesis
AppCopyright=Genesis
DefaultDirName={autopf}\{#NomeApp}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
OutputDir={#PastaSaida}
OutputBaseFilename=GenesisPDV-Setup-{#VersaoApp}
SetupIconFile=..\..\src\GenesisPDV.App\Assets\genesispdv.ico
UninstallDisplayIcon={app}\{#ExeApp}
UninstallDisplayName={#NomeApp}
VersionInfoVersion={#VersaoApp}
VersionInfoProductVersion={#VersaoApp}
VersionInfoTextVersion={#VersaoApp}
VersionInfoCompany=Genesis
VersionInfoProductName={#NomeApp}
VersionInfoDescription=Instalador do GenesisPDV (frente de caixa)
AppMutex={#MutexApp}
SetupMutex=GenesisPDV.Instalador,Global\GenesisPDV.Instalador
CloseApplications=no
RestartApplications=no
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
#ifdef Assinar
SignTool=genesis
SignedUninstaller=yes
#endif

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
SetupAppRunningError=O instalador encontrou o %1 aberto neste computador.%n%nFeche o PDV pelo próprio programa (termine a venda em andamento e saia com Alt+F4): assim ele faz o backup de saída. Depois clique em OK para continuar, ou em Cancelar para sair.
UninstallAppRunningError=O desinstalador encontrou o %1 aberto neste computador.%n%nFeche o PDV pelo próprio programa (termine a venda em andamento e saia com Alt+F4): assim ele faz o backup de saída. Depois clique em OK para continuar, ou em Cancelar para sair.

[Tasks]
Name: "areadetrabalho"; Description: "Criar o atalho na área de trabalho"; GroupDescription: "Atalhos:"
Name: "iniciarcomwindows"; Description: "Abrir o GenesisPDV ao entrar no Windows"; GroupDescription: "Inicialização:"

[Dirs]
; Usuários (S-1-5-32-545) com MODIFICAR, herdado pelas subpastas e arquivos; nada daqui sai na desinstalação.
Name: "{#PastaDados}"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#PastaDados}\dados"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#PastaDados}\backup"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#PastaDados}\logs"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#PastaDados}\impressao"; Permissions: users-modify; Flags: uninsneveruninstall

[Files]
Source: "{#PastaPublicacao}\{#ExeApp}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#NomeApp}"; Filename: "{app}\{#ExeApp}"; WorkingDir: "{app}"; Comment: "Frente de caixa do Genesis"
Name: "{autodesktop}\{#NomeApp}"; Filename: "{app}\{#ExeApp}"; WorkingDir: "{app}"; Comment: "Frente de caixa do Genesis"; Tasks: areadetrabalho

[Registry]
; "Iniciar com o Windows" (PDV 5.1, marcada por padrão) para qualquer usuário que entrar; desmarcada numa reinstalação,
; a entrada da instalação anterior sai.
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#NomeApp}"; ValueData: """{app}\{#ExeApp}"""; Flags: uninsdeletevalue; Tasks: iniciarcomwindows
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "{#NomeApp}"; Flags: deletevalue; Tasks: not iniciarcomwindows

[Run]
; Com a conta de quem chamou o instalador, não a do administrador da elevação: o token da ativação fica na DPAPI da
; conta que roda o PDV (D21).
Filename: "{app}\{#ExeApp}"; Description: "Abrir o GenesisPDV agora"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
// Próximo número de uma versão X.Y.Z (consome o texto até o ponto seguinte).
function ProximaParte(var Texto: String): Integer;
var
  Ponto: Integer;
begin
  Ponto := Pos('.', Texto);
  if Ponto = 0 then
  begin
    Result := StrToIntDef(Texto, 0);
    Texto := '';
  end
  else
  begin
    Result := StrToIntDef(Copy(Texto, 1, Ponto - 1), 0);
    Delete(Texto, 1, Ponto);
  end;
end;

// Compara duas versões X.Y.Z: negativo, zero ou positivo (como a DisplayVersion que este instalador grava).
function CompararVersoes(A, B: String): Integer;
var
  I, ParteA, ParteB: Integer;
  RestoA, RestoB: String;
begin
  Result := 0;
  RestoA := A;
  RestoB := B;
  for I := 1 to 3 do
  begin
    ParteA := ProximaParte(RestoA);
    ParteB := ProximaParte(RestoB);
    if ParteA <> ParteB then
    begin
      if ParteA > ParteB then
        Result := 1
      else
        Result := -1;
      Exit;
    end;
  end;
end;

// Versão mais antiga por cima de uma mais nova (o Setup velho que ficou em Downloads): o PDV antigo não abre o banco que o
// novo migrou e o caixa pararia. Silencioso (/SUPPRESSMSGBOXES) responde o padrão "Não" e o instalador sai sem mudar nada.
function InitializeSetup(): Boolean;
var
  Raiz: Integer;
  Instalada, Mensagem: String;
begin
  Result := True;
  if IsWin64 then
    Raiz := HKLM64
  else
    Raiz := HKLM;
  if RegQueryStringValue(Raiz, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7125763E-1F1B-4A8F-9DE6-A27FFBE93EBB}_is1',
       'DisplayVersion', Instalada) and (CompararVersoes(Instalada, '{#VersaoApp}') > 0) then
  begin
    Mensagem := 'Este computador já tem o GenesisPDV ' + Instalada + ', mais novo que este instalador ({#VersaoApp}). ' +
      'A versão mais antiga não abre o banco do caixa que a mais nova já atualizou: o caixa ficaria parado até ' +
      'instalar de novo a ' + Instalada + '. Use o instalador GenesisPDV-Setup-' + Instalada + '.exe ou um mais novo.' +
      { Sem # no início da linha: o pré-processador (ISPP) leria como diretiva. }
      Chr(13) + Chr(10) + Chr(13) + Chr(10) + 'Instalar a {#VersaoApp} por cima mesmo assim? (só com o suporte)';
    Log('Versão instalada ' + Instalada + ' é mais nova que a {#VersaoApp} deste instalador.');
    Result := SuppressibleMsgBox(Mensagem, mbError, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES;
    if not Result then
      Log('Instalação cancelada: versão mais antiga por cima de uma mais nova.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Mensagem: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Mensagem := 'O GenesisPDV foi removido, mas os dados do caixa ficaram em ' + ExpandConstant('{#PastaDados}') +
      ' (banco, backups e logs). Reinstalando, o PDV continua de onde parou; para apagar de vez, ' +
      'confira antes no ERP que não há vendas pendentes deste caixa.';
    Log(Mensagem);
    if not UninstallSilent then
      MsgBox(Mensagem, mbInformation, MB_OK);
  end;
end;
