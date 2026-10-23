[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [string]$PythonPath,
    [switch]$Multiline,
    [ValidateRange(1, 65535)][int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$bridgePythonArguments = @()
if ($PythonPath) {
    $bridgePython = (Resolve-Path -LiteralPath $PythonPath -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $bridgePython -PathType Leaf)) { throw 'PythonPath must name a Python executable.' }
} else {
    $bridgePythonCommand = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bridgePythonCommand) {
        $bridgePython = $bridgePythonCommand.Source
        $bridgePythonArguments = @('-3')
    } else {
        $bridgePythonCommand = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $bridgePython = $bridgePythonCommand.Source
    }
}
$bridgeTextPath = (Resolve-Path -LiteralPath $TextFile -ErrorAction Stop).Path
$bridgeRuntimePath = Join-Path $bridgeRoot 'runtime'
$bridgePacketPath = Join-Path $bridgeRuntimePath 'packet.json'
$bridgeConnectionPath = Join-Path $bridgeRuntimePath 'connection.json'
$bridgeCliPath = Join-Path $bridgeRoot 'cli/vnc_paste_bridge.py'
$bridgePackArguments = $bridgePythonArguments + @('-B', $bridgeCliPath, 'pack', $bridgeTextPath, '--out', $bridgePacketPath)
if ($Multiline) { $bridgePackArguments += '--multiline' }
& $bridgePython @bridgePackArguments
if ($LASTEXITCODE -ne 0) { throw 'Пакет не подготовлен. API не запущен.' }
Write-Host 'Импортируйте runtime/connection.json в панель расширения. Передача запускается кнопкой в панели.'
$bridgeServeArguments = $bridgePythonArguments + @('-B', $bridgeCliPath, 'serve', '--packet', $bridgePacketPath, '--connection', $bridgeConnectionPath, '--port', $Port)
& $bridgePython @bridgeServeArguments
if ($LASTEXITCODE -ne 0) { throw 'Локальный API остановился с ошибкой.' }
