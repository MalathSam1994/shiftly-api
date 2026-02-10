# find-keyword.ps1
# Searches for a user-provided keyword in all files under the current folder (recursively).

$keyword = Read-Host "Enter keyword to search for"

if ([string]::IsNullOrWhiteSpace($keyword)) {
  Write-Host "No keyword entered. Exiting."
  exit 1
}

Write-Host "Searching for '$keyword' under: $(Get-Location)`n"

Get-ChildItem -Path . -Recurse -File -Force -ErrorAction SilentlyContinue |
  Select-String -Pattern $keyword -SimpleMatch -List:$false |
  ForEach-Object {
    # Output similar to grep: file:line: text
    "{0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.TrimEnd()
  }
