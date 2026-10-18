param([switch]$DryRun, [string]$Model = 'qwen3.5:9b-q4_K_M', [string]$Topic = '')

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$hub = Split-Path $PSScriptRoot -Parent
$profilePath = if ($env:LOOM_PROFILE) { $env:LOOM_PROFILE } else { Join-Path $hub 'config\profile.json' }
$settings = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
$project = if ($settings.linkedin.folder) { [string]$settings.linkedin.folder } else { Join-Path $hub 'data\linkedin' }
$brandPath = if ($env:LOOM_BRAND) { $env:LOOM_BRAND } else { Join-Path $hub 'config\brand.json' }
$brand = Get-Content -LiteralPath $brandPath -Raw -Encoding UTF8 | ConvertFrom-Json
$topics = @($settings.linkedin.topics | Where-Object { $_ -and "$_".Trim() })
if (-not $topics.Count) { throw "Add linkedin.topics to the profile first." }
$drafts = Join-Path $project 'drafts'
$storyPath = if ($env:LOOM_COPY_STORY) { $env:LOOM_COPY_STORY } else { Join-Path $project 'story-bank.md' }
$today = Get-Date -Format 'yyyy-MM-dd'
if (-not (Test-Path -LiteralPath $drafts -PathType Container)) { throw 'Draft folder missing.' }
$existing = @(Get-ChildItem -LiteralPath $drafts -File -Filter '*.md' | Sort-Object Name)
if (-not $DryRun -and @($existing | Where-Object Name -Like "$today-*.md").Count) {
    Write-Output "A draft already exists for $today. Skipping."
    exit 0
}
$selectedTopic = if ($Topic) { $Topic.Trim() } else { $null }
$oldestUse = $null
foreach ($candidate in $(if ($selectedTopic) { @() } else { $topics })) {
    $slugPattern = [regex]::Escape(($candidate.ToLowerInvariant() -replace '\s+', '-'))
    $projectLine = "- Project: $candidate"
    $lastUse = @($existing | Where-Object {
        $_.BaseName.ToLowerInvariant() -match $slugPattern -or (Select-String -LiteralPath $_.FullName -SimpleMatch -Pattern $projectLine -Quiet)
    } | ForEach-Object BaseName | Sort-Object) | Select-Object -Last 1
    if (-not $lastUse) { $selectedTopic = $candidate; break }
    if ($null -eq $oldestUse -or [string]::CompareOrdinal($lastUse, $oldestUse) -lt 0) { $oldestUse = $lastUse; $selectedTopic = $candidate }
}
$history = @($existing | ForEach-Object { @{ markdown = [string](Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8) } })
$stage = Join-Path $PSScriptRoot 'copy-stage.mjs'
function Invoke-CopyStage($request) {
    $json = $request | ConvertTo-Json -Depth 20 -Compress
    $answer = $json | & node $stage
    if ($LASTEXITCODE -ne 0) { throw "Copy stage failed: $answer" }
    return ($answer | ConvertFrom-Json)
}
$prepared = Invoke-CopyStage @{ action='prepare'; topic=$selectedTopic; storyBank=[string](Get-Content -LiteralPath $storyPath -Raw -Encoding UTF8); profile=$settings; brand=$brand; history=$history }
$repo = @($prepared.records | Where-Object { $_.repo } | ForEach-Object { $_.repo }) | Select-Object -First 1
$feedback = ''
$attempts = @()
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $post = ''
    $prompt = $prepared.prompt + "`nWrite only a JSON object with string topic, formula, post. Write ONLY about $selectedTopic. $feedback"
    $body = @{ model=$Model; messages=@(@{role='system'; content=$prepared.system}, @{role='user'; content=$prompt}); format='json'; stream=$false; think=$false; options=@{num_ctx=8192;num_predict=1400;temperature=0.7} } | ConvertTo-Json -Depth 12 -Compress
    $raw = $null
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/chat' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 600
        $raw = $response.message.content
        if ($response.done_reason -ne 'stop') { throw "Model response incomplete: $($response.done_reason)" }
        $result = $raw | ConvertFrom-Json
        foreach ($field in @('topic','formula','post')) { if (-not ($result.$field -is [string])) { throw "Model response missing $field" } }
        $post = $result.post.Trim()
        $checked = Invoke-CopyStage @{ action='validate'; post=$post; topic=$selectedTopic; records=@($prepared.records); history=@($prepared.history); brand=$brand; avoid=@($settings.linkedin.avoid); topics=@($settings.linkedin.topics) }
        if (-not $checked.valid) { throw ($checked.errors -join '; ') }
        $attempts += @{ attempt=$attempt; prompt=$prompt; raw=$raw; errors=@() }
        break
    } catch {
        $message = $_.Exception.Message
        $attempts += @{ attempt=$attempt; prompt=$prompt; raw=$raw; errors=@($message) }
        # Supply the failing rule, never repeat the rejected wording as an anchor.
        $feedback = "Choose a fresh approach and correct these failures: $message"
        if ($attempt -eq 3) {
            if ($env:LOOM_COPY_ATTEMPTS) { ConvertTo-Json -InputObject @($attempts) -Depth 20 | Set-Content -LiteralPath $env:LOOM_COPY_ATTEMPTS -Encoding UTF8 }
            throw "Draft failed validation after 3 attempts: $message"
        }
    }
}
if ($env:LOOM_COPY_ATTEMPTS) { ConvertTo-Json -InputObject @($attempts) -Depth 20 | Set-Content -LiteralPath $env:LOOM_COPY_ATTEMPTS -Encoding UTF8 }
$slug = ($result.topic.ToLowerInvariant() -replace '[^a-z0-9]+','-').Trim('-')
if ($slug.Length -gt 48) { $slug = $slug.Substring(0,48).Trim('-') }
if (-not $slug) { $slug = 'post' }
$target = Join-Path $drafts "$today-$slug.md"
if (Test-Path -LiteralPath $target) { throw "Draft already exists: $target" }
$title = $result.topic.Trim() -replace '[\r\n]',' '
$formula = $result.formula.Trim() -replace '[\r\n]',' '
$markdown = "# Draft: $title`n`n- Project: $selectedTopic`n- Skill: local Ollama draft`n- Formula: $formula`n- Goal: recruiter visibility`n- Status: Complete; Loom posts it to LinkedIn after you approve it`n- First comment: $repo`n`n---`n`n$post`n"
if ($DryRun) { Write-Output "DRY RUN: Would write $target"; Write-Output $markdown }
else { $markdown | Set-Content -LiteralPath $target -Encoding UTF8 -NoNewline; Write-Output "Wrote draft: $target" }
