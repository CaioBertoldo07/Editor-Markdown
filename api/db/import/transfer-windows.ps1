<#
  Transferência Neon -> Railway a partir de um Windows (PowerShell 5.1+ e
  PostgreSQL 18 instalado). ALTERNATIVA ao job do Railway (OPS_TASK=transfer-*),
  que é o caminho recomendado por não gravar nada em disco.

  O que este script faz:
    1. cria uma pasta temporária acessível só pelo seu usuário (icacls);
    2. pede as duas URLs sem eco e sem gravar no histórico;
    3. exporta do Neon numa transação SOMENTE LEITURA;
    4. importa no Railway numa transação única (aborta se o destino não estiver vazio);
    5. compara contagens e checksums dos dois lados;
    6. apaga a pasta temporária, mesmo em caso de erro.

  Uso (na pasta api\db\import do repositório):
    powershell -ExecutionPolicy Bypass -File .\transfer-windows.ps1

  Pré-requisitos: migrations já aplicadas no Railway e proxy TCP público do
  Postgres LIGADO TEMPORARIAMENTE (desligue logo depois).
#>
[CmdletBinding()]
param(
  [string]$ScriptsDir = $PSScriptRoot,
  [string]$Psql = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Psql) {
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  $Psql = if ($cmd) { $cmd.Source } else { 'C:\Program Files\PostgreSQL\18\bin\psql.exe' }
}
if (-not (Test-Path $Psql)) { throw "psql não encontrado em $Psql" }
$version = & $Psql --version
if ($version -notmatch ' 18\.') { Write-Warning "Versão do psql: $version (recomendado 18)" }

foreach ($f in 'export-from-neon.sql', 'import-to-railway.sql', 'verify.sql') {
  if (-not (Test-Path (Join-Path $ScriptsDir $f))) { throw "Script ausente: $f" }
}

function ConvertTo-Plain([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Psql([string]$Url, [string[]]$Arguments) {
  # A URL vai por variável de ambiente (não aparece na linha de comando).
  $env:EM_PSQL_URL = $Url
  try {
    & $Psql -X -v ON_ERROR_STOP=1 -d $env:EM_PSQL_URL @Arguments
    if ($LASTEXITCODE -ne 0) { throw "psql terminou com código $LASTEXITCODE" }
  } finally {
    Remove-Item Env:\EM_PSQL_URL -ErrorAction SilentlyContinue
  }
}

# 1. Pasta temporária privada
$work = Join-Path $env:LOCALAPPDATA ('em-transfer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $work /inheritance:r /grant:r "${me}:(OI)(CI)F" | Out-Null
Write-Host "Pasta temporária (só $me tem acesso): $work"

$neonSecure = Read-Host 'URL do Neon (cole e Enter; não aparece na tela)' -AsSecureString
$railSecure = Read-Host 'URL de ADMIN do Railway, proxy público temporário (não aparece)' -AsSecureString
$env:PGCLIENTENCODING = 'UTF8'
$env:PGSSLMODE = 'require'

try {
  Push-Location $work
  $neon = ConvertTo-Plain $neonSecure
  $rail = ConvertTo-Plain $railSecure
  if ($rail -match 'neon\.tech') { throw 'A URL de destino aponta para o Neon. Abortado.' }

  Write-Host '1/4 Exportando do Neon (somente leitura)...'
  Invoke-Psql $neon @('-q', '-f', (Join-Path $ScriptsDir 'export-from-neon.sql'))
  Get-ChildItem $work -Filter *.csv | ForEach-Object { icacls $_.FullName /inheritance:r /grant:r "${me}:F" | Out-Null }

  Write-Host '2/4 Importando no Railway (uma transação)...'
  Invoke-Psql $rail @('-q', '-f', (Join-Path $ScriptsDir 'import-to-railway.sql'))

  Write-Host '3/4 Calculando checksums nos dois lados...'
  $a = Invoke-Psql $neon @('-q', '-v', 'auth_schema=neon_auth', '-v', 'app_schema=public', '-f', (Join-Path $ScriptsDir 'verify.sql'))
  $b = Invoke-Psql $rail @('-q', '-v', 'auth_schema=app_auth', '-v', 'app_schema=app', '-f', (Join-Path $ScriptsDir 'verify.sql'))

  Write-Host '4/4 Comparando...'
  $a | ForEach-Object { Write-Host "  Neon:    $($_ -replace '([0-9a-f]{8})[0-9a-f]{24}', '$1...')" }
  $b | ForEach-Object { Write-Host "  Railway: $($_ -replace '([0-9a-f]{8})[0-9a-f]{24}', '$1...')" }
  if (($a -join "`n") -ne ($b -join "`n")) { throw 'Checksums DIVERGENTES. Não use o staging; limpe o banco e repita.' }
  Write-Host 'OK: contagens e checksums idênticos.' -ForegroundColor Green
}
finally {
  Pop-Location
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  $neon = $null; $rail = $null
  Remove-Item Env:\PGCLIENTENCODING, Env:\PGSSLMODE -ErrorAction SilentlyContinue
  if (Test-Path $work) { Write-Warning "Apague manualmente: $work" } else { Write-Host 'Pasta temporária apagada.' }
  Write-Host 'Lembrete: desligue agora o proxy TCP público do Postgres no Railway.' -ForegroundColor Yellow
}
