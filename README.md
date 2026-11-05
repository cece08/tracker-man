# 🎯 Tracker Man

Chasse à l'homme GPS en temps réel **100 % Peer-to-Peer (P2P) chiffrée de bout en bout (E2EE)**, construite avec **Angular 21**, **WebRTC / Web Crypto API (`AES-256-GCM` + `ECDSA P-256` + `ECDH P-256`)** et **Leaflet**. Fonctionne **sans aucune base de données ni serveur backend**. Installable sur PC et téléphone (PWA).

## Architecture de Sécurité (Zero-Knowledge & Serverless P2P - Niveau Gouvernemental)

- **Zéro base de données / Zéro serveur de stockage** : aucune coordonnée GPS, aucun cercle et aucune trajectoire n'est enregistré sur un serveur. Tout existe exclusivement en mémoire vive (RAM) volatile sur les appareils des joueurs pendant la partie.
- **Chiffrement de bout en bout (E2EE)** : clé maîtresse dérivée avec haute entropie (128 bits via fragment d'URL/QR Code non envoyé au réseau) via `PBKDF2-HMAC-SHA-256` (250 000 itérations) + `HKDF-SHA-256` avec accord de clés asymétrique `ECDH P-256` garantissant une isolation Zero-Knowledge absolue des rôles (`AES-256-GCM` AEAD 256 bits).
- **Forward Secrecy & Group Rekeying** : rotation dynamique immédiate de la clé secrète des chassés dès qu'un joueur est capturé, avec révocation et purge de sa mémoire RAM.
- **Coffre de clés non extractibles (IndexedDB)** : les paires asymétriques `ECDSA P-256` et `ECDH P-256` sont générées avec `extractable: false` dans la puce `SubtleCrypto`, interdisant toute exfiltration en texte clair ou injection XSS.
- **Authentification & Anti-Spoofing** : chaque joueur signe ses paquets avec sa clé `ECDSA P-256`, et les pairs récepteurs appliquent une validation physique de vélocité ($< 45\text{ m/s}$) éliminant la téléportation GPS.
- **Zero-Knowledge Catch Probe** : vérification directe chiffrée par accord de clés asymétrique `ECDH` sans jamais divulguer de condensat hors-ligne bruteforçable sur le réseau.

## Développement local

```bash
npm install
npm start
```

Puis ouvre <http://localhost:4200>.
