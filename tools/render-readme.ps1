# Build standalone bilingual previews from the actual Markdown. PowerShell 7.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$utf8 = [Text.UTF8Encoding]::new($false)
$pages = @(
    @{ Source = 'README.md'; Output = 'README-preview.html'; Lang = 'zh-CN'; Guide = $false },
    @{ Source = 'README.en.md'; Output = 'README-en-preview.html'; Lang = 'en'; Guide = $false },
    @{ Source = 'docs/USAGE.md'; Output = 'USAGE-preview.html'; Lang = 'zh-CN'; Guide = $true },
    @{ Source = 'docs/USAGE.en.md'; Output = 'USAGE-en-preview.html'; Lang = 'en'; Guide = $true }
)
$destinations = @{}
foreach ($page in $pages) { $destinations[[IO.Path]::GetFullPath((Join-Path $project $page.Source))] = $page.Output }
$style = @'
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:#222;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.topbar{max-width:1000px;margin:auto;padding:26px 38px 16px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:2px solid #222}
.wordmark{font-size:18px;font-weight:750;letter-spacing:1px;color:#111;text-decoration:none}.local{font:11px/1.4 Consolas,monospace;color:#666;text-align:right}
.shell{max-width:1000px;margin:auto}.filebar{padding:17px 38px;display:flex;align-items:center;flex-wrap:wrap;gap:22px;font-size:13px;border-bottom:1px solid #ddd}
.filebar a{color:#666;text-decoration:none}.filebar a:hover{color:#111;text-decoration:underline}.filebar .selected{color:#111;font-weight:700}.filebar .language{margin-left:auto;display:flex;gap:14px}.filebar .language [aria-current]{border-bottom:2px solid #222;color:#111;font-weight:700}
.markdown-body{padding:28px 38px 40px;overflow-wrap:break-word}.markdown-body>:first-child{margin-top:0}.markdown-body h1,.markdown-body h2,.markdown-body h3{font-weight:650;line-height:1.35;scroll-margin-top:22px}.markdown-body h1{font-size:32px;margin:0 0 16px;letter-spacing:-.7px}.markdown-body h2{font-size:23px;margin:38px 0 18px;padding-bottom:9px;border-bottom:1px solid #222}.markdown-body h3{font-size:19px;margin:30px 0 14px}
.markdown-body p,.markdown-body ul,.markdown-body ol,.markdown-body table,.markdown-body blockquote,.markdown-body pre{margin:0 0 19px}.markdown-body img{display:block;width:100%;height:auto;margin:26px auto 28px}.markdown-body img[alt^="纸间阅读界面"],.markdown-body img[alt^="Zhijian reader"]{border:1px solid #bbb}
.markdown-body em{font-size:14px;color:#666}.markdown-body strong{font-weight:650}a{color:#222;text-underline-offset:4px;text-decoration-thickness:1px}a:hover{color:#555}.markdown-body blockquote{padding:2px 20px;border-left:2px solid #333;color:#555}.markdown-body blockquote p:last-child{margin-bottom:0}.markdown-body ul,.markdown-body ol{padding-left:25px}.markdown-body li+li{margin-top:8px}
.markdown-body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;font-size:15px}.markdown-body th,.markdown-body td{padding:11px 15px;border-bottom:1px solid #ddd;text-align:left}.markdown-body th{border-top:1px solid #222;border-bottom:1px solid #222;font-weight:650}.markdown-body td:first-child{min-width:172px}
.markdown-body code{background:#f3f3f3;padding:.14em .3em;font: .87em Consolas,monospace}.markdown-body pre{padding:18px;background:#f5f5f5;overflow:auto;line-height:1.6}.markdown-body pre code{padding:0;background:none}.markdown-body hr{border:0;border-top:1px solid #222;margin:34px 0}footer{max-width:924px;margin:0 auto;padding:22px 0 34px;border-top:1px solid #ddd;color:#777;font-size:12px}
@media(max-width:650px){.topbar{padding:18px 20px 14px}.wordmark{font-size:16px}.local{font-size:10px}.filebar{padding:14px 20px;gap:16px}.filebar .download{display:none}.markdown-body{padding:24px 20px;font-size:15px}.markdown-body h1{font-size:28px}.markdown-body h2{font-size:21px}.markdown-body td:first-child{min-width:122px}.markdown-body img{margin:22px auto}footer{margin:0 20px}}
@media print{.topbar,.filebar,footer{display:none}.markdown-body{padding:0}}
'@

foreach ($page in $pages) {
    $source = Join-Path $project $page.Source
    $sourceDir = Split-Path -Parent $source
    $isEn = $page.Lang -eq 'en'
    $content = (ConvertFrom-Markdown -Path $source).Html
    $content = [regex]::Replace($content, '<h([1-6]) id="[^"]*">(.*?)</h\1>', {
        param($m)
        $label = [Net.WebUtility]::HtmlDecode([regex]::Replace($m.Groups[2].Value, '<[^>]+>', ''))
        $slug = [regex]::Replace($label.ToLowerInvariant(), '[^\p{L}\p{M}\p{N}\p{Pc}\- ]', '').Replace(' ', '-')
        '<h' + $m.Groups[1].Value + ' id="' + $slug + '">' + $m.Groups[2].Value + '</h' + $m.Groups[1].Value + '>'
    })
    $content = [regex]::Replace($content, 'src="([^"]+)"', {
        param($m)
        $asset = Join-Path $sourceDir ([Uri]::UnescapeDataString($m.Groups[1].Value))
        if (!(Test-Path -LiteralPath $asset)) { throw "Missing image: $asset" }
        $mime = switch ([IO.Path]::GetExtension($asset)) { '.svg' {'image/svg+xml'} '.jpg' {'image/jpeg'} default {'image/png'} }
        'src="data:' + $mime + ';base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($asset)) + '"'
    })
    $content = [regex]::Replace($content, 'href="([^"]+\.md)"', {
        param($m)
        $target = [IO.Path]::GetFullPath((Join-Path $sourceDir ([Uri]::UnescapeDataString($m.Groups[1].Value))))
        if (!$destinations.ContainsKey($target)) { throw "Missing document: $target" }
        'href="' + $destinations[$target] + '"'
    })
    foreach ($m in [regex]::Matches($content, 'href="#([^"]+)"')) {
        $anchor = [Uri]::UnescapeDataString($m.Groups[1].Value)
        if (!$content.Contains('id="' + $anchor + '"')) { throw "Missing anchor: $anchor" }
    }
    $sourceName = Split-Path -Leaf $source
    $source64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($source))
    $title = if ($page.Guide) {
        if ($isEn) { 'Zhijian · User guide' } else { '纸间 · 使用指南' }
    } else {
        if ($isEn) { 'Zhijian · README preview' } else { '纸间 · 首页预览' }
    }
    $status = if ($isEn) { 'LOCAL PREVIEW<br>NOT PUBLISHED' } else { '本地预览<br>尚未发布' }
    $guideLabel = if ($isEn) { 'User guide' } else { '使用指南' }
    $download = if ($isEn) { 'Download Markdown ↓' } else { '下载 Markdown ↓' }
    $footer = if ($isEn) { "Rendered from $sourceName. Images are embedded for offline viewing." } else { "由 $sourceName 直接渲染。图片已内嵌，可离线打开。" }
    $readmeLink = if ($isEn) { 'README-en-preview.html' } else { 'README-preview.html' }
    $guideLink = if ($isEn) { 'USAGE-en-preview.html' } else { 'USAGE-preview.html' }
    $zhLink = if ($page.Guide) { 'USAGE-preview.html' } else { 'README-preview.html' }
    $enLink = if ($page.Guide) { 'USAGE-en-preview.html' } else { 'README-en-preview.html' }
    $zhSelected = if ($isEn) { '' } else { 'aria-current="page"' }
    $enSelected = if ($isEn) { 'aria-current="page"' } else { '' }
    $readmeClass = if ($page.Guide) { '' } else { 'selected' }
    $guideClass = if ($page.Guide) { 'selected' } else { '' }
    $html = @"
<!doctype html><html lang="$($page.Lang)"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>$title</title><style>$style</style></head>
<body><header class="topbar"><a class="wordmark" href="$readmeLink">纸间 / ZHIJIAN</a><div class="local">$status</div></header>
<main class="shell"><nav class="filebar" aria-label="Documents"><a class="$readmeClass" href="$readmeLink">README</a><a class="$guideClass" href="$guideLink">$guideLabel</a><a class="download" download="$sourceName" href="data:text/markdown;charset=utf-8;base64,$source64">$download</a><span class="language"><a href="$zhLink" lang="zh-CN" $zhSelected>中文</a><a href="$enLink" lang="en" $enSelected>English</a></span></nav><article class="markdown-body">$content</article></main><footer>$footer</footer></body></html>
"@
    $output = Join-Path $project ('docs/' + $page.Output)
    [IO.File]::WriteAllText($output, $html, $utf8)
    Write-Output "Rendered $output"
}
