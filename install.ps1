#!/usr/bin/env pwsh
# ============================================================================
# DSH 本机架构一键恢复脚本（换机 / 迁移用）
# 从 dsh-config 仓库恢复：全局指令、配置、web profile、dsh-skill-studio 修复版，
# 并批量 clone 全部 22 个 skill 到 ~/.dsh/skills/。
#
# 用法（在 dsh-config 仓库根目录运行）：
#   pwsh install.ps1                     # 恢复配置 + 全部 skill（默认 GitHub 源）
#   pwsh install.ps1 -Source gitee       # 用 Gitee 源（国内直连更快）
#   pwsh install.ps1 -SkipSkills         # 只恢复配置，不装 skill
#   pwsh install.ps1 -SkipConfig         # 只装 skill，不覆盖配置
#
# 幂等：已存在的 skill 目录会被跳过（不会覆盖你已修改的内容）。
# 安全：恢复配置前会先备份到 ~/.dsh/_backup_<时间戳>/。
# ============================================================================

param(
  [ValidateSet('github', 'gitee')]
  [string]$Source = 'github',
  [switch]$SkipSkills,
  [switch]$SkipConfig
)

$ErrorActionPreference = 'Continue'
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$owner = 'hpsks416'

$skills = @(
  'acp-studio',
  'agent-workflow-orchestration',
  'agents-md-skill-layering',
  'browser-viz-local-scripts',
  'dsh-plugin-lazy-adapter-resolution',
  'github-ready-packager',
  'hatch-pet',
  'homophone-pun-analysis',
  'hpsks416',
  'long-sentence-structurizer',
  'migrate-conversation-prompt',
  'open-source-scout',
  'resume-conversation-brief',
  'resume-conversation-full',
  'rust-refactor-local-projects',
  'secret-scan',
  'secure-push-workflow',
  'skill-evaluator',
  'skill-lifecycle-manager',
  'skill-optimizer',
  'web-3d-asset-pipeline',
  'windows-node-spawn-cli'
)

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $dshHome "_backup_$ts"

function Backup-And-Restore-File {
  param([string]$Src, [string]$Dst)
  if (Test-Path $Dst) {
    $rel = $Dst.Replace($dshHome + '\', '')
    $bak = Join-Path $backupRoot $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null
    Copy-Item $Dst $bak -Force
    Write-Host "    备份旧文件 -> ~/.dsh/_backup_$ts\$rel" -ForegroundColor DarkGray
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $Dst) | Out-Null
  Copy-Item $Src $Dst -Force
  Write-Host "    恢复 ~/.dsh/$($Dst.Replace($dshHome + '\', ''))" -ForegroundColor Green
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' DSH 本机架构一键恢复' -ForegroundColor Cyan
Write-Host " 脚本目录: $scriptRoot" -ForegroundColor DarkGray
Write-Host " 目标目录: $dshHome" -ForegroundColor DarkGray
Write-Host " skill 源: $Source" -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

# ---- 1. 恢复配置 ---------------------------------------------------------
if (-not $SkipConfig) {
  Write-Host '[1/3] 恢复配置' -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $dshHome | Out-Null

  Backup-And-Restore-File (Join-Path $scriptRoot 'AGENTS.md') (Join-Path $dshHome 'AGENTS.md')
  Backup-And-Restore-File (Join-Path $scriptRoot 'settings.yaml') (Join-Path $dshHome 'settings.yaml')
  Backup-And-Restore-File (Join-Path $scriptRoot 'profile-web\cordis.patch.yml') (Join-Path $dshHome 'profiles\web\cordis.patch.yml')
  Backup-And-Restore-File (Join-Path $scriptRoot 'profile-web\cordis.yml') (Join-Path $dshHome 'profiles\web\cordis.yml')
  Backup-And-Restore-File (Join-Path $scriptRoot 'profile-web\pnpm-workspace.yaml') (Join-Path $dshHome 'profiles\web\pnpm-workspace.yaml')

  # package.json：先复制，再重接 dsh-skill-studio 的 link 到稳定路径
  Backup-And-Restore-File (Join-Path $scriptRoot 'profile-web\package.json') (Join-Path $dshHome 'profiles\web\package.json')

  # dsh-skill-studio-patched：复制到 ~/.dsh/ 下稳定路径（不依赖仓库 clone 位置）
  $patchedDst = Join-Path $dshHome 'dsh-skill-studio-patched'
  if (Test-Path $patchedDst) {
    $bak = Join-Path $backupRoot 'dsh-skill-studio-patched'
    New-Item -ItemType Directory -Force -Path $bak | Out-Null
    Copy-Item $patchedDst $bak -Recurse -Force
    Write-Host '    备份旧 dsh-skill-studio-patched' -ForegroundColor DarkGray
  }
  Copy-Item (Join-Path $scriptRoot 'dsh-skill-studio-patched') $patchedDst -Recurse -Force
  Write-Host '    恢复 ~/.dsh/dsh-skill-studio-patched' -ForegroundColor Green

  # 重接 link：把 link:G:/... 换成 link:<home 前斜杠>/.dsh/dsh-skill-studio-patched
  $pkgPath = Join-Path $dshHome 'profiles\web\package.json'
  $fsHome = $env:USERPROFILE.Replace('\', '/')
  $pkgText = Get-Content $pkgPath -Raw
  $pkgText = $pkgText -replace '"dsh-skill-studio"\s*:\s*"link:[^"]*"', "`"dsh-skill-studio`": `"link:$fsHome/.dsh/dsh-skill-studio-patched`""
  Set-Content -Path $pkgPath -Value $pkgText -Encoding utf8
  Write-Host '    重接 package.json 的 dsh-skill-studio link' -ForegroundColor Green

  # 检测其它 link: 依赖（未打包，需手动恢复）
  $otherLinks = [regex]::Matches($pkgText, '"([^"]+)"\s*:\s*"link:[^"]*"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne 'dsh-skill-studio' }
  if ($otherLinks) {
    Write-Host ''
    Write-Host '  ⚠ 以下依赖仍是本地 link、且未包含在本仓库中，需手动恢复：' -ForegroundColor Magenta
    foreach ($l in $otherLinks) { Write-Host "     - $l" -ForegroundColor Magenta }
  }
} else {
  Write-Host '[1/3] 跳过配置恢复（-SkipConfig）' -ForegroundColor DarkGray
}

# ---- 2. 安装 skill -------------------------------------------------------
if (-not $SkipSkills) {
  Write-Host ''
  Write-Host '[2/3] 安装 22 个 skill' -ForegroundColor Yellow
  $skillsDir = Join-Path $dshHome 'skills'
  New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null

  $okCount = 0; $skipCount = 0; $failCount = 0
  foreach ($s in $skills) {
    $dst = Join-Path $skillsDir $s
    if (Test-Path (Join-Path $dst 'SKILL.md')) {
      Write-Host "    [已存在] $s" -ForegroundColor DarkGray
      $skipCount++
      continue
    }
    if ($Source -eq 'github') { $url = "https://github.com/$owner/$s.git" }
    else { $url = "https://gitee.com/$owner/$s.git" }
    git clone --depth 1 $url $dst 2>&1 | Out-Null
    if (Test-Path (Join-Path $dst 'SKILL.md')) {
      Write-Host "    [OK] $s" -ForegroundColor Green
      $okCount++
    } else {
      Write-Host "    [FAIL] $s" -ForegroundColor Red
      $failCount++
    }
  }
  Write-Host "  结果: 安装 $okCount / 已存在 $skipCount / 失败 $failCount" -ForegroundColor Cyan
} else {
  Write-Host ''
  Write-Host '[2/3] 跳过 skill 安装（-SkipSkills）' -ForegroundColor DarkGray
}

# ---- 3. 收尾提醒 ---------------------------------------------------------
Write-Host ''
Write-Host '[3/3] 需要你手动补齐的密钥（本仓库不含任何密钥）' -ForegroundColor Yellow
Write-Host '  1. 环境变量（settings.yaml 引用，无明文）：' -ForegroundColor White
Write-Host '       COMMANDCODE_API_KEY  DEEPSEEK_API_KEY' -ForegroundColor White
Write-Host '  2. ~/.dsh/.credentials.yaml        —— DSH 凭据' -ForegroundColor White
Write-Host '  3. ~/.dsh/dsh-skill-studio/extractor.json —— 提取器 LLM 配置' -ForegroundColor White
Write-Host '  4. secrets.cmd（推送 GitHub/Gitee 用，若需双推）' -ForegroundColor White
Write-Host ''
Write-Host '恢复完成后：' -ForegroundColor Yellow
Write-Host '  cd ~/.dsh/profiles/web  &&  pnpm install  &&  重启 DSH' -ForegroundColor White
Write-Host ''

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' 完成。备份目录: ~/.dsh/_backup_$ts/（如有）' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
