$Output = "API_merged_shiftly_code.txt"

# Files / folders to exclude
$ExcludePaths = @(
    ".git",
    ".gitignore",
    "package-lock.json",
    "API_merged_shiftly_code.txt"
)

Write-Host "Merging all project files into $Output ..."
Write-Host "Excluded:"
$ExcludePaths | ForEach-Object { Write-Host " - $_" }
Write-Host ""

# Clear output file
if (Test-Path $Output) {
    Remove-Item $Output
}

# Get all files recursively
Get-ChildItem -Path . -Recurse -File | Sort-Object FullName | ForEach-Object {

    $RelativePath = $_.FullName.Replace((Get-Location).Path + "\", "")

    # Skip excluded paths
    foreach ($Exclude in $ExcludePaths) {
        if ($RelativePath -like "$Exclude*" -or $RelativePath -eq $Exclude) {
            return
        }
    }

    # Write file header
    Add-Content $Output "===== $RelativePath ====="

    # Write file content
    Get-Content $_.FullName | Add-Content $Output

    # Spacer
    Add-Content $Output "`n`n"
}

Write-Host "Done! File created: $Output"
