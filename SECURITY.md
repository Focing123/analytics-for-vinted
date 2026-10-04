# Sécurité / Security

## Signaler une vulnérabilité

Merci de **ne pas ouvrir d'issue publique**. Utilise le signalement privé de GitHub
(onglet *Security* → *Report a vulnerability*) en décrivant le problème et comment le reproduire.

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting.

## Modèle de menace

L'extension s'exécute sur `https://www.vinted.fr/*` uniquement et ne demande qu'une permission :
`unlimitedStorage` (pour IndexedDB). Elle n'a **aucun serveur**, **aucune télémétrie**, et ne charge **aucun code distant**.

Les données traitées viennent de pages Vinted, donc d'un contenu **non fiable** (titres rédigés par des tiers,
URL, images). Mesures en place :

- **Pas d'injection HTML :** tout texte issu d'une annonce est échappé (`esc()`) avant d'être inséré dans le DOM.
- **Liens et images contraints :** le parseur n'accepte que des chemins `/items/<id>…` et des images en `https`
  hébergées sur un domaine `vinted.net/.com/.fr`. Le reste est remplacé ou ignoré
  (empêche `@evil.com`, `javascript:`, `//evil.com`, faux domaines).
- **Messages internes validés :** le service worker n'accepte que les messages de sa propre extension, vérifie
  les identifiants de session (`^[a-z0-9]{1,16}$`) et d'utilisateur (`^\d{1,20}$`), borne les délais.
- **Aucune collecte sans clic :** rien ne démarre via un paramètre d'URL ou un script de la page.
- **Mode démo désactivé dans l'extension :** `?demo=` ne fonctionne qu'en développement, depuis un serveur local.
- **Pas de `eval`, pas de script inline, CSP Manifest V3 par défaut.**

## Limites connues

- Le widget est injecté dans la page Vinted : le JavaScript de Vinted peut en lire le DOM
  (il ne contient que des compteurs).
- Les données collectées (pseudos, identifiants vendeurs, annonces) sont stockées **en clair dans le navigateur**
  de l'utilisateur. Quiconque a accès à son profil Chrome peut les lire.
