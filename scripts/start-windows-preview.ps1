param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$preview = Join-Path $root '.cache/local-preview'
$node = (Get-Command node).Source
$site = 'http://localhost:3000'

function Get-Listener([int]$Port) {
  Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}

function Wait-Listener([int]$Port, [Diagnostics.Process]$Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(35)
  do {
    if ($Process.HasExited) { throw "A preview service exited while starting on port $Port. See logs in $preview." }
    $listener = Get-Listener $Port
    if ($listener) { return $listener }
    Start-Sleep -Milliseconds 350
  } until ([DateTime]::UtcNow -ge $deadline)
  throw "Preview port $Port did not become ready. See logs in $preview."
}

function Start-PreviewProcess($Name, $File, $Arguments, $Directory) {
  Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $preview "$Name-start.out") `
    -RedirectStandardError (Join-Path $preview "$Name-start.err")
}

foreach ($required in @(
  '.env', 'apps/api/dist/main.js', 'apps/web/.next/BUILD_ID',
  '.cache/local-preview/postgres.mjs', '.cache/local-preview/database-demo'
)) {
  if (!(Test-Path -LiteralPath (Join-Path $root $required))) { throw "The prepared RAUI preview is missing $required." }
}

$db = Get-Listener 5432
if (!$db) {
  $process = Start-PreviewProcess 'postgres' $node '.cache/local-preview/postgres.mjs' $root
  $db = Wait-Listener 5432 $process
  if ($db.OwningProcess -ne $process.Id) { throw 'Unexpected process on the preview database port.' }
  $process.Id | Set-Content -LiteralPath (Join-Path $preview 'postgres-demo.pid')
}
if ($db.OwningProcess -ne [int](Get-Content -LiteralPath (Join-Path $preview 'postgres-demo.pid'))) {
  throw 'Another database is using the RAUI preview port.'
}

if (!(Get-Listener 6379)) {
  $redis = Get-ChildItem -LiteralPath (Join-Path $preview 'redis') -Filter redis-server.exe -Recurse |
    Select-Object -First 1
  if (!$redis) { throw 'The prepared Redis executable is missing.' }
  $process = Start-PreviewProcess 'redis' $redis.FullName @('--bind','127.0.0.1','--port','6379','--appendonly','no','--save','""') $redis.DirectoryName
  $null = Wait-Listener 6379 $process
}

if (!(Get-Listener 9200)) {
  $searchDir = Join-Path $preview 'opensearch-3.3.2'
  $priorOptions = $env:OPENSEARCH_JAVA_OPTS
  $priorDemo = $env:DISABLE_INSTALL_DEMO_CONFIG
  try {
    $env:OPENSEARCH_JAVA_OPTS = '-Xms512m -Xmx512m -Djdk.net.unixdomain.tmpdir=C:\__raui_no_unix_pipe__'
    $env:DISABLE_INSTALL_DEMO_CONFIG = 'true'
    $process = Start-PreviewProcess 'opensearch' (Get-Command cmd.exe).Source @('/d','/c','bin\opensearch.bat','-s') $searchDir
  } finally {
    $env:OPENSEARCH_JAVA_OPTS = $priorOptions
    $env:DISABLE_INSTALL_DEMO_CONFIG = $priorDemo
  }
  $null = Wait-Listener 9200 $process
}
$search = Invoke-RestMethod 'http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=10s' -TimeoutSec 14
if ($search.cluster_name -ne 'raui-local-preview' -or $search.timed_out) { throw 'The RAUI preview search cluster is unavailable.' }

if (!(Get-Listener 3001)) {
  $process = Start-PreviewProcess 'api' $node @('--env-file=../../.env','dist/main.js') (Join-Path $root 'apps/api')
  $null = Wait-Listener 3001 $process
}
if (!(Get-Listener 3000)) {
  $process = Start-PreviewProcess 'web' $node @('node_modules/next/dist/bin/next','start','--hostname','127.0.0.1') (Join-Path $root 'apps/web')
  $null = Wait-Listener 3000 $process
}

$null = Invoke-RestMethod 'http://127.0.0.1:3001/health/ready' -TimeoutSec 8
$index = Invoke-RestMethod 'http://127.0.0.1:9200/raui-listings/_count' -TimeoutSec 8
$homePage = Invoke-WebRequest $site -TimeoutSec 8
if ($homePage.Content -notmatch 'raui-logo' -or $index.count -lt 1) {
  throw 'The preview homepage or listing index could not be verified.'
}
Write-Output "RAUI.RU: $site — $($index.count) indexed listings"
if (!$NoBrowser) { Start-Process $site }
