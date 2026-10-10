# Resolve-adb.ps1 — find adb the same way the build does.
#
# These collection scripts used to hardcode
# `E:\code\Eng\.android-sdk\platform-tools\adb.exe`, so on any other machine they failed at
# the first line with "找不到 adb" -- and that path is one specific developer's checkout, not
# part of this repository.
#
# `eng/toolchain.cjs` already resolves the SDK from an explicit argument, then environment
# variables, then a toolchain beside the repository, then the usual install locations. Using it
# here means adb is looked for in exactly one place for the whole repo, including the build.
#
# Dot-source it and let it fill in $Adb:
#
#     . (Join-Path $PSScriptRoot 'Resolve-adb.ps1')
#     Resolve-Adb -Explicit $Adb
#
# `-Explicit` is whatever the caller's own -Adb parameter holds, so an operator can still point
# at a device's adb by hand; empty means "work it out".

function Resolve-Adb {
    param(
        # Value of the caller's -Adb parameter. Empty means "look it up".
        [string]$Explicit
    )

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "找不到 adb（-Adb 指定的路径不存在）: $Explicit" }
        return $Explicit
    }

    # Prefer the shared resolver. It prints JSON on success and a list of the places it tried
    # on failure, which is more useful than a bare "not found".
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $resolver = Join-Path $repoRoot "eng/toolchain.cjs"
    $node = Get-Command node -ErrorAction SilentlyContinue

    if ($node -and (Test-Path $resolver)) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $json = & $node.Source $resolver "print" 2>$null
            if ($LASTEXITCODE -eq 0 -and $json) {
                $resolved = ($json | Out-String | ConvertFrom-Json)
                if ($resolved.adb -and (Test-Path $resolved.adb)) { return $resolved.adb }
            }
        } catch {
            # Fall through to the plain lookup below; the resolver's own message is printed
            # again there if nothing is found.
        } finally {
            $ErrorActionPreference = $previous
        }
    }

    # Last resort: whatever adb is on PATH. A machine with the platform tools installed and
    # nothing configured usually has this.
    $onPath = Get-Command adb -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw @"
找不到 adb。按顺序试过：
  1. -Adb <路径>（本次未指定）
  2. eng/toolchain.cjs（显式参数 → 环境变量 → 仓库旁 .toolchain/ → 常见安装位置）
  3. PATH 上的 adb

修法（任选其一）：
  - 指定路径：      -Adb "D:\path\to\platform-tools\adb.exe"
  - 装好工具链：    pwsh -File eng/setup-toolchain.ps1
  - 设环境变量：    `$env:ANDROID_HOME = "<sdk 路径>"   # 需含 platform-tools\adb.exe
"@
}
