# File: print-tree.ps1
# Prints a proper depth-first tree (folder then its children), excluding .git

$root = (Get-Location).Path          # uses current folder
$excludeNames = @(".git")            # exclude only .git

function Get-SortedChildren {
    param([Parameter(Mandatory)][string]$Path)

    $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)

    # Exclude by name
    $items = @($items | Where-Object { $excludeNames -notcontains $_.Name })

    # Dirs first, then files, both sorted by name
    $dirs  = @($items | Where-Object { $_.PSIsContainer }      | Sort-Object Name)
    $files = @($items | Where-Object { -not $_.PSIsContainer } | Sort-Object Name)

    return @($dirs + $files)
}

function Print-Tree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Prefix = ""          # <-- default allows empty
    )

    $children = @(Get-SortedChildren -Path $Path)

    for ($i = 0; $i -lt $children.Count; $i++) {
        $child  = $children[$i]
        $isLast = ($i -eq $children.Count - 1)

        $branch = if ($isLast) { "└── " } else { "├── " }
        Write-Output ("{0}{1}{2}" -f $Prefix, $branch, $child.Name)

        if ($child.PSIsContainer) {
            $nextPrefix = if ($isLast) { $Prefix + "    " } else { $Prefix + "│   " }
            Print-Tree -Path $child.FullName -Prefix $nextPrefix
        }
    }
}

$rootName = Split-Path -Leaf $root
Write-Output $rootName

# Call without passing Prefix at all (uses default "")
Print-Tree -Path $root
