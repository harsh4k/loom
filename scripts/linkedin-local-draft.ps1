param([switch]$DryRun, [string]$Model = 'qwen3.5:9b-q4_K_M')

$ErrorActionPreference = 'Stop'
# Personal settings come from config/profile.json (see config/profile.example.json).
$hub = Split-Path $PSScriptRoot -Parent
$profilePath = if ($env:LOOM_PROFILE) { $env:LOOM_PROFILE } else { Join-Path $hub 'config\profile.json' }
$settings = if (Test-Path -LiteralPath $profilePath -PathType Leaf) { Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$project = if ($settings.linkedin.folder) { [string]$settings.linkedin.folder } else { Join-Path $hub 'data\linkedin' }
$author = if ($settings.name) { [string]$settings.name } else { 'the author' }
$audience = if ($settings.linkedin.audience) { [string]$settings.linkedin.audience } else { 'software engineering recruiters' }
$topics = @($settings.linkedin.topics | Where-Object { $_ -and "$_".Trim() } | ForEach-Object { "$_".Trim() })
$avoid = @($settings.linkedin.avoid | Where-Object { $_ -and "$_".Trim() } | ForEach-Object { "$_".Trim() })
if (-not $topics.Count) { throw "Add linkedin.topics to $profilePath first." }
$drafts = Join-Path $project 'drafts'
$storyPath = Join-Path $project 'story-bank.md'
$today = Get-Date -Format 'yyyy-MM-dd'

if (-not (Test-Path -LiteralPath $storyPath -PathType Leaf)) { throw "Story Bank missing: $storyPath" }
if (-not (Test-Path -LiteralPath $drafts -PathType Container)) { throw "Draft folder missing: $drafts" }

$existing = @(Get-ChildItem -LiteralPath $drafts -File -Filter '*.md' | Sort-Object Name)
if (-not $DryRun -and @($existing | Where-Object Name -Like "$today-*.md").Count) {
    Write-Output "A draft already exists for $today. Skipping."
    exit 0
}

$story = Get-Content -LiteralPath $storyPath -Raw -Encoding UTF8
$knownOpeners = @()
$prior = ($existing | ForEach-Object {
    $sections = (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8) -split '(?m)^---\s*$', 2
    $opening = ($sections[-1].Trim() -split "`r?`n")[0].Trim()
    $knownOpeners += $opening
    "$($_.BaseName): $opening"
}) -join "`n"
# Rotate through topics: an unused one first, otherwise the one whose latest draft is oldest.
# Draft names start with yyyy-MM-dd, so sorting names sorts by date.
$selectedTopic = $null
$oldestUse = $null
foreach ($candidate in $topics) {
    $slugPattern = [regex]::Escape(($candidate.ToLowerInvariant() -replace '\s+', '-'))
    $projectLine = "- Project: $candidate"
    $lastUse = @($existing | Where-Object {
        $_.BaseName.ToLowerInvariant() -match $slugPattern -or (Select-String -LiteralPath $_.FullName -SimpleMatch -Pattern $projectLine -Quiet)
    } | ForEach-Object BaseName | Sort-Object) | Select-Object -Last 1
    if (-not $lastUse) { $selectedTopic = $candidate; break }
    if ($null -eq $oldestUse -or [string]::CompareOrdinal($lastUse, $oldestUse) -lt 0) { $oldestUse = $lastUse; $selectedTopic = $candidate }
}
$facts = (($story -split "`r?`n") | Where-Object { $_ -match [regex]::Escape($selectedTopic) }) -join "`n"
if (-not $facts) { throw "No Story Bank facts found for $selectedTopic" }
$repo = [regex]::Match($facts, 'github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+').Value
# Links never go in the post body (the repo link is the first comment), so the model never sees
# them and any it still writes are taken out before the checks.
$linkPattern = '(?i)\(?\b(?:https?://|www\.|github\.com/)\S+'
function Remove-Links([string]$text) {
    $clean = [regex]::Replace($text, $linkPattern, '')
    $clean = [regex]::Replace($clean, '\(\s*\)|[ \t]+(?=[.,;:!?])', '')
    return [regex]::Replace($clean, '[ \t]{2,}', ' ')
}
$factsForModel = Remove-Links $facts

$avoidRule = if ($avoid.Count) { " Never mention any of these: $($avoid -join ', ')." } else { '' }
$system = @"
You write one LinkedIn draft for $author. Return only a JSON object with string fields: topic, formula, post. Never claim the post was published or scheduled. The supplied Story Bank lines are the only source of facts. Every factual sentence must be directly supported by those lines. Never invent numbers, dates, names, outcomes, feelings, module responsibilities, latency, or first-person experiences. Local inference and zero cloud APIs do not prove that the entire app has no external connectivity. The post is published as written, so it must be complete: never use placeholders, blanks, square brackets, or notes to the author. When a personal detail is missing, leave it out and write only what the facts support. Choose a topic or angle different from the existing drafts.

The audience is $audience. Show real shipped work in a natural, simple, professional voice. Use a number-first opening only if the number is relevant to this topic and supported by the Story Bank; otherwise start with a concrete statement. Never start with a question. Keep the post concise when source facts are thin; do not pad it to a target length. Use 1-2 sentence paragraphs separated by blank lines. End with a specific technical question, not a hiring appeal, and then at most two hashtags. Never put a repository link in the post body; the runner handles the first comment. Avoid generic AI phrases, stacked three-part lists, "The result?", "Here's what", "Stop X, start Y", "proves", "robust", and excessive em dashes. Do not infer what $author thought, felt, learned or wanted; omit missing personal context. Do not inflate a technical fact into a broad claim. Do not name freelance clients or teammates. Do not include phone numbers or email addresses.$avoidRule Formula is a short hook label, not instructions or an engagement claim.
"@
$user = "Write a post ONLY about $selectedTopic, around 600-900 characters. Use only the exact facts below. Leave out any personal moment or engineering challenge the facts do not state, rather than filling with assumptions or placeholders. NEVER repeat an existing opening line. STORY BANK FACTS FOR THIS TOPIC:`n$factsForModel`n`nPAST DRAFTS AND OPENERS:`n$prior"
$issue = ''
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $body = @{
        model = $Model
        messages = @(@{role='system'; content=$system}, @{role='user'; content=($user + "`n$issue")})
        format = 'json'
        stream = $false
        think = $false
        options = @{num_ctx=8192; num_predict=1400; temperature=0.7}
    } | ConvertTo-Json -Depth 8 -Compress
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/chat' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 600
        if ($response.done_reason -ne 'stop') { throw "Model response incomplete: $($response.done_reason)" }
        $result = $response.message.content | ConvertFrom-Json
        foreach ($field in @('topic','formula','post')) {
            if (-not ($result.$field -is [string])) { throw "Model response missing $field" }
        }
        $post = (Remove-Links $result.post).Trim()
        $firstLine = ($post -split "`r?`n")[0].Trim()
        if ($post.Length -lt 250 -or $post.Length -gt 1300) { throw "Draft length $($post.Length) is outside 250-1300 characters" }
        if ($firstLine -match '\?$') { throw 'Draft opens with a question' }
        if ($post -notmatch [regex]::Escape($selectedTopic)) { throw "Draft does not focus on $selectedTopic" }
        $openerKey = $firstLine.ToLowerInvariant() -replace '[^a-z0-9]', ''
        foreach ($old in $knownOpeners) {
            if (($old.ToLowerInvariant() -replace '[^a-z0-9]', '') -eq $openerKey) { throw 'Draft reuses an existing opener' }
        }
        if ($post -match '(?i)https?://|www\.|github\.com/') { throw 'Draft body contains a link' }
        if ($post -match '[\[\]{}]|(?i)\bSLOT\b|\bTODO\b|\bTBD\b') { throw 'Draft contains a placeholder or bracket; it must be complete and publishable' }
        if ($avoid.Count -and $post -match ('(?i)' + (($avoid | ForEach-Object { [regex]::Escape($_) }) -join '|'))) { throw 'Draft contains an off-limits name' }
        if ($post -notmatch '\?\s*(?:#[\w-]+\s*){0,2}$') { throw 'Draft must end with a question and at most two hashtags' }
        $storyNumbers = $facts -replace '(?<=\d),(?=\d)', ''
        foreach ($number in [regex]::Matches($post, '\b\d[\d,]*(?:\.\d+)*\b')) {
            if (-not $storyNumbers.Contains($number.Value.Replace(',', ''))) { throw "Draft uses a number absent from the Story Bank: $($number.Value)" }
        }
        break
    } catch {
        $issue = "`nRevise your prior draft below. It failed: $($_.Exception.Message). Focus ONLY on $selectedTopic. Use only supplied facts, leave out anything not supported, use no brackets or placeholders, and keep it concise. Return all three JSON fields again.`nPRIOR DRAFT:`n$post"
        if ($attempt -eq 3) { throw "Draft failed validation after 3 attempts: $($_.Exception.Message); length=$($post.Length); opener=$firstLine" }
    }
}

$slug = ($result.topic.ToLowerInvariant() -replace '[^a-z0-9]+','-').Trim('-')
if ($slug.Length -gt 48) { $slug = $slug.Substring(0,48).Trim('-') }
if (-not $slug) { $slug = 'post' }
$target = Join-Path $drafts "$today-$slug.md"
if (Test-Path -LiteralPath $target) { throw "Draft already exists: $target" }
$title = $result.topic.Trim() -replace '[\r\n]',' '
$formula = $result.formula.Trim() -replace '[\r\n]',' '
$comment = $repo
$markdown = "# Draft: $title`n`n- Project: $selectedTopic`n- Skill: local Ollama draft`n- Formula: $formula`n- Goal: recruiter visibility`n- Status: Complete; the hub posts it to LinkedIn automatically when connected`n- Suggested window: Tue/Thu, 7:30-9:00 AM`n- First comment: $comment`n`n---`n`n$post`n"

if ($DryRun) {
    Write-Output "DRY RUN: Would write $target"
    Write-Output $markdown
} else {
    $markdown | Set-Content -LiteralPath $target -Encoding UTF8 -NoNewline
    Write-Output "Wrote draft: $target"
}
