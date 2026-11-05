# 🎯 Tracker Man

Chasse à l'homme GPS en temps réel **100 % Peer-to-Peer (P2P) chiffrée de bout en bout (E2EE)**, construite avec **Angular 21**, **WebRTC / Web Crypto API (`AES-256-GCM` + `ECDSA P-256`)** et **Leaflet**. Fonctionne **sans aucune base de données ni serveur backend**. Installable sur PC et téléphone (PWA).

## Architecture de Sécurité (Zero-Knowledge & Serverless P2P)

- **Zéro base de données / Zéro serveur de stockage** : aucune coordonnée GPS, aucun cercle et aucune trajectoire n'est enregistré sur un serveur. Tout existe exclusivement en mémoire vive (RAM) sur les appareils des joueurs pendant la partie.
- **Chiffrement de bout en bout (E2EE)** : dérivation de clés `PBKDF2-HMAC-SHA-256` (210 000 itérations) + `HKDF-SHA-256` avec séparation cryptographique des rôles (`AES-256-GCM` AEAD 256 bits).
- **Authentification asymétrique** : chaque joueur signe ses paquets avec une clé privée `ECDSA P-256` non extractible (anti-usurpation d'identité et d'hôte).
- **Engagements cryptographiques (Zero-Knowledge Catch Code)** : les codes chasseurs à 4 chiffres sont vérifiés par engagement `PBKDF2-SHA-256` sans jamais transiter en clair sur le réseau.

## Développement local

```bash
npm install
npm start
```

Puis ouvre <http://localhost:4200>.
