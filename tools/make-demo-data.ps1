# Génère docs/demo-items.json : un jeu de données 100 % SYNTHÉTIQUE (aucune vraie annonce, aucun vrai vendeur).
# Sert aux captures d'écran du README et au mode démo du dashboard (voir README, section "Développement").
# Usage : powershell -File tools/make-demo-data.ps1
param([string]$Out = "$PSScriptRoot\..\docs\demo-items.json")

$rnd = New-Object System.Random 42   # graine fixe : résultat reproductible
$pick = { param($a) $a[$rnd.Next($a.Count)] }

function Placeholder($hue, $label) {
  $svg = "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='96'><rect width='80' height='96' fill='hsl($hue,45%,72%)'/><text x='40' y='54' font-size='30' text-anchor='middle' fill='white' font-family='sans-serif'>$label</text></svg>"
  'data:image/svg+xml,' + [Uri]::EscapeDataString($svg)
}

$catalog = @(
  @{ t = 'Veste en jean';        b = 'Marque A'; p = @(8, 35) },   @{ t = 'Robe d''été fleurie';  b = 'Marque B'; p = @(6, 28) },
  @{ t = 'Baskets running';      b = 'Marque C'; p = @(12, 60) },  @{ t = 'Sac à main cuir';      b = 'Marque D'; p = @(15, 90) },
  @{ t = 'Casque audio';         b = 'Marque E'; p = @(10, 80) },  @{ t = 'Console de jeux';      b = 'Marque F'; p = @(40, 250) },
  @{ t = 'Lampe de chevet';      b = 'Marque G'; p = @(5, 25) },   @{ t = 'Manteau d''hiver';     b = 'Marque H'; p = @(18, 85) },
  @{ t = 'Montre connectée';     b = 'Marque I'; p = @(20, 120) }, @{ t = 'Puzzle 1000 pièces';   b = 'Marque J'; p = @(3, 14) }
)
$states = @('Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant')
$items = New-Object System.Collections.Generic.List[object]
$id = 9000000

# Vendeurs "ordinaires" : 1 à 3 annonces variées
for ($s = 0; $s -lt 330; $s++) {
  $owner = [string](20000000 + $rnd.Next(0, 900000000))
  $n = 1 + $rnd.Next(0, 3)
  for ($k = 0; $k -lt $n; $k++) {
    $c = & $pick $catalog
    $price = [math]::Round($c.p[0] + $rnd.NextDouble() * ($c.p[1] - $c.p[0]), 0)
    $likes = if ($rnd.NextDouble() -lt 0.55) { 0 } else { [int][math]::Floor([math]::Pow($rnd.NextDouble(), 3) * 30) }
    $id++
    $items.Add([ordered]@{ id = "$id"; t = "$($c.t) $($rnd.Next(1,999))"; u = "/items/$id"; f = $likes; p = $price; tp = [math]::Round($price * 1.07 + 0.7, 2)
      o = $owner; biz = $false; pr = $false; th = (Placeholder $rnd.Next(0,360) 'IMG'); pk = "demo$id"; b = $c.b; st = (& $pick $states); sz = ''; d = $false; bd = ''; ex = ''; sc = 0.5 })
  }
}

# Vendeurs fictifs au profil "revendeur" : même produit décliné, même prix, comptes récents
$colors = @('noir', 'blanc', 'rose', 'bleu marine', 'vert', 'beige', 'gris', 'rouge')
for ($s = 0; $s -lt 7; $s++) {
  $owner = [string](3100000000 + 1000 * ($s + 1) + $rnd.Next(0, 999))
  $product = @('Coque de téléphone modèle X', 'Bracelet silicone montre', 'Chargeur sans fil rapide', 'Étui compatible tablette', 'Housse de coussin velours', 'Lampe LED connectée', 'Écouteurs sans fil mini')[$s]
  $price = @(9, 5, 12, 14, 7, 16, 11)[$s]
  $n = 4 + $rnd.Next(0, 5)
  for ($k = 0; $k -lt $n; $k++) {
    $id++
    $items.Add([ordered]@{ id = "$id"; t = "$product couleur $($colors[$k % $colors.Count])"; u = "/items/$id"; f = $rnd.Next(0, 3); p = $price; tp = [math]::Round($price * 1.07 + 0.7, 2)
      o = $owner; biz = ($s % 2 -eq 0); pr = $false; th = (Placeholder (20 + $s * 40) 'IMG'); pk = "demo$id"; b = 'Sans marque'; st = 'Neuf sans étiquette'; sz = ''; d = $false; bd = ''; ex = ''; sc = 0.3 })
  }
}

# Quelques annonces très likées, pour que les graphiques et le filtre par likes aient de quoi montrer
for ($k = 0; $k -lt 25; $k++) {
  $c = & $pick $catalog; $id++
  $price = [math]::Round($c.p[0] + $rnd.NextDouble() * ($c.p[1] - $c.p[0]), 0)
  $items.Add([ordered]@{ id = "$id"; t = "$($c.t) $($rnd.Next(1,999))"; u = "/items/$id"; f = 20 + $rnd.Next(0, 60); p = $price; tp = [math]::Round($price * 1.07 + 0.7, 2)
    o = [string](50000000 + $rnd.Next(0, 800000000)); biz = $false; pr = $false; th = (Placeholder $rnd.Next(0,360) 'IMG'); pk = "demo$id"; b = $c.b; st = (& $pick $states); sz = ''; d = $false; bd = ''; ex = ''; sc = 0.9 })
}

$dir = Split-Path $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
[IO.File]::WriteAllText($Out, ($items | ConvertTo-Json -Depth 4 -Compress), (New-Object Text.UTF8Encoding($false)))
"{0} annonces synthétiques -> {1}" -f $items.Count, (Resolve-Path $Out)
